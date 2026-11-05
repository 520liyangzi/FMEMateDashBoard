"""Job-level MTTR is the maximum eligible alarm Duration, not elapsed Job time."""
import csv
from datetime import datetime
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from alarm_mttr import (init_schema,get_dataset,list_job_proxy_details,set_allowlist,stage_import,merge_import,
                       stage_job_import,merge_job_import,clear_alarm,V4_TABLES,JOB_TABLES,ALARM_TABLES,
                       set_al_policy,restore_tables)
from mttr_import import MttrImportError, column_index
from mttr_tests import workbook

HEADER={'A':'Site', 'B':'Alarm ID', 'I':'Duration', 'K':'Occurrence Time', 'AE':'Job ID'}
def row(alarm='26540',duration='0:05:10',occurred='2026/11/05  23:59:58',job='Job1',site='Tower A'):
    return {'A':site,'B':alarm,'I':duration,'K':occurred,'AE':job}

def csv_bytes(rows):
    stream=io.StringIO()
    writer=csv.writer(stream)
    for r in rows:
        values=['']*31
        for k,v in r.items():values[column_index(k)-1]=v
        writer.writerow(values)
    return stream.getvalue().encode('utf-8-sig')


class AlarmMttrTest(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        init_schema(self.db)
    def add(self,rows,allow='26540',*,xlsx=False,**kwargs):
        data=workbook([HEADER]+rows,**kwargs) if xlsx else csv_bytes([HEADER]+rows)
        with stage_import(data,'alarm.'+('xlsx' if xlsx else 'csv')) as staged,self.db:
            return merge_import(self.db,staged,allow)

    def test_work_order_uses_longest_of_repeated_alarm_rows_and_keeps_precise_seconds(self):
        self.jobmap([('Job1','Alice')])
        d=self.add([row(),row(),row(duration='1:00:00.125',occurred='2026-11-06T00:00:01'),row(job='   '),
                    row(alarm='   '),row(duration='0'),row(duration='00:00:00.000'),row(duration='0:61:00'),
                    row(duration='-2'),row(occurred='2026/02/30 11:25:00'),row(alarm='126540')])
        self.assertEqual(d['days'],[{'date':'2026-11-06','totalSeconds':3600.125,'count':1}])
        self.assertEqual((d['totalJobs'],d['unassignedJobs']),(1,0))
        self.assertEqual((d['totalAlarms'],d['storedRows']),(3,4))
        imp=d['lastImport']
        self.assertEqual(tuple(imp[k] for k in ('missingJobIds','missingAlarmIds','invalidDates','invalidDurations','zeroDurations','matchedRows')),(1,1,1,2,2,3))

    def test_overlap_max_multiplicity_including_non_mapped_columns(self):
        self.jobmap([('Job1','Alice')])
        self.add([row(),row(site='Tower B')])
        result=self.add([row(),row(),row(site='Tower B')])
        self.assertEqual((result['totalAlarms'],result['lastImport']['duplicateRows'],result['lastImport']['addedRows']),(3,2,1))
        repeated=self.add([row(),row(site='Tower B')])
        self.assertEqual((repeated['totalAlarms'],repeated['lastImport']['addedRows']),(3,0))

    def test_no_matches_reclassify_without_reimport_and_allowlist_empty_never_all(self):
        self.jobmap([('Job1','Alice')])
        d=self.add([row(alarm='26540.0'),row(alarm='26564',duration='25:15:20')],'99999')
        self.assertEqual(d['totalAlarms'],0)
        self.assertEqual(d['storedRows'],2)
        d=set_allowlist(self.db,'26540， 26564,26540,,')
        self.assertEqual(d['allowlist'],['26540','26564'])
        self.assertEqual(d['days'],[{'date':'2026-11-05','count':1,'totalSeconds':25*3600+15*60+20}])
        empty=set_allowlist(self.db,'   ')
        self.assertEqual((empty['days'],empty['earliestDate'],empty['latestDate']),([],None,None))
        self.assertEqual(set_allowlist(self.db,'2645')['totalAlarms'],0)
        cleared=clear_alarm(self.db)
        self.assertEqual((cleared['lastImport'],cleared['storedRows'],cleared['allowlist']),(None,0,['2645']))

    def test_real_xlsx_duration_cells_and_1904_occurrence_serial(self):
        self.jobmap([('Job1','Alice'),('Job2','Bob')])
        serial=(datetime(2026,11,5,6,4)-datetime(1904,1,1)).total_seconds()/86400
        d=self.add([row(duration=('n',310/86400),occurred=('n',serial),job='Job2'),row(duration=('n','0'),occurred=('n',serial)),
                    row(duration=('n','1.5'),occurred=('n',serial+1)),row(duration='2.5',occurred=('n',serial))],
                   xlsx=True,date1904=True)
        self.assertEqual(d['days'],[{'date':'2026-11-05','count':1,'totalSeconds':310.},
                                   {'date':'2026-11-06','count':1,'totalSeconds':36*3600.}])
        self.assertEqual((d['lastImport']['zeroDurations'],d['lastImport']['invalidDurations']),(1,1))

    def test_subsecond_native_excel_occurrence_never_rounds_into_next_date(self):
        self.jobmap([('Job1','Alice')])
        d=self.add([row(occurred=('n','46318.99999710648'))],xlsx=True)
        self.assertEqual(d['days'][0]['date'],'2026-10-23')
        same=self.add([row(occurred='2026-10-23 23:59:59.750')])
        self.assertEqual((same['totalAlarms'],same['lastImport']['duplicateRows']),(1,1))

    def test_cross_format_overlap_with_different_native_excel_representations(self):
        self.jobmap([('Job1','Alice')])
        self.add([row(duration=('n',310/86400),occurred='2026/11/05 6:40:00',alarm=('n','26540'))],xlsx=True)
        d=self.add([row(occurred='2026-11-05T06:40:00',alarm='26540.0')])
        self.assertEqual((d['totalAlarms'],d['lastImport']['duplicateRows']),(1,1))

    def test_invalid_upload_and_invalid_allowlist_preserve_both_settings_and_history(self):
        original=self.add([row()])
        for records in [[row(duration='0:00:00')],[row(occurred='11/05/2026')],[row(duration='NaN')],[row(duration='01:02:90')]]:
            with self.assertRaises(MttrImportError):
                self.add(records,'999')
            self.assertEqual(get_dataset(self.db),original)
        with self.assertRaises(MttrImportError):
            self.add([row(duration='01:00:00')],['bad,compound'])
        self.assertEqual(get_dataset(self.db),original)

    def test_staged_upload_streams_from_path_and_changed_mapping_is_rejected(self):
        self.jobmap([('Job1','Alice')])
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'source.csv'
            path.write_bytes(csv_bytes([HEADER,row(duration='123:45:06')]))
            with stage_import(path,'source.csv') as stage,self.db:
                out=merge_import(self.db,stage,'26540')
            self.assertEqual(out['days'][0]['totalSeconds'],123*3600+45*60+6)
            with self.assertRaises(MttrImportError), stage_import(path,'source.csv','F','minutes'):
                pass

    def jobmap(self,rows,xlsx=False):
        header={'C':'jb_id','AG':'jb_assign_to','AL':'reported person'}
        records=[header]+[{'C':r[0],'AL':r[-1],'AG':r[1] if len(r)==3 else ''} for r in rows]
        if xlsx:
            data=workbook(records)
        else:
            out=io.StringIO();writer=csv.writer(out)
            for r in records:
                vals=['']*38;vals[2]=r['C'];vals[32]=r['AG'];vals[37]=r['AL'];writer.writerow(vals)
            data=out.getvalue().encode()
        with stage_job_import(data,'jobs.'+('xlsx' if xlsx else 'csv')) as st,self.db:
            return merge_job_import(self.db,st)

    def test_max_and_period_move_when_allowlist_changes_ties_choose_earliest_day_once(self):
        self.jobmap([('J1','Alice'),('J2','Bob')])
        d=self.add([row(job='J1',alarm='X',duration='0:20:00',occurred='2026-11-03'),
                    row(job='J1',alarm='Y',duration='0:30:00',occurred='2026-11-12'),
                    row(job='J1',alarm='Y',duration='0:30:00',occurred='2026-11-11'),
                    row(job='J2',alarm='X',duration='0:10:00',occurred='2026-11-11'),
                    row(job='J3',alarm='X',duration='0:50:00',occurred='2026-11-11')],'X,Y')
        self.assertEqual((d['totalJobs'],d['totalAlarms'],d['unassignedJobs']),(2,4,1))
        self.assertEqual(d['days'],[{'date':'2026-11-11','count':2,'totalSeconds':2400}])
        self.assertEqual([(x['assignee'],x['count'],x['totalSeconds']) for x in d['personDays']],
                         [('Alice',1,1800),('Bob',1,600)])
        d=set_allowlist(self.db,'X')
        self.assertEqual(d['days'],[{'date':'2026-11-03','count':1,'totalSeconds':1200},
                                     {'date':'2026-11-11','count':1,'totalSeconds':600}])
        self.assertEqual(d['personDays'][0]['assignee'],'Alice')

    def test_mapping_updates_existing_rows_atomically_normalizes_ids_and_keeps_leading_zeroes(self):
        d=self.add([row(job=' 00123 '),row(job='123.0'),row(job='999')])
        self.assertEqual((d['totalJobs'],d['unassignedJobs']),(0,3))
        d=self.jobmap([(('n',123),' Alice '),('00123','Bob'),('00123','Bob'),('999','  '),('','Z')],True)
        self.assertEqual([(x['assignee'],x['count']) for x in d['personDays']],[('Alice',1),('Bob',1)])
        m=d['lastJobImport'];self.assertEqual(tuple(m[k] for k in ('missingJobIds','missingAssignees','duplicateRows','mappedJobs')),(1,1,1,2))
        with self.assertRaisesRegex(MttrImportError,'Conflicting'):
            self.jobmap([('123','A'),('123','B')])
        self.assertEqual(get_dataset(self.db),d)
        with self.assertRaisesRegex(MttrImportError,'No rows'):
            self.jobmap([('123','')])
        self.assertEqual(get_dataset(self.db),d)
        d=self.jobmap([('123','Bob'),('00123','')])
        self.assertEqual([(x['assignee'],x['count']) for x in d['personDays']],[('Bob',2)])
        self.assertEqual((d['totalJobs'],d['mappedJobs']),(2,2))

    def test_details_explain_the_same_mean_after_global_maxima_and_date_ties(self):
        self.jobmap([('J1','Alice'),('J2',"O'Neil")])
        maximum=row(alarm='X',job='J1',duration='0:20:00',occurred='2026-11-06')
        summary=self.add([maximum,maximum,
                          row(alarm='Y',job='J1',duration='0:20:00',occurred='2026-11-08'),
                          row(alarm='Y',job='J1',duration='0:15:00',occurred='2026-11-01'),
                          row(alarm='X',job='J2',duration='0:05:00.25',occurred='2026-11-07'),
                          row(alarm='X',job='J3',duration='1:00:00',occurred='2026-11-07')],'X,Y')
        get=lambda **kwargs:list_job_proxy_details(self.db,**kwargs)
        all_jobs=get()
        self.assertEqual(all_jobs['revision'],summary['revision'])
        self.assertEqual([r['jobId'] for r in all_jobs['rows']],['J2','J1'])
        self.assertEqual((all_jobs['total'],all_jobs['totalSeconds']),
                         (summary['totalJobs'],sum(d['totalSeconds'] for d in summary['days'])))
        j1={'jobId':'J1','assignee':'Alice','alPerson':'Alice','date':'2026-11-06','seconds':1200,'alarmCount':4,'alarmId':'X'}
        self.assertEqual(get(date_from='2026-11-06',date_to='2026-11-06')['rows'],[j1])
        self.assertEqual(get(date_to='2026-11-05')['total'],0)
        self.assertEqual(get(date_from='2026-11-08')['total'],0)
        self.assertEqual(get(assignees=[''])['rows'],[])
        self.assertEqual(get(assignees=[])['total'],0)
        self.assertEqual(get(assignees=["O'Neil",'Alice','Alice'])['totalSeconds'],1500.25)
        first=get(limit=1)
        second=get(offset=1,limit=2)
        self.assertEqual(first['rows']+second['rows'],all_jobs['rows'])
        empty=get(offset=30,limit=1)
        self.assertEqual((empty['rows'],empty['total'],empty['totalSeconds']),([],2,1500.25))
        # The selected maximum (and its date) moves when X is removed.
        updated=set_allowlist(self.db,'Y')
        self.assertNotEqual(updated['revision'],all_jobs['revision'])
        self.assertEqual(get()['rows'],[dict(j1,alarmId='Y',alarmCount=2,date='2026-11-08')])
        self.assertEqual(get()['revision'],updated['revision'])

    def test_detail_large_owner_set_is_bound_and_invalid_parameters_cannot_expand_scope(self):
        self.add([row()])
        self.jobmap([('Job1','李华')])
        many=['person'+str(i) for i in range(1200)]
        # A selected owner with no eligible Job must not introduce any rows.
        self.assertEqual(list_job_proxy_details(self.db,assignees=many)['total'],0)
        self.assertEqual(list_job_proxy_details(self.db,assignees=many+['李华'])['total'],1)
        for args in ({'date_from':'2026-11-31'}, {'date_from':'20261101'},
                     {'date_from':'2026-11-06','date_to':'2026-11-05'},
                     {'assignees':'李华'}, {'assignees':[None]}, {'assignees':['x\n']},
                     {'offset':-1}, {'offset':2**63}, {'limit':5001}, {'limit':True}):
            with self.subTest(args=args),self.assertRaises(MttrImportError):
                list_job_proxy_details(self.db,**args)

    def test_winner_cache_rebuilds_from_original_v5_and_ignores_backup_cache_contents(self):
        self.add([row()]);self.jobmap([('Job1','A')])
        original=list_job_proxy_details(self.db)
        # An earlier V5 DB did not have a winner cache or revision token.
        for table in ('alarm_mttr_job_max','alarm_mttr_revision'):
            self.db.execute('DROP TABLE '+table)
        init_schema(self.db)
        self.assertEqual(list_job_proxy_details(self.db)['rows'],original['rows'])
        # The backup's derived data is never trusted during restore.
        self.db.execute("UPDATE alarm_mttr_job_max SET seconds=99999")
        with sqlite3.connect(':memory:') as dest:
            init_schema(dest)
            restore_tables(self.db,dest,ALARM_TABLES)
            self.assertEqual(list_job_proxy_details(dest)['rows'],original['rows'])
            self.assertNotEqual(list_job_proxy_details(dest)['revision'],original['revision'])

    def test_old_snapshot_restores_without_fabricating_ids_and_partial_reupload_recovers(self):
        self.add([row(job='J1'),row(job='J1'),row(job='J2')]);self.db.commit()
        with sqlite3.connect(':memory:') as dest:
            init_schema(dest)
            # Old backups contain these three V4 tables only; they have no reversible Job IDs.
            restore_tables(self.db,dest,set(V4_TABLES))
            ds=get_dataset(dest)
            self.assertEqual((ds['needsAlarmReimport'],ds['legacyUnlinkedRows'],ds['totalJobs'],ds['days']),(True,3,0,[]))
            with stage_import(csv_bytes([HEADER,row(job='J1')]),'overlap.csv') as st,dest:
                ds=merge_import(dest,st,'26540')
            self.assertEqual((ds['totalJobs'],ds['totalAlarms'],ds['unassignedJobs'],ds['legacyUnlinkedRows'],ds['needsAlarmReimport']),(0,0,1,1,True))
            with stage_import(csv_bytes([HEADER,row(job='J2')]),'original.csv') as st,dest:
                ds=merge_import(dest,st,'26540')
            self.assertEqual((ds['totalJobs'],ds['totalAlarms'],ds['unassignedJobs'],ds['storedRows'],ds['needsAlarmReimport']),(0,0,2,3,False))

    def test_report_is_intersection_of_named_owners_and_eligible_alarms(self):
        # Catalogue-only Jobs, filtered alarms, and Jobs without a named owner
        # never set report dates, contribute alarm copies, or become selectable.
        catalogue=self.jobmap([('A','Alice'),('B','Bob'),('C','Carol'),('absent','Dan'),('U',' ')])
        self.assertEqual((catalogue['assignees'],catalogue['mappedJobs']),([],4))
        raw=self.add([row(job='A',alarm='X'),row(job='B',alarm='Y'),row(job='C',duration='0'),
                      row(job='U',alarm='X',occurred='2027-01-01'),row(job='U',alarm='X',occurred='2027-01-01')],'X')
        self.assertEqual((raw['assignees'],raw['totalJobs'],raw['totalAlarms'],raw['unassignedJobs']),(['Alice'],1,1,1))
        self.assertEqual((raw['storedRows'],raw['latestDate'],raw['earliestDate']),(4,'2026-11-05','2026-11-05'))
        self.assertEqual(list_job_proxy_details(self.db,assignees=['','Dan'])['total'],0)
        self.assertEqual([r['jobId'] for r in list_job_proxy_details(self.db)['rows']],['A'])
        mapped=self.jobmap([('U','Uma')])
        self.assertEqual((mapped['assignees'],mapped['totalJobs'],mapped['totalAlarms'],mapped['unassignedJobs']),
                         (['Alice','Uma'],2,3,0))
        self.assertEqual(mapped['latestDate'],'2027-01-01')
        remapped=self.jobmap([('U','Alice')])
        self.assertEqual((remapped['assignees'],remapped['totalJobs'],remapped['unassignedJobs']),(['Alice'],2,0))
        switched=set_allowlist(self.db,'Y')
        self.assertEqual((switched['assignees'],switched['totalJobs'],switched['totalAlarms'],switched['storedRows']),
                         (['Bob'],1,1,4))

    def test_al_only_cohort_shared_by_filters_counts_details_and_person_ranking(self):
        self.add([row(job='1',duration='0:01:00',occurred='2026-11-01'),row(job='1',duration='0:02:00',occurred='2026-11-02'),
                  row(job='2',duration='0:05:00',occurred='2026-11-03'),row(job='3',duration='0:08:00',occurred='2026-11-04'),
                  row(job='4',duration='0:09:00',occurred='2026-11-05'),row(job='5',alarm='not-allowed')])
        all_jobs=self.jobmap([('1','AG owner',' Ｊane   Doe '),('1','different AG','jane DOE'),
                              ('2','','JANE DOE'),('3','Jane Doe','JANE DOE JR'),('4','Jane Doe',' '),
                              ('5','','No eligible alarm')],xlsx=True)
        def counts(d):
            return (d['totalJobs'],d['totalAlarms'],d['assignees'],d['unassignedJobs'],d['alDiagnostics'])
        def policy(mode,names):
            return set_al_policy(self.db,dict(mode=mode,names=names))
        self.assertEqual(all_jobs['alPolicy'],{'mode':'all','names':[]})
        self.assertEqual(all_jobs['lastJobImport']['personColumn'],'AL')
        self.assertEqual(counts(all_jobs),(3,4,['JANE DOE JR','Jane Doe'],1,{'missingALJobs':1,'filteredOutJobs':0}))
        only=policy('include',['  jAnE　Doe ','ＪＡＮＥ DOE',''])
        self.assertEqual(only['alPolicy'],{'mode':'include','names':['jAnE Doe']})
        self.assertEqual(counts(only),(2,3,['Jane Doe'],1,{'missingALJobs':1,'filteredOutJobs':1}))
        self.assertEqual((only['earliestDate'],only['latestDate']),('2026-11-02','2026-11-03'))
        details=list_job_proxy_details(self.db,assignees=['JANE DOE'])
        self.assertEqual((details['total'],details['totalSeconds']), (2,420))
        self.assertEqual([(r['jobId'],r['alPerson'],r['assignee']) for r in details['rows']],
                         [('2','Jane Doe','Jane Doe'),('1','Jane Doe','Jane Doe')])
        excluded=policy('exclude',['jane doe'])
        self.assertEqual(counts(excluded),(1,1,['JANE DOE JR'],1,{'missingALJobs':1,'filteredOutJobs':2}))
        self.assertEqual(excluded['days'],[{'date':'2026-11-04','totalSeconds':480,'count':1}])
        self.assertEqual(list_job_proxy_details(self.db)['totalSeconds'],480)
        self.assertEqual(list_job_proxy_details(self.db,assignees=['Jane Doe'])['rows'],[])
        self.assertEqual(counts(policy('all',[])), counts(all_jobs))

    def test_bad_al_file_or_policy_preserves_everything_and_partial_updates_never_erase(self):
        self.add([row(job='1'),row(job='2')])
        base=self.jobmap([('1','wrong AG','Alice')])
        for bad in ([('1','AG only',''),('2','AG only','')],[('1','AG','eve'),('1','AG','other AL')]):
            with self.assertRaises(MttrImportError):
                self.jobmap(bad)
            self.assertEqual(get_dataset(self.db),base)
        new=self.jobmap([('1','Alice',' '),('2','','Bob')])
        self.assertEqual((new['mappedJobs'],new['assignees'],new['lastJobImport']['missingAssignees']),
                         (2,['Alice','Bob'],1))
        for invalid in ({'mode':'include','names':[]},{'mode':'exclude','names':['  ']},
                        {'mode':'all','names':'Amy'},{'mode':'all','names':[2]},
                        {'mode':'include','names':['a'*513]},{'mode':'exclude','names':['x']*10001},
                        {'mode':'all','groupBy':'AG','names':[]},{'mode':'all','names':[chr(0xd800)]}):
            with self.assertRaises(MttrImportError):set_al_policy(self.db,invalid)
            self.assertEqual(get_dataset(self.db),new)
        newer=self.jobmap([('1','old AG','Bob')])
        self.assertEqual((newer['totalJobs'],newer['assignees'],newer['lastJobImport']['mappedJobs']),(2,['Bob'],1))
        none=set_al_policy(self.db,{'mode':'include','names':['not yet imported']})
        self.assertEqual((none['totalJobs'],none['days'],none['latestDate'],none['alDiagnostics']['filteredOutJobs']),
                         (0,[],None,2))
        joined=self.jobmap([('1','','Not Yet Imported')])
        self.assertEqual((joined['totalJobs'],joined['assignees'],joined['alDiagnostics']['filteredOutJobs']),
                         (1,['Not Yet Imported'],1))

    def test_ag_only_backup_requires_job_al_reimport_and_new_backup_roundtrip_keeps_policy(self):
        self.add([row(),row(job='J2')])
        # Simulate the earlier V5 archive: only the old AG catalogue and
        # receipt exist. The original alarm rows and per-Job winners survive.
        new=self.jobmap([('Job1','A')])
        old=dict(new['lastJobImport']);del old['personColumn']
        self.db.execute('INSERT INTO alarm_mttr_job_owners VALUES(?,?)',('Job1','Old AG'))
        self.db.execute('UPDATE alarm_mttr_job_import SET data=?',(json.dumps(old),))
        with sqlite3.connect(':memory:') as dest:
            init_schema(dest)
            restore_tables(self.db,dest,V4_TABLES|JOB_TABLES)
            d=get_dataset(dest)
            self.assertEqual((d['storedRows'],d['mappedJobs'],d['totalJobs'],d['unassignedJobs'],d['assignees']),
                             (2,0,0,2,[]))
            self.assertEqual(dest.execute('SELECT assignee FROM alarm_mttr_job_owners').fetchone()[0],'Old AG')
            self.assertNotIn('personColumn',d['lastJobImport'])
            data=workbook([{'C':'Job ID','AL':'AL person'},{'C':'Job1','AL':'A'}])
            with stage_job_import(data,'restored.xlsx') as st:
                d=merge_job_import(dest,st)
            self.assertEqual((d['storedRows'],d['mappedJobs'],d['assignees'],d['unassignedJobs']),(2,1,['A'],1))
            d=set_al_policy(dest,{'mode':'exclude','names':['a']})
            self.assertEqual((d['totalJobs'],d['alDiagnostics']),(0,{'missingALJobs':1,'filteredOutJobs':1}))
            with sqlite3.connect(':memory:') as roundtrip:
                init_schema(roundtrip);restore_tables(dest,roundtrip,ALARM_TABLES)
                restored=get_dataset(roundtrip)
                self.assertEqual({k:v for k,v in restored.items() if k!='revision'},
                                 {k:v for k,v in d.items() if k!='revision'})
                wiped=clear_alarm(roundtrip)
                self.assertEqual((wiped['mappedJobs'],wiped['unassignedJobs'],wiped['alPolicy']),
                                 (0,0,{'mode':'exclude','names':['a']}))
                self.assertEqual(roundtrip.execute('SELECT count(*) FROM alarm_mttr_job_owners').fetchone()[0],0)

if __name__=='__main__':unittest.main()
