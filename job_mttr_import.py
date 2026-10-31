"""TT catalogue + Job MTTR imports. Both sources are staged before live writes."""
from __future__ import annotations
from contextlib import contextmanager, closing
from datetime import datetime, timezone
from itertools import chain
import json
import math
from pathlib import PurePosixPath
import re
import sqlite3
import tempfile
import xml.etree.ElementTree as ET
import zipfile
import csv
from mttr_import import (xlsx_rows,csv_rows,excel_time,normalized,category,header_key,column_index,
                         HEADER_ALIASES,MttrImportError,MAX_ROWS)

TT_ROLES=('ttId','category')
JOB_ROLES=('jobId','ttId','created','finished','assignee','status')
ALIASES={
 'tt':{'ttId':HEADER_ALIASES['B'],'category':HEADER_ALIASES['U']},
 'job':{'jobId':{'jb_id','job_id','jobid','jb_number','job_number'},'ttId':HEADER_ALIASES['B'],
        'created':{'jb_create_date','jb_created_date','jb_create_time','jb_created_time','job_create_date','job_created_date','job_created_at','created_time','created_at'},
        'finished':{'jb_finish_date','jb_finished_date','jb_finish_time','jb_finished_time','job_finish_date','job_finished_date','job_finished_at','finished_time','finish_time','finish_date','finished_date'},
        'assignee':{'jb_assign_to','job_assign_to','assigned_to','assignee','job_assignee'},
        'status':{'jb_status','job_status','status'}}}
SCHEMA='''CREATE TABLE tt (ttId TEXT PRIMARY KEY,category TEXT NOT NULL);
CREATE TABLE jobs (jobId TEXT PRIMARY KEY,ttId TEXT NOT NULL,createdAt TEXT NOT NULL,finishedAt TEXT NOT NULL,assignee TEXT NOT NULL,status TEXT NOT NULL,durationSeconds REAL NOT NULL);'''
RADIO="('RADIO-OSP','RADIO-ISP')"

def roles_for(source):return TT_ROLES if source=='tt' else JOB_ROLES

def valid_source_mapping(mapping,source,available=None):
    return (isinstance(mapping,dict) and set(mapping)==set(roles_for(source))
            and all(column_index(v) is not None for v in mapping.values())
            and len(set(mapping.values()))==len(mapping)
            and (available is None or all(v in available for v in mapping.values())))

def source_mapping(rows,source,sheet,mapping):
    first=next(rows,None)
    headers={k:v for k,v in (first or {}).items() if k!='_row'} if first and first['_row']==1 else {}
    preview=[] if not first or first['_row']==1 else [first]
    candidates={role:[col for col,name in headers.items() if header_key(name) in ALIASES[source][role]] for role in roles_for(source)}
    suggested={role:cols[0] for role,cols in candidates.items() if len(cols)==1}
    # Truly blank legacy TT exports can use the two explicitly specified columns.
    # Job ID has no positional default, so a blank Job header requires mapping.
    automatic=suggested if any(normalized(v) for v in headers.values()) else ({'ttId':'B','category':'U'} if source=='tt' else {})
    if mapping is None and valid_source_mapping(automatic,source):
        return automatic,headers,preview
    while len(preview)<20:
        row=next(rows,None)
        if row is None:break
        preview.append(row)
    columns=set(headers)
    for row in preview:columns.update(k for k in row if k!='_row')
    if mapping is not None and valid_source_mapping(mapping,source,columns):
        return dict(mapping),headers,preview
    hidden={'B'} | {col for col,name in headers.items() if header_key(name) in ALIASES[source]['ttId'] or (source=='job' and header_key(name) in ALIASES['job']['jobId'])}
    samples={col:[] for col in columns}
    for row in preview:
        for col in columns-hidden:
            value=normalized(row.get(col,''))[:80]
            if value and value not in samples[col] and len(samples[col])<3:samples[col].append(value)
    if source=='tt' and 'category' not in suggested:
        radio_cols=[col for col,values in samples.items() if any(category(v) in ('RADIO-OSP','RADIO-ISP') for v in values)]
        if len(radio_cols)==1:suggested['category']=radio_cols[0]
    details={'requiresMapping':True,'source':source,'sheetName':sheet,'previewRows':len(preview),
             'availableColumns':[{'column':col,'header':normalized(headers.get(col,''))[:200],'samples':samples[col]} for col in sorted(columns,key=column_index)],'suggestedMapping':suggested}
    raise MttrImportError(f'请确认 {source.upper()} 字段映射 / Confirm {source.upper()} column mapping. Select distinct existing columns; Job durations require jb_create_date and jb_finish_date. 原数据未改变 / Existing data unchanged.',details)

