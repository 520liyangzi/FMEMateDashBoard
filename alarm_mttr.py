"""Alarm MTTR ledger. A row is an occurrence, never an alarm ID or a Job ID.

The maximum observed multiplicity of identical rows makes repeated/overlapping
exports idempotent while preserving repetitions within a single export. With
no unique event key, identical events in disjoint files cannot be distinguished.
"""
from contextlib import contextmanager, closing
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import csv
import hashlib
import json
import math
from pathlib import PurePosixPath
import re
import sqlite3
import tempfile
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile
from mttr_import import (MttrImportError, MAX_ROWS, column_index, csv_rows, excel_time,
                         normalized, source_size, xlsx_rows)

ALARM_TABLES = {'alarm_mttr_rows', 'alarm_mttr_allowlist', 'alarm_mttr_last_import'}
ALARM_SCHEMA = '''
CREATE TABLE IF NOT EXISTS alarm_mttr_rows (
    signature TEXT PRIMARY KEY, alarm_id TEXT NOT NULL, day TEXT NOT NULL,
    seconds REAL NOT NULL CHECK(seconds>0), copies INTEGER NOT NULL CHECK(copies>0)
);
CREATE INDEX IF NOT EXISTS alarm_mttr_by_id_day ON alarm_mttr_rows(alarm_id, day);
CREATE TABLE IF NOT EXISTS alarm_mttr_allowlist (alarm_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS alarm_mttr_last_import (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
'''
MAX_IDS = 10000
MAX_SECONDS = 86400 * 3652500  # generous upper bound; keeps sums finite
QUALITY = ('sourceRows', 'missingJobIds', 'missingAlarmIds', 'invalidDates',
           'zeroDurations', 'invalidDurations', 'validRows', 'matchedRows',
           'addedRows', 'duplicateRows')
FIELDS = {'filename','sheetName','importedAt','dateColumn','durationUnit',*QUALITY}


def init_schema(db):
    db.executescript(ALARM_SCHEMA)


def _id(value):
    value=str(value).strip()
    # Excel may serialize an integral number with a decimal part.
    return re.sub(r'^([0-9]+)\.0+$', r'\1', value)


def _valid_id(value):
    return isinstance(value,str) and 0 < len(value) <= 256 and not re.search(r'[,，\x00-\x1f]',value) and value == _id(value)


def normalize_allowlist(text):
    if isinstance(text,str) and len(text)<=65536:
        parts=re.split('[,，]',text)
    elif isinstance(text,list) and len(text)<=MAX_IDS and all(isinstance(v,str) for v in text):
        parts=text
    else:
        raise MttrImportError('请输入逗号分隔的告警 ID / Enter comma-separated alarm IDs (max 10,000).')
    ids=list(dict.fromkeys(_id(v) for v in parts if v.strip()))
    if len(ids)>MAX_IDS or any(not _valid_id(v) for v in ids):
        raise MttrImportError('告警白名单含无效 ID / The alarm allowlist contains an invalid ID.')
    return ids


def _replace_ids(db, text):
    ids=normalize_allowlist(text)
    db.execute('DELETE FROM alarm_mttr_allowlist')
    db.executemany('INSERT INTO alarm_mttr_allowlist VALUES(?)',((x,) for x in ids))


def set_allowlist(db,allowlist):
    _replace_ids(db,allowlist)
    return get_dataset(db)


def get_dataset(db):
    ids=[r[0] for r in db.execute('SELECT alarm_id FROM alarm_mttr_allowlist ORDER BY rowid')]
    days=[dict(date=r[0],count=r[1],totalSeconds=r[2]) for r in db.execute(
        '''SELECT day,sum(copies),sum(seconds*copies) FROM alarm_mttr_rows
           JOIN alarm_mttr_allowlist USING(alarm_id) GROUP BY day ORDER BY day''')]
    last=db.execute('SELECT data FROM alarm_mttr_last_import WHERE id=1').fetchone()
    return dict(formatVersion=4,source='alarms',allowlist=ids,days=days,
                totalAlarms=sum(d['count'] for d in days),
                storedRows=db.execute('SELECT coalesce(sum(copies),0) FROM alarm_mttr_rows').fetchone()[0],
                earliestDate=days[0]['date'] if days else None,latestDate=days[-1]['date'] if days else None,
                lastImport=json.loads(last[0]) if last else None)


def clear_alarm(db):
    db.execute('DELETE FROM alarm_mttr_rows')
    db.execute('DELETE FROM alarm_mttr_last_import')
    return get_dataset(db)


