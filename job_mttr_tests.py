"""Job MTTR uses TT category association, never TT elapsed times."""
import csv
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request,urlopen
import zipfile
from server import Store,ReportServer,ApiError
from job_mttr_import import validate_v3
from mttr_tests import workbook,HEADER,row
from mttr_import import column_index

TT_HEADER={'B':'tt_id','U':'domain'}
JOB_HEADER={'A':'jb_id','B':'tt_id','G':'jb_create_date','I':'jb_finish_date','AG':'jb_assign_to','AR':'jb_status'}
def tt(tid='TT1',cat='Radio-OSP'):return {'B':tid,'U':cat}
def job(jid='J1',tid='TT1',created='2026/10/19 0:00:00',finished='2026/10/19 10:00:00',person='Alice',status='Done'):
    return {'A':jid,'B':tid,'G':created,'I':finished,'AG':person,'AR':status}
def csv_bytes(rows):
    out=io.StringIO(newline='');writer=csv.writer(out)
    for source in rows:
        values=['']*max((column_index(k) for k in source),default=1)
        for col,value in source.items():values[column_index(col)-1]=value
        writer.writerow(values)
    return out.getvalue().encode('utf-8-sig')

class JobMttrTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.store=Store(Path(self.tmp.name)/'data')
    def tearDown(self):self.tmp.cleanup()
    def fields(self,tts=None,jobs=None,ttmap=None,jobmap=None):
        result={'ttFile':{'filename':'tt.xlsx','data':workbook(tts if tts is not None else [TT_HEADER,tt()])},'jobFile':{'filename':'job.xlsx','data':workbook(jobs if jobs is not None else [JOB_HEADER,job()])}}
        if ttmap is not None:result['ttMapping']={'value':json.dumps(ttmap)}
        if jobmap is not None:result['jobMapping']={'value':json.dumps(jobmap)}
        return result
    def pair(self,tts=None,jobs=None,**kw):return self.store.import_mttr_pair(self.fields(tts,jobs,**kw))
    def test_one_tt_many_jobs_and_duplicate_tt_not_multiplying(self):
        data=self.pair([TT_HEADER,tt(cat='Power'),tt(),tt()], [JOB_HEADER,job(),job('J2',person='Bob'),job('J3',status='Close',person='')])
        self.assertEqual(data['formatVersion'],3);self.assertEqual(data['totalJobs'],3);self.assertEqual(data['totalTickets'],3)
        self.assertEqual(data['days'],[{'date':'2026-10-19','count':3,'totalSeconds':108000}])
        self.assertEqual(data['sources']['tt']['duplicates'],2);self.assertEqual(data['sources']['tt']['matchedRows'],2)
        self.assertEqual(data['sources']['job']['missingAssignee'],1)
        self.assertEqual({r['assignee'] for r in data['personDays']},{'Alice','Bob',''})
        self.assertNotIn('tt_create_date',str(data['sourceHeaders']));validate_v3(data)
    def test_status_dates_missing_ids_and_first_valid_job_wins(self):
        jobs=[JOB_HEADER,job(status='OPEN'),job(created='bad'),job(status=' done '),job(finished='2026/10/19 20:00:00'),job('J2',status='CLOSE'),job('J3',status='CLOSED'),job('J4',created='2026/10/20 0:00:00'),job('',tid='TT1'),job('J5',tid='')]
        data=self.pair(jobs=jobs);quality=data['sources']['job']
        self.assertEqual((quality['sourceRows'],quality['statusMatches'],quality['validRows']),(9,7,3))
        self.assertEqual((quality['invalidDates'],quality['negativeDurations'],quality['missingIds']),(1,1,2))
        self.assertEqual((quality['addedRows'],quality['duplicates'],data['totalJobs']),(2,1,2))
        self.assertEqual(data['days'][0]['totalSeconds'],72000)
    def test_cross_file_job_id_dedup_and_restart(self):
        first=self.pair();second=self.pair(jobs=[JOB_HEADER,job(finished='2026/10/19 20:00:00'),job('J2')])
        self.assertEqual(second['totalJobs'],2);self.assertEqual(second['days'][0]['totalSeconds'],72000)
        self.assertEqual(second['sources']['job']['duplicates'],1)
        self.assertEqual(Store(self.store.root).get_mttr(),second)
    def test_unmatched_jobs_survive_and_later_tt_reclassification_rejoins(self):
        first=self.pair(jobs=[JOB_HEADER,job(),job('J2',tid='TT2',person='Bob')])
        self.assertEqual(first['totalJobs'],1);self.assertEqual(first['sources']['job']['unmatchedTt'],1)
        # No new valid Jobs needed: a new TT catalogue row can qualify prior work.
        second=self.pair([TT_HEADER,tt('TT2')],[JOB_HEADER,job('OPEN',status='OPEN')])
        self.assertEqual(second['totalJobs'],2);self.assertEqual(second['sources']['job']['validRows'],0)
        third=self.pair([TT_HEADER,tt('TT1','Power')],[JOB_HEADER,job('OPEN',status='OPEN')])
        self.assertEqual(third['totalJobs'],1);self.assertEqual(third['personDays'][0]['assignee'],'Bob')
    def test_both_sources_atomic_parse_and_mapping_failures(self):
        before=self.pair()
        fields=self.fields([TT_HEADER,tt('TT1','Power')],[JOB_HEADER,job('J2')]);fields['jobFile']['data']=b'bad'
        with self.assertRaises(ApiError):self.store.import_mttr_pair(fields)
        self.assertEqual(self.store.get_mttr(),before)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT category FROM mttr_tt WHERE ttId=?',('TT1',)).fetchone()[0],'RADIO-OSP')
            self.assertEqual(db.execute('SELECT count(*) FROM mttr_jobs').fetchone()[0],1)
        unknown={**JOB_HEADER,'G':'jb_history_assign_date'}
        with self.assertRaises(ApiError) as error:self.pair([TT_HEADER,tt('TT1','Power')],[unknown,job('J2')])
        self.assertEqual(error.exception.details['source'],'job');self.assertTrue(error.exception.details['requiresMapping'])
        self.assertNotIn('created',error.exception.details['suggestedMapping']);self.assertEqual(self.store.get_mttr(),before)
        with self.assertRaises(ApiError):self.pair(jobs=[JOB_HEADER])
        self.assertEqual(self.store.get_mttr(),before)
    def test_person_finish_date_elapsed_seconds_and_unicode(self):
        data=self.pair([TT_HEADER,tt(cat='Radio\u2011 ISP\u00a0')],[JOB_HEADER,job(created='2026/10/18 23:00',finished='2026/10/19 1:00',person=' Alice\u00a0 '),job('J2',created='2026/10/19 1:00',finished='2026/10/19 1:00',person='')])
        self.assertEqual(data['days'],[{'date':'2026-10-19','count':2,'totalSeconds':7200}])
        self.assertEqual(data['personDays'],[{'assignee':'','date':'2026-10-19','count':1,'totalSeconds':0},{'assignee':'Alice','date':'2026-10-19','count':1,'totalSeconds':7200}])
    def test_manual_both_source_mappings_and_csv(self):
        th={'D':'client_ticket_reference','H':'customer_category'};jh={'C':'work_reference','F':'parent_reference','J':'work_started','L':'work_finished','M':'engineer','O':'work_state'}
        tm={'ttId':'D','category':'H'};jm={'jobId':'C','ttId':'F','created':'J','finished':'L','assignee':'M','status':'O'}
        fields={'ttFile':{'filename':'tt.csv','data':csv_bytes([th,{'D':'TT1','H':'Radio-OSP'}])},'jobFile':{'filename':'job.csv','data':csv_bytes([jh,{'C':'J1','F':'TT1','J':'2026/10/19 0:00:00','L':'2026/10/19 6:00:00','M':'A','O':'DONE'}])}}
        with self.assertRaises(ApiError) as err:self.store.import_mttr_pair(fields)
        self.assertEqual(err.exception.details['source'],'tt')
        fields['ttMapping']={'value':json.dumps(tm)}
        with self.assertRaises(ApiError) as err:self.store.import_mttr_pair(fields)
        self.assertEqual(err.exception.details['source'],'job')
        fields['jobMapping']={'value':json.dumps(jm)}
        data=self.store.import_mttr_pair(fields);self.assertEqual(data['days'][0]['totalSeconds'],21600)
        self.assertEqual(data['mappings'],{'tt':tm,'job':jm});validate_v3(data)
    def test_legacy_v2_migration_only_after_success_and_old_import_cannot_overwrite(self):
        old=self.store.import_mttr({'file':{'filename':'old.xlsx','data':workbook([HEADER,row()])}})
        with self.assertRaises(ApiError):self.pair([TT_HEADER,tt(cat='Power')],[JOB_HEADER,job(status='OPEN')])
        self.assertEqual(self.store.get_mttr(),old)
        new=self.pair();self.assertEqual(new['formatVersion'],3)
        with self.store.connect() as db:self.assertEqual(db.execute('SELECT count(*) FROM mttr_tickets').fetchone()[0],0)
        with self.assertRaises(ApiError) as err:self.store.import_mttr({'file':{'filename':'old.xlsx','data':workbook([HEADER,row()])}})
        self.assertEqual(err.exception.status,409);self.assertEqual(self.store.get_mttr(),new)
    def test_backup_restore_unmatched_history_and_corrupt_ledger_rejection(self):
        original=self.pair(jobs=[JOB_HEADER,job(),job('J2',tid='TT2',person='Bob')]);backup=self.store.backup()
        target=Store(Path(self.tmp.name)/'target');target.restore(backup);self.assertEqual(target.get_mttr(),original)
        fields=self.fields([TT_HEADER,tt('TT2')],[JOB_HEADER,job(status='OPEN')])
        self.assertEqual(target.import_mttr_pair(fields)['totalJobs'],2)
        bad_db=Path(self.tmp.name)/'corrupt.db'
        with zipfile.ZipFile(io.BytesIO(backup)) as src:bad_db.write_bytes(src.read('report.db'))
        with sqlite3.connect(bad_db) as db:db.execute('DELETE FROM mttr_jobs WHERE jobId=?',('J1',))
        out=io.BytesIO()
        with zipfile.ZipFile(out,'w') as z:z.writestr('manifest.json',json.dumps({'format':'fmemate-report-backup','version':1}));z.write(bad_db,'report.db')
        with self.assertRaises(ApiError):self.store.restore(out.getvalue())
        self.assertEqual(self.store.get_mttr(),original)
        self.store.delete_mttr()
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM mttr_jobs').fetchone()[0],0);self.assertEqual(db.execute('SELECT count(*) FROM mttr_tt').fetchone()[0],0)
    def test_zero_joined_jobs_persist_and_rejoin_then_reclassify_to_zero(self):
        first=self.pair(jobs=[JOB_HEADER,job(tid='TT2')])
        self.assertEqual((first['totalJobs'],first['days'],first['personDays'],first['latestDate']),(0,[],[],''))
        self.assertEqual(first['sources']['job']['unmatchedTt'],1);validate_v3(first)
        second=self.pair([TT_HEADER,tt('TT2')],[JOB_HEADER,job(status='OPEN')])
        self.assertEqual(second['totalJobs'],1)
        last=self.pair([TT_HEADER,tt('TT2','Power')],[JOB_HEADER,job(status='OPEN')])
        self.assertEqual(last['totalJobs'],0);validate_v3(last)
        target=Store(Path(self.tmp.name)/'empty-copy');target.restore(self.store.backup());self.assertEqual(target.get_mttr(),last)
    def test_backup_missing_unmatched_history_rejected_even_when_statistics_empty(self):
        original=self.pair(jobs=[JOB_HEADER,job(tid='TT2')]);backup=self.store.backup()
        self.assertEqual((original['totalJobs'],original['storedJobs'],original['storedTtIds']),(0,1,1))
        sourcefile=Path(self.tmp.name)/'missing.db'
        with zipfile.ZipFile(io.BytesIO(backup)) as src:sourcefile.write_bytes(src.read('report.db'))
        with sqlite3.connect(sourcefile) as db:db.execute('DELETE FROM mttr_jobs')
        out=io.BytesIO()
        with zipfile.ZipFile(out,'w') as z:z.writestr('manifest.json',json.dumps({'format':'fmemate-report-backup','version':1}));z.write(sourcefile,'report.db')
        with self.assertRaises(ApiError):self.store.restore(out.getvalue())
        self.assertEqual(self.store.get_mttr(),original)
    def test_no_valid_jobs_ever_keeps_fresh_database_empty(self):
        with self.assertRaises(ApiError):self.pair(jobs=[JOB_HEADER,job(status='OPEN')])
        self.assertIsNone(self.store.get_mttr())
        with self.store.connect() as db:self.assertEqual(db.execute('SELECT count(*) FROM mttr_tt').fetchone()[0],0)
    def test_http_pair_contract_origin_and_required_jobid(self):
        server=ReportServer(('127.0.0.1',0),self.store);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();url='http://127.0.0.1:'+str(server.server_port)
        try:
            def body(fields):
                parts=[]
                for key,field in fields.items():
                    if 'filename' in field:parts.append((f'--pair-test\r\nContent-Disposition: form-data; name="{key}"; filename="{field["filename"]}"\r\n\r\n').encode()+field['data']+b'\r\n')
                    else:parts.append((f'--pair-test\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{field["value"]}\r\n').encode())
                return b''.join(parts)+b'--pair-test--\r\n'
            req=Request(url+'/api/mttr/import-pair',data=body(self.fields()),headers={'Content-Type':'multipart/form-data; boundary=pair-test'},method='POST')
            with urlopen(req) as response:self.assertEqual(json.load(response)['totalJobs'],1)
            with self.assertRaises(HTTPError) as err:urlopen(Request(url+'/api/mttr/import-pair',data=body(self.fields()),headers={'Content-Type':'multipart/form-data; boundary=pair-test','Origin':'http://other.invalid'},method='POST'))
            self.assertEqual(err.exception.code,403)
            unknown={**JOB_HEADER,'A':'other_identifier'}
            with self.assertRaises(HTTPError) as err:urlopen(Request(url+'/api/mttr/import-pair',data=body(self.fields(jobs=[unknown,job()])),headers={'Content-Type':'multipart/form-data; boundary=pair-test'},method='POST'))
            detail=json.load(err.exception)['details'];self.assertTrue(detail['requiresMapping']);self.assertEqual(detail['source'],'job');self.assertNotIn('jobId',detail['suggestedMapping'])
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