@contextmanager
def source_rows(content,filename):
    name=str(filename or '').replace('\\','/').rsplit('/',1)[-1][:255]
    suffix=PurePosixPath(name).suffix.lower()
    if suffix not in ('.xlsx','.csv') or not content:
        raise MttrImportError('Upload nonempty .xlsx or UTF-8 .csv files for both TT and Job.')
    rows=xlsx_rows(content) if suffix=='.xlsx' else csv_rows(content)
    try:
        metadata=next(rows)
        yield name,metadata,rows
    except MttrImportError:raise
    except (ET.ParseError,zipfile.BadZipFile,RuntimeError,csv.Error,ValueError,OverflowError,KeyError,OSError) as exc:
        raise MttrImportError('The TT or Job export is corrupt or unsupported. Existing data unchanged.') from exc
    finally:rows.close()

def base_source(filename,metadata,stamp):
    return {'filename':filename,'sheetName':metadata['sheetName'],'importedAt':stamp,'sourceRows':0}

def valid_id(value):
    value=str(value).strip()
    return value if 0<len(value)<=1000 else None

@contextmanager
def stage_pair(tt_content,tt_name,job_content,job_name,tt_mapping=None,job_mapping=None):
    stamp=datetime.now(timezone.utc).isoformat()
    with tempfile.TemporaryDirectory(prefix='fmemate-job-mttr-') as tmp:
        path=tmp+'/pair.db'
        db=sqlite3.connect(path)
        try:
            db.executescript(SCHEMA)
            with source_rows(tt_content,tt_name) as (name,meta,rows):
                tt=base_source(name,meta,stamp)
                tt.update(matchedRows=0,uniqueIds=0,duplicates=0,missingIds=0)
                tm,th,preview=source_mapping(rows,'tt',meta['sheetName'],tt_mapping)
                for source in chain(preview,rows):
                    if source['_row']==1:continue
                    tt['sourceRows']+=1
                    tid=valid_id(source.get(tm['ttId'],''))
                    cat=category(source.get(tm['category'],''))
                    if len(cat)>65536:raise MttrImportError('A TT category is too long.')
                    if cat in ('RADIO-OSP','RADIO-ISP'):tt['matchedRows']+=1
                    if tid is None:tt['missingIds']+=1;continue
                    db.execute('INSERT OR IGNORE INTO tt VALUES (?,?)',(tid,cat))
                    if db.execute('SELECT changes()').fetchone()[0]:tt['uniqueIds']+=1
                    else:
                        tt['duplicates']+=1
                        if cat in ('RADIO-OSP','RADIO-ISP'):
                            db.execute(f'UPDATE tt SET category=? WHERE ttId=? AND category NOT IN {RADIO}',(cat,tid))
                if not tt['uniqueIds']:
                    raise MttrImportError('TT表没有有效工单ID / TT has no valid ticket IDs. Data starts at row 2. Existing data unchanged.',{'source':'tt','sources':{'tt':tt}})
            with source_rows(job_content,job_name) as (name,meta,rows):
                job=base_source(name,meta,stamp)
                job.update(statusMatches=0,validRows=0,invalidDates=0,negativeDurations=0,missingIds=0,duplicates=0,addedRows=0,unmatchedTt=0,missingAssignee=0)
                jm,jh,preview=source_mapping(rows,'job',meta['sheetName'],job_mapping)
                for source in chain(preview,rows):
                    if source['_row']==1:continue
                    job['sourceRows']+=1
                    status=normalized(source.get(jm['status'],'')).upper()
                    if status not in ('DONE','CLOSE'):continue
                    job['statusMatches']+=1
                    jid=valid_id(source.get(jm['jobId'],''));tid=valid_id(source.get(jm['ttId'],''))
                    if jid is None or tid is None:job['missingIds']+=1;continue
                    created=excel_time(source.get(jm['created'],''),meta['date1904'])
                    finished=excel_time(source.get(jm['finished'],''),meta['date1904'])
                    if created is None or finished is None:job['invalidDates']+=1;continue
                    seconds=(finished-created).total_seconds()
                    if seconds<0:job['negativeDurations']+=1;continue
                    assignee=normalized(source.get(jm['assignee'],''))
                    if len(assignee)>1000:
                        raise MttrImportError('A Job assignee is too long. Existing data unchanged.')
                    job['validRows']+=1
                    if not assignee:job['missingAssignee']+=1
                    db.execute('INSERT OR IGNORE INTO jobs VALUES (?,?,?,?,?,?,?)',(jid,tid,created.isoformat(),finished.isoformat(),assignee,status,seconds))
                if not job['sourceRows']:
                    raise MttrImportError('Job表没有数据行 / Job export has no data rows after the header. Existing data unchanged.',{'source':'job'})
            db.commit()
        finally:db.close()
        yield {'sources':{'tt':tt,'job':job},'mappings':{'tt':tm,'job':jm},'sourceHeaders':{'tt':{r:normalized(th.get(c,''))[:200] for r,c in tm.items()},'job':{r:normalized(jh.get(c,''))[:200] for r,c in jm.items()}},'importedAt':stamp},path