def _duration(value,numeric):
    s=str(value).strip()
    clock=re.fullmatch(r'([0-9]{1,9}):([0-5][0-9]):([0-5][0-9])(?:\.([0-9]{1,6}))?',s)
    if clock:
        h,m,ss=map(int,clock.groups()[:3])
        seconds=h*3600+m*60+ss+int((clock[4] or '').ljust(6,'0'))/1000000
    elif len(s)<=50 and re.fullmatch(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?',s):
        days=float(s)
        # Text "0" is also commonplace for alarms that have not cleared.
        if days==0:return 0
        if not numeric or not math.isfinite(days) or not 0<days<=MAX_SECONDS/86400:
            return None
        seconds=round(days*86400,6)
    else:
        return None
    return seconds if 0<=seconds<=MAX_SECONDS else None


def _occurrence(value,date1904):
    v=normalized(value)
    if re.fullmatch(r'[0-9]{4}[/-][0-9]{1,2}[/-][0-9]{1,2}',v):
        v+=' 00:00:00'
    if len(v)>50:return None
    if re.fullmatch(r'[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?',v):
        # Excel's serial integer defines the displayed calendar day. Never round
        # the entire timestamp to a second: 23:59:59.750 still belongs to today.
        try:
            serial=Decimal(v)
        except InvalidOperation:
            return None
        if not 0<=serial<3000000 or (not date1904 and 60<=serial<61):
            return None
        whole=int(serial)
        base=datetime(1904,1,1) if date1904 else datetime(1899,12,30 if whole>=61 else 31)
        micros=min(86399999999,int(((serial-whole)*86400000000).to_integral_value(rounding=ROUND_HALF_UP)))
        try:
            dt=base+timedelta(days=whole,microseconds=micros)
        except OverflowError:
            return None
        return dt if dt.year>=1900 else None
    dt=excel_time(v,date1904)
    if dt is not None and dt.year>=1900:
        return dt
    return None


@contextmanager
def _rows(content,filename):
    name=str(filename or '').replace('\\','/').rsplit('/',1)[-1][:255]
    ext=PurePosixPath(name).suffix.lower()
    if ext not in ('.xlsx','.csv') or not source_size(content):
        raise MttrImportError('请上传有效告警 .xlsx 或 UTF-8 .csv 文件 / Upload a nonempty alarm .xlsx or UTF-8 .csv export.')
    iterator=xlsx_rows(content,numeric_marker_column='I') if ext=='.xlsx' else csv_rows(content)
    with closing(iterator):
        try:
            yield name,next(iterator),iterator
        except MttrImportError:
            raise
        except (ParseError,BadZipFile,RuntimeError,csv.Error,ValueError,OverflowError,KeyError,OSError) as exc:
            raise MttrImportError('告警文件损坏或格式不支持 / Invalid or unsupported alarm export. Existing data unchanged.') from exc


def preview(content,filename):
    with _rows(content,filename) as (_,meta,rows):
        row=next(rows,{})
        headers=row if row.get('_row')==1 else {}
        return {'sheetName':meta['sheetName'],'availableColumns':[
            {'column':c,'header':str(headers[c])[:200],'samples':[]}
            for c in sorted((c for c in headers if not c.startswith('_')),key=column_index)]}


def _signature(row,alarm,seconds,dt,job):
    extra=sorted((k,str(v)) for k,v in row.items() if k not in ('B','I','K','AE') and not k.startswith('_') and v!='')
    identity=[alarm,seconds,dt.isoformat(),job,extra]
    return hashlib.sha256(json.dumps(identity,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


@contextmanager
def stage_import(content,filename,date_column='K',duration_unit='hh:mm:ss'):
    if date_column!='K' or duration_unit!='hh:mm:ss':
        raise MttrImportError('日期固定为 K 列，时长固定为 I 列时:分:秒 / Use occurrence time K and elapsed duration I (h:mm:ss).')
    with tempfile.TemporaryDirectory(prefix='fmemate-alarm-') as tmp, closing(sqlite3.connect(tmp+'/alarm.db')) as staged:
        staged.execute('CREATE TABLE r (signature TEXT PRIMARY KEY, alarm TEXT, day TEXT, seconds REAL, copies INTEGER)')
        with _rows(content,filename) as (name,meta,rows):
            stats=dict.fromkeys(QUALITY,0)
            stats.update(filename=name,sheetName=meta['sheetName'],dateColumn='K',durationUnit='hh:mm:ss',
                         importedAt=datetime.now(timezone.utc).isoformat())
            for row in rows:
                if row['_row']==1:continue
                stats['sourceRows']+=1
                job=str(row.get('AE','')).strip()
                if not job:stats['missingJobIds']+=1;continue
                alarm=_id(row.get('B',''))
                if not _valid_id(alarm):stats['missingAlarmIds']+=1;continue
                seconds=_duration(row.get('I',''),row.get('_numericCell',False))
                if seconds is None:stats['invalidDurations']+=1;continue
                if seconds==0:stats['zeroDurations']+=1;continue
                dt=_occurrence(row.get('K',''),meta['date1904'])
                if dt is None:stats['invalidDates']+=1;continue
                stats['validRows']+=1
                # Float canonicalization makes Excel day fractions and equivalent
                # clock strings hash identically, down to microsecond precision.
                sig=_signature(row,alarm,float(seconds),dt,job)
                staged.execute('INSERT INTO r VALUES(?,?,?,?,1) ON CONFLICT(signature) DO UPDATE SET copies=copies+1',
                               (sig,alarm,dt.date().isoformat(),seconds))
        if not stats['validRows']:
            raise MttrImportError(
                f"没有可导入告警 / No eligible alarm rows (rows {stats['sourceRows']}; empty Job IDs {stats['missingJobIds']}; "
                f"missing/invalid alarm IDs {stats['missingAlarmIds']}; zero durations {stats['zeroDurations']}; "
                f"invalid durations {stats['invalidDurations']}; invalid occurrence dates {stats['invalidDates']}). Existing data unchanged.",
                {'source':'alarms','lastImport':stats})
        yield stats,staged


def merge_import(db,staged,allowlist=None):
    stats,incoming=staged
    stats=stats.copy()
    if allowlist is not None:_replace_ids(db,allowlist)
    ids={r[0] for r in db.execute('SELECT alarm_id FROM alarm_mttr_allowlist')}
    stats['matchedRows']=sum(n for alarm,n in incoming.execute('SELECT alarm,sum(copies) FROM r GROUP BY alarm') if alarm in ids)
    before=db.execute('SELECT coalesce(sum(copies),0) FROM alarm_mttr_rows').fetchone()[0]
    db.executemany('''INSERT INTO alarm_mttr_rows VALUES(?,?,?,?,?) ON CONFLICT(signature)
                   DO UPDATE SET copies=excluded.copies WHERE excluded.copies>alarm_mttr_rows.copies''',
                   incoming.execute('SELECT signature,alarm,day,seconds,copies FROM r'))
    after=db.execute('SELECT sum(copies) FROM alarm_mttr_rows').fetchone()[0]
    stats['addedRows']=after-before
    stats['duplicateRows']=stats['validRows']-stats['addedRows']
    db.execute('INSERT OR REPLACE INTO alarm_mttr_last_import VALUES (1,?)',(json.dumps(stats,ensure_ascii=False),))
    return get_dataset(db)


def restore_tables(source,dest,tables):
    present=ALARM_TABLES.intersection(tables)
    if not present:return
    def invalid():
        raise MttrImportError('备份告警 MTTR 数据无效 / Invalid alarm MTTR backup.')
    if present!=ALARM_TABLES:invalid()
    expected={'alarm_mttr_rows':{'signature','alarm_id','day','seconds','copies'},
              'alarm_mttr_allowlist':{'alarm_id'},'alarm_mttr_last_import':{'id','data'}}
    for table,cols in expected.items():
        if {r[1] for r in source.execute('PRAGMA table_info('+table+')')}!=cols:invalid()
    ids=[r[0] for r in source.execute('SELECT alarm_id FROM alarm_mttr_allowlist ORDER BY rowid LIMIT ?', (MAX_IDS+1,))]
    if len(ids)>MAX_IDS or any(not _valid_id(x) for x in ids) or len(set(ids))!=len(ids):invalid()
    _replace_ids(dest,ids)
    stored=0
    for sig,alarm,day,seconds,copies in source.execute('SELECT signature,alarm_id,day,seconds,copies FROM alarm_mttr_rows'):
        if not isinstance(sig,str) or not re.fullmatch('[0-9a-f]{64}',sig) or not _valid_id(alarm):invalid()
        if not isinstance(day,str) or len(day)!=10 or not _occurrence(day,False) or date.fromisoformat(day).isoformat()!=day:invalid()
        if type(seconds) not in (float,int) or not 0<seconds<=MAX_SECONDS or type(copies)!=int or not 1<=copies<=MAX_ROWS:invalid()
        dest.execute('INSERT INTO alarm_mttr_rows VALUES(?,?,?,?,?)',(sig,alarm,day,seconds,copies));stored+=copies
    last=list(source.execute('SELECT id,data FROM alarm_mttr_last_import LIMIT 2'))
    if not last:
        if stored:invalid()
        return
    if len(last)!=1 or last[0][0]!=1 or not isinstance(last[0][1],str) or len(last[0][1])>8000:invalid()
    try:
        s=json.loads(last[0][1])
        if not isinstance(s,dict) or set(s)!=FIELDS or s['dateColumn']!='K' or s['durationUnit']!='hh:mm:ss':invalid()
        if any(not isinstance(s[k],str) or not 0<len(s[k])<=v for k,v in [('filename',255),('sheetName',200),('importedAt',64)]):invalid()
        datetime.fromisoformat(s['importedAt'])
        if any(type(s[k])!=int or not 0<=s[k]<=MAX_ROWS for k in QUALITY):invalid()
        if s['validRows']!=s['addedRows']+s['duplicateRows'] or not 0<s['validRows']<=stored or s['matchedRows']>s['validRows']:invalid()
        if s['sourceRows']!=sum(s[k] for k in ('missingJobIds','missingAlarmIds','invalidDates','zeroDurations','invalidDurations','validRows')):invalid()
    except (TypeError,ValueError,KeyError):
        invalid()
    dest.execute('INSERT INTO alarm_mttr_last_import VALUES(1,?)',(json.dumps(s,ensure_ascii=False),))
