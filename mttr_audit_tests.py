"""Read-only MTTR date diagnosis against the actual cumulative Job ledger."""
from datetime import datetime
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request,urlopen
from server import Store,ReportServer,ApiError
from job_mttr_tests import TT_HEADER,JOB_HEADER,tt,job,workbook

class MttrAuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.store=Store(Path(self.tmp.name)/'data')
    def tearDown(self):self.tmp.cleanup()
    def pair(self,jobs,tts=None):
        return self.store.import_mttr_pair({'ttFile':{'filename':'tt.xlsx','data':workbook(tts or [TT_HEADER,tt()])},'jobFile':{'filename':'job.xlsx','data':workbook([JOB_HEADER]+jobs)}})
    def test_october31_text_and_excel_serial_do_not_produce_december14(self):
        base=datetime(1899,12,30)
        serial=lambda stamp:(datetime.fromisoformat(stamp)-base).total_seconds()/86400
        text=job('TEXT',created='2026/10/31  17:04:00',finished='2026/10/31 18:04:00')
        numeric=job('SERIAL',created=('n',serial('2026-10-31T16:04:00')),finished=('n',serial('2026-10-31T17:04:00')))
        self.pair([text,numeric])
        rows=self.store.get_mttr_jobs('2026-10-31','2026-10-31')
        self.assertEqual(rows['total'],2);self.assertTrue(all(r['finishedAt'].startswith('2026-10-31') for r in rows['records']))
        self.assertEqual([r['durationSeconds'] for r in rows['records']],[3600,3600])
        self.assertEqual(self.store.get_mttr_jobs('2026-12-14','2026-12-14')['total'],0)
        audit=self.store.get_mttr_date_audit()
        self.assertEqual(audit['earliestFinishedAt'],'2026-10-31T17:04:00');self.assertEqual(audit['latestFinishedAt'],'2026-10-31T18:04:00')
        self.assertEqual(audit['daily'],[{'date':'2026-10-31','count':2,'totalSeconds':7200}])
        self.assertEqual(audit['latestMappings']['mappings']['job']['finished'],'I')
        self.assertEqual(audit['latestMappings']['filenames'],{'tt':'tt.xlsx','job':'job.xlsx'})
    def test_prior_valid_job_date_remains_visible_after_duplicate_corrected_upload(self):
        self.pair([job(created='2026/12/14 17:04:00',finished='2026/12/14 18:04:00')])
        latest=self.pair([job(created='2026/10/31 17:04:00',finished='2026/10/31 18:04:00')])
        self.assertEqual(latest['sources']['job']['duplicates'],1)
        self.assertEqual(self.store.get_mttr_jobs('2026-10-31','2026-10-31')['total'],0)
        rows=self.store.get_mttr_jobs('2026-12-14','2026-12-14')
        self.assertEqual(rows['records'][0]['jobId'],'J1');self.assertEqual(rows['records'][0]['finishedAt'],'2026-12-14T18:04:00')
        self.assertIn('first valid record',self.store.get_mttr_date_audit()['warning'])
        self.assertIn('original Excel cell text is not retained',self.store.get_mttr_date_audit()['warning'])
    def test_assignee_exact_unassigned_and_tt_join_exclusions(self):
        self.pair([job('J1',person='Alice'),job('J2',person='alice'),job('J3',person=''),job('J4',tid='TT2',person='Alice'),job('J5',tid='UNKNOWN',person='Alice')],[TT_HEADER,tt(),tt('TT2','Power')])
        overall=self.store.get_mttr_jobs('2026-10-19','2026-10-19')
        self.assertEqual(overall['total'],3)
        self.assertEqual(self.store.get_mttr_jobs('2026-10-19','2026-10-19','Alice')['records'][0]['jobId'],'J1')
        self.assertEqual(self.store.get_mttr_jobs('2026-10-19','2026-10-19','')['records'][0]['jobId'],'J3')
        self.assertEqual(self.store.get_mttr_jobs('2026-10-19','2026-10-19',"Alice' OR 1=1--")['total'],0)
        audit=self.store.get_mttr_date_audit();self.assertEqual((audit['storedJobs'],audit['matchedJobs']),(5,3))
        self.assertEqual(audit['daily'][0]['count'],3)
    def test_stable_bounded_pagination(self):
        self.pair([job('J3'),job('J1'),job('J2')])
        pages=[self.store.get_mttr_jobs('2026-10-19','2026-10-19',offset=offset,limit=1) for offset in range(3)]
        self.assertEqual([p['records'][0]['jobId'] for p in pages],['J1','J2','J3'])
        self.assertTrue(all(p['total']==3 and p['limit']==1 for p in pages))
    def test_invalid_ranges_limits_and_v3_requirement(self):
        for call in (lambda:self.store.get_mttr_jobs('2026-10-19','2026-10-19'),self.store.get_mttr_date_audit):
            with self.assertRaises(ApiError) as error:call()
            self.assertEqual(error.exception.status,409)
        self.pair([job()])
        for args in (('2026-10-20','2026-10-19',None,0,100),('2026-02-30','2026-10-19',None,0,100),('2026-10-19','2026-10-19',None,-1,100),('2026-10-19','2026-10-19',None,0,0),('2026-10-19','2026-10-19',None,0,1001)):
            with self.assertRaises(ApiError) as error:self.store.get_mttr_jobs(*args)
            self.assertEqual(error.exception.status,400)
    def test_audit_is_read_only_no_future_deletion_or_filter(self):
        before=self.pair([job(created='2026/12/14 17:04:00',finished='2026/12/14 18:04:00')])
        audit=self.store.get_mttr_date_audit();self.assertEqual(audit['latestFinishedAt'],'2026-12-14T18:04:00')
        self.assertEqual(self.store.get_mttr_jobs('2026-12-14','2026-12-14')['total'],1)
        self.assertEqual(self.store.get_mttr(),before)
    def test_valid_zero_match_audit_has_null_bounds_and_keeps_history(self):
        self.pair([job(tid='UNMATCHED')])
        audit=self.store.get_mttr_date_audit()
        self.assertEqual((audit['storedJobs'],audit['matchedJobs'],audit['daily']),(1,0,[]))
        self.assertIsNone(audit['earliestCreatedAt']);self.assertIsNone(audit['latestFinishedAt'])
    def test_explicit_update_repairs_date_without_increasing_unique_jobs(self):
        self.pair([job(created='2026/12/14 17:04:00',finished='2026/12/14 18:04:00')])
        fields={'ttFile':{'filename':'tt.xlsx','data':workbook([TT_HEADER,tt()])},'jobFile':{'filename':'job.xlsx','data':workbook([JOB_HEADER,job(created='2026/10/31 17:04:00',finished='2026/10/31 18:04:00',person='Corrected')])},'updateExistingJobs':{'value':'true'}}
        repaired=self.store.import_mttr_pair(fields)
        self.assertEqual((repaired['storedJobs'],repaired['totalJobs'],repaired['updatedJobs'],repaired['sources']['job']['addedRows'],repaired['sources']['job']['duplicates']),(1,1,1,0,1))
        self.assertEqual(repaired['duplicatePolicy'],'update')
        self.assertEqual(self.store.get_mttr_jobs('2026-12-14','2026-12-14')['total'],0)
        self.assertEqual(self.store.get_mttr_jobs('2026-10-31','2026-10-31')['records'][0]['assignee'],'Corrected')
        self.assertIn('explicitly updated',self.store.get_mttr_date_audit()['warning'])
        again=self.store.import_mttr_pair(fields);self.assertEqual(again['updatedJobs'],0)
        target=Store(Path(self.tmp.name)/'restored');target.restore(self.store.backup());self.assertEqual(target.get_mttr(),again)
        from job_mttr_import import validate_v3
        validate_v3({k:v for k,v in again.items() if k not in ('updatedJobs','duplicatePolicy')})
    def test_invalid_repair_flag_preserves_existing_records(self):
        before=self.pair([job()])
        fields={'ttFile':{'filename':'tt.xlsx','data':workbook([TT_HEADER,tt()])},'jobFile':{'filename':'job.xlsx','data':workbook([JOB_HEADER,job()])}}
        for bad in ('yes','1','TRUE','',True):
            with self.assertRaises(ApiError):self.store.import_mttr_pair({**fields,'updateExistingJobs':{'value':bad}})
            self.assertEqual(self.store.get_mttr(),before)
    def test_chunk_finish_boolean_update_flag_and_invalid_type_retention(self):
        self.pair([job(created='2026/12/14 17:04:00',finished='2026/12/14 18:04:00')])
        ttdata=workbook([TT_HEADER,tt()]);jobdata=workbook([JOB_HEADER,job(created='2026/10/31 17:04:00',finished='2026/10/31 18:04:00')])
        uploads=self.store.mttr_uploads
        sid=uploads.create({'tt':{'name':'tt.xlsx','size':len(ttdata)},'job':{'name':'job.xlsx','size':len(jobdata)}})['uploadId']
        uploads.append(sid,'tt',0,ttdata);uploads.append(sid,'job',0,jobdata)
        from mttr_uploads import MttrUploadError
        with self.assertRaises(MttrUploadError):uploads.finish(sid,{'updateExistingJobs':'true'},self.store.import_mttr_pair)
        self.assertIn(sid,uploads.sessions)
        result=uploads.finish(sid,{'updateExistingJobs':True},self.store.import_mttr_pair)
        self.assertEqual(result['updatedJobs'],1);self.assertEqual(result['latestDate'],'2026-10-31')

    def test_http_query_validation_and_blank_assignee(self):
        self.pair([job('J1',person=''),job('J2',person='Alice')])
        server=ReportServer(('127.0.0.1',0),self.store);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();url='http://127.0.0.1:'+str(server.server_port)
        try:
            base='/api/mttr/jobs?from=2026-10-19&to=2026-10-19'
            with urlopen(url+base+'&assignee=') as response:self.assertEqual(json.load(response)['records'][0]['jobId'],'J1')
            with urlopen(url+'/api/mttr/date-audit') as response:self.assertEqual(json.load(response)['matchedJobs'],2)
            for path in ('/api/mttr/jobs',base+'&limit=0',base+'&limit=1001',base+'&limit=no',base+'&offset=-1',base+'&from=2026-10-18',base+'&assignee=&assignee=Alice','/api/mttr/jobs?from=2026-10-20&to=2026-10-19'):
                with self.assertRaises(HTTPError) as error:urlopen(url+path)
                self.assertEqual(error.exception.code,400)
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