def joined_aggregates(db):
    join=f'FROM mttr_jobs j JOIN mttr_tt t ON j.ttId=t.ttId WHERE t.category IN {RADIO}'
    days=[{'date':r[0],'count':r[1],'totalSeconds':r[2]} for r in db.execute('SELECT substr(j.finishedAt,1,10),count(*),sum(j.durationSeconds) '+join+' GROUP BY substr(j.finishedAt,1,10) ORDER BY 1')]
    people=[{'assignee':r[0],'date':r[1],'count':r[2],'totalSeconds':r[3]} for r in db.execute('SELECT j.assignee,substr(j.finishedAt,1,10),count(*),sum(j.durationSeconds) '+join+' GROUP BY j.assignee,substr(j.finishedAt,1,10) ORDER BY 1,2')]
    return days,people

def finish_pair(summary,days,people):
    tt,job=summary['sources']['tt'],summary['sources']['job']
    total=sum(d['count'] for d in days)
    return {**summary,'formatVersion':3,'filename':(tt['filename']+' + '+job['filename'])[:511],'sheetName':('TT: '+tt['sheetName']+'; Job: '+job['sheetName'])[:200],
            'sourceRows':job['sourceRows'],'matchedRows':job['statusMatches'],'validRows':job['validRows'],'invalidDates':job['invalidDates'],'negativeDurations':job['negativeDurations'],'excludedRows':job['sourceRows']-job['statusMatches'],'missingIds':job['missingIds'],
            'addedRows':job['addedRows'],'duplicateRows':job['duplicates'],'totalTickets':total,'totalJobs':total,
            'days':days,'personDays':people,'earliestDate':days[0]['date'] if days else '','latestDate':days[-1]['date'] if days else '',
            'headerColumns':{'B':summary['sourceHeaders']['job']['ttId'],'F':summary['sourceHeaders']['job']['created'],'J':summary['sourceHeaders']['job']['finished'],'S':summary['sourceHeaders']['job']['status'],'U':summary['sourceHeaders']['tt']['category']},
            'diagnostics':{'categoryMatches':tt['matchedRows'],'statusMatches':job['statusMatches']}}

