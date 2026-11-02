"""Same-calendar-day MTTR views preserve the complete, deduplicated ledger."""
import copy
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen
import zipfile
from server import Store,ReportServer,ApiError
from job_mttr_import import validate_v3
from mttr_import import MttrImportError
from job_mttr_tests import TT_HEADER,JOB_HEADER,tt,job,workbook


class CrossDayTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.store=Store(Path(self.tmp.name)/'data')
    def tearDown(self):self.tmp.cleanup()
    def pair(self,jobs,tts=None,update=False):
        return self.store.import_mttr_pair({'ttFile':{'filename':'tt.xlsx','data':workbook(tts or [TT_HEADER,tt()])},'jobFile':{'filename':'job.xlsx','data':workbook([JOB_HEADER]+jobs)},'updateExistingJobs':{'value':'true' if update else 'false'}})
    def mixed(self):
        return self.pair([
            job('SAME',created='2026/10/19 01:00',finished='2026/10/19 05:00',person='Alice'),
            job('MIDNIGHT',created='2026/10/18 23:59',finished='2026/10/19 00:01',person='Alice'),
            job('LONG',created='2026/10/17 10:00',finished='2026/10/19 10:00',person='Bob'),
            job('ZERO',created='2026/10/19 03:00',finished='2026/10/19 03:00',person=''),
            job('INELIGIBLE',tid='TT2',person='Alice'),job('UNKNOWN',tid='UNKNOWN')
        ],[TT_HEADER,tt(),tt('TT2','Power')])
    def strip_same_day(self):
        with self.store.connect() as db:
            value=json.loads(db.execute('SELECT data FROM mttr_dataset').fetchone()[0]);value.pop('sameDay')
            db.execute('UPDATE mttr_dataset SET data=?',(json.dumps(value),))
        return value
    def test_same_day_is_calendar_not_less_than_24_hours(self):
        data=self.mixed()
        self.assertEqual((data['storedJobs'],data['totalJobs']),(6,4))
        self.assertEqual(data['sameDay']['days'],[{'date':'2026-10-19','count':2,'totalSeconds':14400}])
        self.assertEqual(data['sameDay']['personDays'],[{'assignee':'','date':'2026-10-19','count':1,'totalSeconds':0},{'assignee':'Alice','date':'2026-10-19','count':1,'totalSeconds':14400}])
        self.assertEqual(data['days'][0]['totalSeconds'],187320)
        validate_v3(data)
    def test_detail_filter_assignee_pagination_and_raw_audit(self):
        original=self.mixed()
        page=self.store.get_mttr_jobs('2026-10-19','2026-10-19',exclude_cross_day=True,limit=1)
        self.assertEqual((page['total'],page['records'][0]['jobId']),(2,'ZERO'))
        next_page=self.store.get_mttr_jobs('2026-10-19','2026-10-19',exclude_cross_day=True,offset=1,limit=1)
        self.assertEqual(next_page['records'][0]['jobId'],'SAME')
        self.assertEqual(self.store.get_mttr_jobs('2026-10-19','2026-10-19','Alice',exclude_cross_day=True)['total'],1)
        self.assertEqual(self.store.get_mttr_jobs('2026-10-19','2026-10-19','',exclude_cross_day=True)['records'][0]['jobId'],'ZERO')
        self.assertEqual(self.store.get_mttr_jobs('2026-10-19','2026-10-19')['total'],4)
        self.assertEqual(self.store.get_mttr_date_audit()['matchedJobs'],4)
        self.assertEqual(self.store.get_mttr(),original)
        with self.assertRaises(ApiError):self.store.get_mttr_jobs('2026-10-19','2026-10-19',exclude_cross_day='true')
    def test_old_v3_read_enrichment_is_read_only_and_needs_no_reimport(self):
        original=self.mixed();old=self.strip_same_day();validate_v3(old)
        self.assertEqual(Store(self.store.root).get_mttr(),original)
        with self.store.connect() as db:self.assertNotIn('sameDay',json.loads(db.execute('SELECT data FROM mttr_dataset').fetchone()[0]))
    def test_all_crossing_jobs_produce_an_empty_available_subset(self):
        data=self.pair([job('CROSS',created='2026/10/18 23:59',finished='2026/10/19 00:01')])
        self.assertEqual(data['sameDay'],{'days':[],'personDays':[]});validate_v3(data)
        self.assertEqual(data['totalJobs'],1)
        self.assertEqual(self.store.get_mttr_jobs('2026-10-19','2026-10-19',exclude_cross_day=True)['total'],0)
    def test_backup_roundtrip_and_old_backup_are_supported(self):
        original=self.mixed()
        target=Store(Path(self.tmp.name)/'target');target.restore(self.store.backup())
        self.assertEqual(target.get_mttr(),original)
        self.strip_same_day()
        old_target=Store(Path(self.tmp.name)/'old-target');old_target.restore(self.store.backup())
        self.assertEqual(old_target.get_mttr(),original)
    def test_valid_but_wrong_same_day_backup_rejected_atomically(self):
        original=self.mixed();backup=self.store.backup();dbpath=Path(self.tmp.name)/'bad.db'
        with zipfile.ZipFile(io.BytesIO(backup)) as archive:dbpath.write_bytes(archive.read('report.db'))
        with sqlite3.connect(dbpath) as db:
            value=json.loads(db.execute('SELECT data FROM mttr_dataset').fetchone()[0])
            value.pop('durationGroups',None) # Isolate same-day ledger validation.
            value['sameDay']={'days':[],'personDays':[]};validate_v3(value)
            db.execute('UPDATE mttr_dataset SET data=?',(json.dumps(value),))
        out=io.BytesIO()
        with zipfile.ZipFile(out,'w') as archive:
            archive.writestr('manifest.json',json.dumps({'format':'fmemate-report-backup','version':1}));archive.write(dbpath,'report.db')
        with self.assertRaises(ApiError):self.store.restore(out.getvalue())
        self.assertEqual(self.store.get_mttr(),original)
    def test_same_day_validation_rejects_bad_shape_or_inconsistent_subset(self):
        original=self.mixed()
        bads=[{'days':[]}, {'days':'bad','personDays':[]}, {'days':[],'personDays':original['sameDay']['personDays']}]
        excessive=copy.deepcopy(original['sameDay']);excessive['days'][0]['count']=10;bads.append(excessive)
        for bad in bads:
            with self.assertRaises(MttrImportError):validate_v3({**original,'sameDay':bad})
    def test_reclassification_and_explicit_updates_recompute_same_day(self):
        original=self.mixed()
        repaired=self.pair([job('MIDNIGHT',created='2026/10/19 00:00',finished='2026/10/19 00:01')],update=True)
        self.assertEqual((repaired['totalJobs'],repaired['sameDay']['days'][0]['count']),(4,3))
        reclassified=self.pair([job('OPEN',status='OPEN')],[TT_HEADER,tt('TT2')])
        self.assertEqual((reclassified['totalJobs'],reclassified['sameDay']['days'][0]['count']),(5,4))
        self.assertEqual(original['storedJobs'],reclassified['storedJobs'])
    def test_http_boolean_validation_and_default_complete_view(self):
        self.mixed();server=ReportServer(('127.0.0.1',0),self.store)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base='http://127.0.0.1:'+str(server.server_port)+'/api/mttr/jobs?from=2026-10-19&to=2026-10-19'
        try:
            for suffix,total in (('',4),('&excludeCrossDay=false',4),('&excludeCrossDay=true',2),('&excludeCrossDay=true&assignee=',1)):
                with urlopen(base+suffix) as response:self.assertEqual(json.load(response)['total'],total)
            for suffix in ('yes','TRUE','1','','true&excludeCrossDay=false'):
                with self.assertRaises(HTTPError) as error:urlopen(base+'&excludeCrossDay='+suffix)
                self.assertEqual(error.exception.code,400)
        finally:server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()
