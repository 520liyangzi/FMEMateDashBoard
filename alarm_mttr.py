"""Work-order MTTR based on the maximum eligible alarm duration per Job ID.

Only Jobs with an eligible alarm and a named C -> AL person enter the report.
Unmatched Jobs stay in the alarm ledger for later mapping. A Job belongs to the
occurrence date of its longest eligible alarm (earliest such date in a tie).

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
import unicodedata
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile
from mttr_import import (MttrImportError, MAX_ROWS, column_index, csv_rows, excel_time,
                         normalized, source_size, xlsx_rows)

V4_TABLES = {'alarm_mttr_rows', 'alarm_mttr_allowlist', 'alarm_mttr_last_import'}
JOB_TABLES = {'alarm_mttr_job_links','alarm_mttr_job_owners','alarm_mttr_job_import'}
# The two cache tables can always be rebuilt from the validated ledger; old
# backups do not need them and restored backups never supply their values.
CACHE_TABLES = {'alarm_mttr_job_max','alarm_mttr_revision'}
AL_TABLES = {'alarm_mttr_job_al','alarm_mttr_al_people','alarm_mttr_al_policy','alarm_mttr_al_names'}
ALARM_TABLES = V4_TABLES | JOB_TABLES | CACHE_TABLES | AL_TABLES
_WRITE_MAX = """
INSERT OR REPLACE INTO alarm_mttr_job_max(job_id,day,seconds,alarm_count,alarm_id)
SELECT job_id,day,seconds,alarm_count,alarm_id FROM (
    SELECT l.job_id,r.day,r.seconds,r.alarm_id,
           sum(r.copies) OVER (PARTITION BY l.job_id) AS alarm_count,
           row_number() OVER (PARTITION BY l.job_id ORDER BY r.seconds DESC,r.day ASC,r.signature) AS position
    FROM alarm_mttr_rows r JOIN alarm_mttr_allowlist a USING(alarm_id)
    JOIN alarm_mttr_job_links l USING(signature) {guard}
) WHERE position=1"""
_NEW_REVISION = "INSERT OR REPLACE INTO alarm_mttr_revision VALUES(1,lower(hex(randomblob(16))))"
ALARM_SCHEMA = '''
CREATE TABLE IF NOT EXISTS alarm_mttr_rows (
    signature TEXT PRIMARY KEY, alarm_id TEXT NOT NULL, day TEXT NOT NULL,
    seconds REAL NOT NULL CHECK(seconds>0), copies INTEGER NOT NULL CHECK(copies>0)
);
CREATE INDEX IF NOT EXISTS alarm_mttr_by_id_day ON alarm_mttr_rows(alarm_id, day);
CREATE TABLE IF NOT EXISTS alarm_mttr_allowlist (alarm_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS alarm_mttr_last_import (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
-- V4 hashes cannot be decoded. Link each old fingerprint only when that source row is imported again.
CREATE TABLE IF NOT EXISTS alarm_mttr_job_links (signature TEXT PRIMARY KEY, job_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS alarm_mttr_job_link_idx ON alarm_mttr_job_links(job_id);
CREATE TABLE IF NOT EXISTS alarm_mttr_job_owners (job_id TEXT PRIMARY KEY,assignee TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alarm_mttr_job_import (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
-- Keep previous AG mappings intact; they do not identify who appears in AL.
CREATE TABLE IF NOT EXISTS alarm_mttr_job_al (job_id TEXT PRIMARY KEY,person_key TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alarm_mttr_al_people (person_key TEXT PRIMARY KEY,assignee TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alarm_mttr_al_policy (id INTEGER PRIMARY KEY CHECK(id=1),mode TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alarm_mttr_al_names (person_key TEXT PRIMARY KEY,name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alarm_mttr_job_max (
    job_id TEXT PRIMARY KEY, day TEXT NOT NULL, seconds REAL NOT NULL,
    alarm_count INTEGER NOT NULL, alarm_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS alarm_mttr_max_by_day ON alarm_mttr_job_max(day DESC,job_id);
CREATE TABLE IF NOT EXISTS alarm_mttr_revision (id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL);
''' + _WRITE_MAX.format(guard='WHERE NOT EXISTS (SELECT 1 FROM alarm_mttr_revision)') + ''';
INSERT OR IGNORE INTO alarm_mttr_revision VALUES(1,lower(hex(randomblob(16))));
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
    _refresh_max(db)
    return get_dataset(db)


def _refresh_max(db):
    # Materialize once per ledger/allowlist change: totals, person summaries
    # and individual pages must all read the very same global winners.
    db.execute('DELETE FROM alarm_mttr_job_max')
    db.execute(_WRITE_MAX.format(guard=''))
    db.execute(_NEW_REVISION)


def _display_name(value):
    return ' '.join(unicodedata.normalize('NFKC',value).split()) if isinstance(value,str) else ''


def _policy_names(values):
    if not isinstance(values,list) or len(values)>MAX_IDS:
        raise MttrImportError('名单最多可配置 10,000 人 / Provide up to 10,000 AL names.')
    names={}
    for value in values:
        if not isinstance(value,str) or len(value)>512:
            raise MttrImportError('AL 姓名无效 / Invalid AL name (max 512 characters).')
        name=_display_name(value)
        if name and not _valid_value(name):
            raise MttrImportError('AL 姓名无效 / Invalid AL name.')
        if name:names.setdefault(name.casefold(),name)
    return names


def get_al_policy(db):
    mode=db.execute('SELECT mode FROM alarm_mttr_al_policy WHERE id=1').fetchone()
    return dict(mode=mode[0] if mode else 'all',
                names=[r[0] for r in db.execute('SELECT name FROM alarm_mttr_al_names ORDER BY rowid')])


def set_al_policy(db,policy):
    if not isinstance(policy,dict) or set(policy)!={'mode','names'} or policy['mode'] not in ('all','include','exclude'):
        raise MttrImportError('AL 筛选设置无效 / Invalid AL filter; use all, include, or exclude.')
    names=_policy_names(policy['names'])
    if policy['mode']!='all' and not names:
        raise MttrImportError('启用 AL 名单时至少填写一人 / Include and exclude require at least one name.')
    db.execute('INSERT OR REPLACE INTO alarm_mttr_al_policy VALUES(1,?)',(policy['mode'],))
    db.execute('DELETE FROM alarm_mttr_al_names')
    db.executemany('INSERT INTO alarm_mttr_al_names VALUES(?,?)',names.items())
    db.execute(_NEW_REVISION)
    return get_dataset(db)


_NAMED_COHORT = """ FROM alarm_mttr_job_max m JOIN alarm_mttr_job_al j ON m.job_id=j.job_id
                     JOIN alarm_mttr_al_people o ON o.person_key=j.person_key"""


def _report_cohort(mode):
    if mode=='include':return _NAMED_COHORT+' JOIN alarm_mttr_al_names n ON n.person_key=j.person_key'
    if mode=='exclude':return _NAMED_COHORT+' AND NOT EXISTS (SELECT 1 FROM alarm_mttr_al_names n WHERE n.person_key=j.person_key)'
    return _NAMED_COHORT


def get_dataset(db):
    ids=[r[0] for r in db.execute('SELECT alarm_id FROM alarm_mttr_allowlist ORDER BY rowid')]
    policy=get_al_policy(db)
    winners = db.execute(f"""
        SELECT m.day,o.assignee,count(*),sum(m.seconds),sum(m.alarm_count) {_report_cohort(policy['mode'])}
        GROUP BY m.day,o.assignee ORDER BY m.day,o.assignee
    """)
    days_by_date,persons={},[]
    alarms=jobs=0
    people=set()
    for day,person,n,seconds,k in winners:
        d=days_by_date.setdefault(day,dict(date=day,count=0,totalSeconds=0))
        d['count']+=n;d['totalSeconds']+=seconds
        persons.append(dict(date=day,assignee=person,count=n,totalSeconds=seconds))
        jobs+=n;alarms+=k
        people.add(person)
    days=list(days_by_date.values())
    stored,unlinked=db.execute("""SELECT coalesce(sum(copies),0),
          coalesce(sum(CASE WHEN l.signature IS NULL THEN copies ELSE 0 END),0)
          FROM alarm_mttr_rows r LEFT JOIN alarm_mttr_job_links l USING(signature)""").fetchone()
    last=db.execute('SELECT data FROM alarm_mttr_last_import WHERE id=1').fetchone()
    mapping=db.execute('SELECT data FROM alarm_mttr_job_import WHERE id=1').fetchone()
    matched=jobs if policy['mode']=='all' else db.execute('SELECT count(*)'+_NAMED_COHORT).fetchone()[0]
    unassigned=db.execute('SELECT count(*) FROM alarm_mttr_job_max').fetchone()[0]-matched
    return dict(formatVersion=5,source='alarm-jobs',allowlist=ids,days=days,personDays=persons,assignees=sorted(people),
                alPolicy=policy,alDiagnostics=dict(missingALJobs=unassigned,filteredOutJobs=matched-jobs),
                revision=db.execute('SELECT token FROM alarm_mttr_revision WHERE id=1').fetchone()[0],
                totalAlarms=alarms,totalJobs=jobs,storedRows=stored,unassignedJobs=unassigned,
                mappedJobs=db.execute('SELECT count(*) FROM alarm_mttr_job_al').fetchone()[0],
                legacyUnlinkedRows=unlinked,needsAlarmReimport=bool(unlinked),
                earliestDate=days[0]['date'] if days else None,latestDate=days[-1]['date'] if days else None,
                lastImport=json.loads(last[0]) if last else None,lastJobImport=json.loads(mapping[0]) if mapping else None)


def clear_alarm(db):
    for table in ('alarm_mttr_job_links','alarm_mttr_rows','alarm_mttr_last_import',
                  'alarm_mttr_job_owners','alarm_mttr_job_import','alarm_mttr_job_al','alarm_mttr_al_people'):
        db.execute('DELETE FROM '+table)
    _refresh_max(db)
    return get_dataset(db)


def _job_key(value):
    # Treat numeric Excel IDs (including integral decimal representations) and
    # equivalent text IDs alike. Preserve text case and leading zeroes.
    return _id(value)


def _valid_value(v):
    return isinstance(v,str) and 0<len(v)<=512 and v==v.strip() and not re.search(r'[\x00-\x1f\ud800-\udfff]',v)


def list_job_proxy_details(db,date_from=None,date_to=None,assignees=None,offset=0,limit=100):
    """Read a page of the Jobs included in the mean and totals over the full selection.

    A missing assignee filter includes all matched Jobs; [] or [''] includes
    none. The one global winning alarm per Job is determined before applying
    either inclusive date bound.
    """
    for bound in (date_from,date_to):
        if bound is None:continue
        try:
            if not isinstance(bound,str) or date.fromisoformat(bound).isoformat()!=bound:
                raise ValueError()
        except ValueError:
            raise MttrImportError('日期无效 / Invalid date; use YYYY-MM-DD.') from None
    if date_from and date_to and date_from>date_to:
        raise MttrImportError('开始日期不能晚于结束日期 / Start date must not follow end date.')
    if type(offset)!=int or not 0<=offset<=2**63-1 or type(limit)!=int or not 1<=limit<=5000:
        raise MttrImportError('分页参数无效 / Invalid offset or limit (1–5,000).')
    if assignees is not None and (not isinstance(assignees,list) or len(assignees)>MAX_IDS
                                  or any(v!='' and not _valid_value(v) for v in assignees)):
        raise MttrImportError('处理人筛选无效 / Invalid assignee selection (max 10,000).')

    clauses=[]
    args=dict(skip=offset,take=limit)
    if date_from:
        clauses.append('m.day>=:since');args['since']=date_from
    if date_to:
        clauses.append('m.day<=:until');args['until']=date_to
    people=None if assignees is None else list(dict.fromkeys(_display_name(n).casefold() for n in assignees))
    large_scope=people is not None and len(people)>300
    if large_scope:
        # Older SQLite builds have a 999-bind limit. The temporary lookup also
        # keeps the same query plan for large scopes, without relying on JSON1.
        clauses.append("j.person_key IN (SELECT name FROM temp.alarm_mttr_detail_scope)")
    elif people:
        keys=['p'+str(i) for i in range(len(people))]
        clauses.append("j.person_key IN ("+','.join(':'+key for key in keys)+')')
        args.update(zip(keys,people))
    elif people==[]:
        clauses.append('0')
    mode=db.execute('SELECT mode FROM alarm_mttr_al_policy WHERE id=1').fetchone()
    source=_report_cohort(mode[0] if mode else 'all')
    if clauses:source+=' WHERE '+' AND '.join(clauses)
    # Totals and page use one read snapshot. The page can use (day DESC,job_id)
    # directly; an empty or out-of-range page still returns its full totals.
    query=f"""
        WITH totals AS (SELECT count(*) n,coalesce(sum(m.seconds),0) seconds {source}),
        page AS (SELECT m.job_id,m.day,m.seconds,m.alarm_count,m.alarm_id,o.assignee
                 {source} ORDER BY m.day DESC,m.job_id ASC LIMIT :take OFFSET :skip)
        SELECT t.n,t.seconds,v.token,p.job_id,p.assignee,p.day,p.seconds,p.alarm_count,p.alarm_id
        FROM totals t JOIN alarm_mttr_revision v ON v.id=1 LEFT JOIN page p ON 1=1
        ORDER BY p.day DESC,p.job_id ASC"""
    if large_scope:
        db.execute('CREATE TEMP TABLE alarm_mttr_detail_scope(name TEXT PRIMARY KEY) WITHOUT ROWID')
    try:
        if large_scope:
            db.executemany('INSERT INTO temp.alarm_mttr_detail_scope VALUES(?)',((p,) for p in people))
        records=db.execute(query,args).fetchall()
    finally:
        if large_scope:db.execute('DROP TABLE temp.alarm_mttr_detail_scope')
    rows=[dict(jobId=r[3],assignee=r[4],alPerson=r[4],date=r[5],seconds=r[6],alarmCount=r[7],alarmId=r[8])
          for r in records if r[3] is not None]
    return dict(rows=rows,total=records[0][0],totalSeconds=records[0][1],revision=records[0][2],
                offset=offset,limit=limit)


JOB_QUALITY=('sourceRows','missingJobIds','missingAssignees','validRows','duplicateRows','mappedJobs')


@contextmanager
def stage_job_import(content,filename):
    """Validate the entire mapping before changing the existing catalogue."""
    with tempfile.TemporaryDirectory(prefix='fmemate-job-owner-') as tmp, closing(sqlite3.connect(tmp+'/owners.db')) as staged:
        staged.execute('CREATE TABLE owners(job_id TEXT PRIMARY KEY,person_key TEXT NOT NULL,assignee TEXT NOT NULL)')
        with _rows(content,filename) as (name,meta,rows):
            stats=dict.fromkeys(JOB_QUALITY,0)
            stats.update(filename=name,sheetName=meta['sheetName'],importedAt=datetime.now(timezone.utc).isoformat(),personColumn='AL')
            for row in rows:
                if row['_row']==1:continue
                stats['sourceRows']+=1
                job=_job_key(row.get('C',''))
                if not _valid_value(job):stats['missingJobIds']+=1;continue
                person=_display_name(row.get('AL',''))
                if not _valid_value(person):stats['missingAssignees']+=1;continue
                key=person.casefold()
                stats['validRows']+=1
                cur=staged.execute('INSERT OR IGNORE INTO owners VALUES(?,?,?)',(job,key,person))
                if cur.rowcount:
                    stats['mappedJobs']+=1
                else:
                    prev=staged.execute('SELECT person_key FROM owners WHERE job_id=?',(job,)).fetchone()[0]
                    if prev!=key:
                        raise MttrImportError(f'工单 {job} 在同一份表中有多个 AL 人员，请核对后导入。 / Conflicting AL names for Job {job}; mapping unchanged.')
                    stats['duplicateRows']+=1
        if not stats['mappedJobs']:
            raise MttrImportError('没有可关联的工单，请检查 C 列 Job ID 和 AL 列人员（AG 不参与）。 / No rows with a Job ID in C and a name in AL. Mapping unchanged.',{'source':'job-owners','lastJobImport':stats})
        yield stats,staged


def merge_job_import(db,staged):
    stats,incoming=staged
    db.executemany('INSERT OR IGNORE INTO alarm_mttr_al_people VALUES(?,?)',
                   incoming.execute('SELECT person_key,assignee FROM owners ORDER BY rowid'))
    db.executemany("""INSERT INTO alarm_mttr_job_al VALUES(?,?)
            ON CONFLICT(job_id) DO UPDATE SET person_key=excluded.person_key
            WHERE alarm_mttr_job_al.person_key<>excluded.person_key""",
            incoming.execute('SELECT job_id,person_key FROM owners'))
    db.execute('INSERT OR REPLACE INTO alarm_mttr_job_import VALUES(1,?)',(json.dumps(stats,ensure_ascii=False),))
    db.execute(_NEW_REVISION)
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
        raise MttrImportError('请上传非空的 .xlsx 或 UTF-8 .csv 文件 / Upload a nonempty .xlsx or UTF-8 .csv export.')
    iterator=xlsx_rows(content,numeric_marker_column='I') if ext=='.xlsx' else csv_rows(content)
    with closing(iterator):
        try:
            yield name,next(iterator),iterator
        except MttrImportError:
            raise
        except (ParseError,BadZipFile,RuntimeError,csv.Error,ValueError,OverflowError,KeyError,OSError) as exc:
            raise MttrImportError('文件损坏或格式不支持 / Invalid or unsupported export. Existing data unchanged.') from exc


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
        staged.execute('CREATE TABLE r (signature TEXT PRIMARY KEY, alarm TEXT, day TEXT, seconds REAL, copies INTEGER, job_id TEXT)')
        with _rows(content,filename) as (name,meta,rows):
            stats=dict.fromkeys(QUALITY,0)
            stats.update(filename=name,sheetName=meta['sheetName'],dateColumn='K',durationUnit='hh:mm:ss',
                         importedAt=datetime.now(timezone.utc).isoformat())
            for row in rows:
                if row['_row']==1:continue
                stats['sourceRows']+=1
                job=str(row.get('AE','')).strip()
                if not _valid_value(_job_key(job)):stats['missingJobIds']+=1;continue
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
                staged.execute('INSERT INTO r VALUES(?,?,?,?,1,?) ON CONFLICT(signature) DO UPDATE SET copies=copies+1',
                               (sig,alarm,dt.date().isoformat(),seconds,_job_key(job)))
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
    db.executemany('INSERT OR IGNORE INTO alarm_mttr_job_links VALUES(?,?)',
                   incoming.execute('SELECT signature,job_id FROM r'))
    after=db.execute('SELECT sum(copies) FROM alarm_mttr_rows').fetchone()[0]
    stats['addedRows']=after-before
    stats['duplicateRows']=stats['validRows']-stats['addedRows']
    db.execute('INSERT OR REPLACE INTO alarm_mttr_last_import VALUES (1,?)',(json.dumps(stats,ensure_ascii=False),))
    _refresh_max(db)
    return get_dataset(db)


def restore_tables(source,dest,tables):
    present=(V4_TABLES | JOB_TABLES | AL_TABLES).intersection(tables)
    if not present:return
    def invalid():
        raise MttrImportError('备份告警 MTTR 数据无效 / Invalid alarm MTTR backup.')
    if present not in (V4_TABLES, V4_TABLES | JOB_TABLES, V4_TABLES | JOB_TABLES | AL_TABLES):invalid()
    expected={'alarm_mttr_rows':{'signature','alarm_id','day','seconds','copies'},
              'alarm_mttr_allowlist':{'alarm_id'},'alarm_mttr_last_import':{'id','data'}}
    if JOB_TABLES<=present:
        expected.update(alarm_mttr_job_links={'signature','job_id'},alarm_mttr_job_owners={'job_id','assignee'},
                        alarm_mttr_job_import={'id','data'})
    if AL_TABLES<=present:
        expected.update(alarm_mttr_job_al={'job_id','person_key'},alarm_mttr_al_people={'person_key','assignee'},
                        alarm_mttr_al_policy={'id','mode'},alarm_mttr_al_names={'person_key','name'})
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
    if JOB_TABLES<=present:
        for sig,job,found in source.execute("""SELECT l.signature,l.job_id,r.signature FROM alarm_mttr_job_links l
                                               LEFT JOIN alarm_mttr_rows r ON l.signature=r.signature"""):
            if found is None or not _valid_value(job) or job!=_job_key(job):invalid()
            dest.execute('INSERT INTO alarm_mttr_job_links VALUES(?,?)',(sig,job))
        n=0
        for job,person in source.execute('SELECT job_id,assignee FROM alarm_mttr_job_owners'):
            if not _valid_value(job) or job!=_job_key(job) or not _valid_value(person):invalid()
            dest.execute('INSERT INTO alarm_mttr_job_owners VALUES(?,?)',(job,person));n+=1
        al_count=0
        if AL_TABLES<=present:
            for key,name in source.execute('SELECT person_key,assignee FROM alarm_mttr_al_people'):
                if not _valid_value(name) or _display_name(name)!=name or key!=name.casefold():invalid()
                dest.execute('INSERT INTO alarm_mttr_al_people VALUES(?,?)',(key,name))
            for job,key,found in source.execute("""SELECT j.job_id,j.person_key,p.person_key FROM alarm_mttr_job_al j
                                                   LEFT JOIN alarm_mttr_al_people p ON j.person_key=p.person_key"""):
                if found is None or not _valid_value(job) or _job_key(job)!=job:invalid()
                dest.execute('INSERT INTO alarm_mttr_job_al VALUES(?,?)',(job,key));al_count+=1
            policy=list(source.execute('SELECT id,mode FROM alarm_mttr_al_policy LIMIT 2'))
            names=list(source.execute('SELECT person_key,name FROM alarm_mttr_al_names ORDER BY rowid LIMIT ?', (MAX_IDS+1,)))
            if len(names)>MAX_IDS or len(policy)>1 or (not policy and names):invalid()
            if policy:
                pid,mode=policy[0]
                if pid!=1 or mode not in ('all','include','exclude') or (mode!='all' and not names):invalid()
                dest.execute('INSERT INTO alarm_mttr_al_policy VALUES(1,?)',(mode,))
            for key,name in names:
                if not _valid_value(name) or _display_name(name)!=name or name.casefold()!=key:invalid()
                dest.execute('INSERT INTO alarm_mttr_al_names VALUES(?,?)',(key,name))
        jm=list(source.execute('SELECT id,data FROM alarm_mttr_job_import LIMIT 2'))
        if not jm and (n or al_count):invalid()
        if jm:
            if len(jm)!=1 or jm[0][0]!=1 or not isinstance(jm[0][1],str) or len(jm[0][1])>8000:invalid()
            try:
                q=json.loads(jm[0][1])
                receipt_fields={'filename','sheetName','importedAt',*JOB_QUALITY}
                if not isinstance(q,dict) or set(q) not in (receipt_fields,receipt_fields|{'personColumn'}):invalid()
                if 'personColumn' in q and q['personColumn']!='AL':invalid()
                if any(not isinstance(q[k],str) or not 0<len(q[k])<=v for k,v in [('filename',255),('sheetName',200),('importedAt',64)]):invalid()
                datetime.fromisoformat(q['importedAt'])
                if any(type(q[k])!=int or not 0<=q[k]<=MAX_ROWS for k in JOB_QUALITY):invalid()
                if not 0<q['mappedJobs']<=(al_count if 'personColumn' in q else n) or q['validRows']!=q['mappedJobs']+q['duplicateRows']:invalid()
                if q['sourceRows']!=q['missingJobIds']+q['missingAssignees']+q['validRows']:invalid()
            except (TypeError,ValueError,KeyError):invalid()
            dest.execute('INSERT INTO alarm_mttr_job_import VALUES(1,?)',(json.dumps(q,ensure_ascii=False),))
    last=list(source.execute('SELECT id,data FROM alarm_mttr_last_import LIMIT 2'))
    if not last:
        if stored:invalid()
        _refresh_max(dest)
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
    _refresh_max(dest)