def validate_v3(value):
    if not isinstance(value,dict) or value.get('formatVersion')!=3:
        raise MttrImportError('Invalid TT/Job MTTR version.')
    if any(not isinstance(value.get(k),dict) or set(value[k])!={'tt','job'} for k in ('sources','mappings','sourceHeaders')):
        raise MttrImportError('Invalid TT/Job source groups.')
    if not isinstance(value.get('importedAt'),str) or datetime.fromisoformat(value['importedAt']).tzinfo is None:
        raise MttrImportError('Invalid import timestamp.')
    # Validate exact shape using the same constructor after all source counters
    # and aggregates are checked. Raw ticket/job rows are validated separately.
    for source in ('tt','job'):
        metadata=value['sources'][source]
        required=({'filename','sheetName','importedAt','sourceRows','matchedRows','uniqueIds','duplicates','missingIds'} if source=='tt' else {'filename','sheetName','importedAt','sourceRows','statusMatches','validRows','invalidDates','negativeDurations','missingIds','duplicates','addedRows','unmatchedTt','missingAssignee'})
        if not isinstance(metadata,dict) or set(metadata)!=required:raise MttrImportError('Invalid source metadata.')
        for key in ('filename','sheetName','importedAt'):
            if not isinstance(metadata[key],str) or not metadata[key] or len(metadata[key])>(255 if key=='filename' else 200):raise MttrImportError('Invalid source filename or timestamp.')
        if datetime.fromisoformat(metadata['importedAt']).tzinfo is None:raise MttrImportError('Invalid source timestamp.')
        if any(type(metadata[k]) is not int or not 0<=metadata[k]<=MAX_ROWS for k in required-{'filename','sheetName','importedAt'}):raise MttrImportError('Invalid source counters.')
        if not valid_source_mapping(value['mappings'][source],source):raise MttrImportError('Invalid source mapping.')
        headers=value['sourceHeaders'][source]
        if not isinstance(headers,dict) or set(headers)!=set(roles_for(source)) or any(not isinstance(v,str) or len(v)>200 for v in headers.values()):raise MttrImportError('Invalid source headers.')
    tt,job=value['sources']['tt'],value['sources']['job']
    if tt['sourceRows']!=tt['uniqueIds']+tt['duplicates']+tt['missingIds'] or tt['matchedRows']>tt['sourceRows'] or job['statusMatches']>job['sourceRows'] or job['statusMatches']!=job['validRows']+job['invalidDates']+job['negativeDurations']+job['missingIds'] or job['validRows']!=job['addedRows']+job['duplicates'] or job['missingAssignee']>job['validRows'] or job['unmatchedTt']>job['validRows']:
        raise MttrImportError('Inconsistent source counters.')
    if not isinstance(value['days'],list) or not isinstance(value['personDays'],list):raise MttrImportError('Missing aggregate data.')
    def checked(rows,person=False):
        previous=None
        for row in rows:
            if not isinstance(row,dict) or set(row)!=({'date','count','totalSeconds','assignee'} if person else {'date','count','totalSeconds'}):raise MttrImportError('Invalid aggregate fields.')
            day=row['date']
            if not isinstance(day,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',day):raise MttrImportError('Invalid aggregate date.')
            datetime.fromisoformat(day)
            if type(row['count']) is not int or not 0<row['count']<=9007199254740991 or type(row['totalSeconds']) not in (int,float) or not math.isfinite(row['totalSeconds']) or row['totalSeconds']<0:raise MttrImportError('Invalid aggregate values.')
            if person and (not isinstance(row['assignee'],str) or len(row['assignee'])>1000):raise MttrImportError('Invalid assignee.')
            key=(row['assignee'],day) if person else day
            if previous is not None and key<=previous:raise MttrImportError('Invalid aggregate order.')
            previous=key
    checked(value['days']);checked(value['personDays'],True)
    if any(type(value.get(k)) is not int or not 0<value[k]<=9007199254740991 for k in ('storedJobs','storedTtIds')):
        raise MttrImportError('Invalid stored TT/Job history counts.')
    total=sum(d['count'] for d in value['days'])
    if total>value['storedJobs']:
        raise MttrImportError('Matched Job count exceeds stored history.')
    if type(value['totalJobs']) is not int or type(value['totalTickets']) is not int or value['totalJobs']!=total or value['totalTickets']!=total or sum(d['count'] for d in value['personDays'])!=total:raise MttrImportError('Inconsistent job totals.')
    summary={k:value[k] for k in ('sources','mappings','sourceHeaders','importedAt','storedJobs','storedTtIds')}
    rebuilt=finish_pair(summary,value['days'],value['personDays'])
    if set(rebuilt)!=set(value) or any(value[k]!=v for k,v in rebuilt.items()):raise MttrImportError('Inconsistent TT/Job summary.')
    return value
