"""Arbitrary MTTR duration limits use exact elapsed durations, inclusively."""
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


class DurationFilterTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.store=Store(Path(self.tmp.name)/'data')
    def tearDown(self):self.tmp.cleanup()
    def pair(self,jobs,tts=None,update=False):
        return self.store.import_mttr_pair({'ttFile':{'filename':'tt.xlsx','data':workbook(tts or [TT_HEADER,tt()])},'jobFile':{'filename':'job.xlsx','data':workbook([JOB_HEADER]+jobs)},'updateExistingJobs':{'value':'true' if update else 'false'}})
    def mixed(self):
        return self.pair([
            job('ZERO',created='2026/10/19 03:00',finished='2026/10/19 03:00',person=''),
            job('UNDER',created='2026/10/19 01:00:00',finished='2026/10/19 01:29:59',person='Alice'),
            job('AT',created='2026/10/19 01:00:00',finished='2026/10/19 01:30:00',person='Alice'),
            job('OVER',created='2026/10/19 01:00',finished='2026/10/19 09:00',person='Bob'),
            job('OVER2',created='2026/10/19 01:00',finished='2026/10/19 09:00',person='Bob'),
            job('MIDNIGHT',created='2026/10/18 23:59',finished='2026/10/19 00:01',person='Alice'),
            job('OTHERDAY',created='2026/10/20 01:00',finished='2026/10/20 03:00',person='Bob'),
            job('INELIGIBLE',tid='TT2',person='Alice'),job('UNKNOWN',tid='UNKNOWN')
        ],[TT_HEADER,tt(),tt('TT2','Power')])
    def strip_groups(self):
        with self.store.connect() as db:
            value=json.loads(db.execute('SELECT data FROM mttr_dataset').fetchone()[0]);value.pop('durationGroups')
            db.execute('UPDATE mttr_dataset SET data=?',(json.dumps(value),))
        return value
    def test_groups_are_exact_compressed_eligible_durations_and_validate(self):
        data=self.mixed();validate_v3(data)
        self.assertEqual((data['storedJobs'],data['totalJobs']),(9,7))
        groups=data['durationGroups'];self.assertEqual(len(groups),6)
        self.assertIn({'date':'2026-10-19','assignee':'Bob','durationSeconds':28800,'count':2,'sameDay':True},groups)
        self.assertIn({'date':'2026-10-19','assignee':'Alice','durationSeconds':1799,'count':1,'sameDay':True},groups)
        self.assertIn({'date':'2026-10-19','assignee':'Alice','durationSeconds':120,'count':1,'sameDay':False},groups)
    def test_limit_excludes_equal_boundary_and_supports_decimal_hours(self):
        self.mixed()
        records=self.store.get_mttr_jobs('2026-10-19','2026-10-19',max_hours=.5)
        self.assertEqual({r['jobId'] for r in records['records']},{'ZERO','UNDER','MIDNIGHT'})
        self.assertEqual(records['total'],3)
        eight=self.store.get_mttr_jobs('2026-10-19','2026-10-19',max_hours=8)
        self.assertEqual({r['jobId'] for r in eight['records']},{'ZERO','UNDER','AT','MIDNIGHT'})
        self.assertEqual(self.store.get_mttr_jobs('2026-10-20','2026-10-20',max_hours=2)['total'],0)
    def test_combined_calendar_filter_assignee_pagination_and_history_are_consistent(self):
        original=self.mixed()
        page=self.store.get_mttr_jobs('2026-10-19','2026-10-19',max_hours=.5,exclude_cross_day=True,limit=1)
        self.assertEqual((page['total'],len(page['records'])),(2,1))
        second=self.store.get_mttr_jobs('2026-10-19','2026-10-19',max_hours=.5,exclude_cross_day=True,limit=1,offset=1)
        self.assertNotEqual(page['records'][0]['jobId'],second['records'][0]['jobId'])
        self.assertEqual(self.store.get_mttr_jobs('2026-10-19','2026-10-19','Alice',max_hours=.5,exclude_cross_day=True)['records'][0]['jobId'],'UNDER')
        self.assertEqual(self.store.get_mttr_jobs('2026-10-19','2026-10-19','',max_hours=.5)['records'][0]['jobId'],'ZERO')
        self.assertEqual(self.store.get_mttr_jobs('2026-10-19','2026-10-19','Bob',max_hours=8)['total'],0)
        self.assertEqual(self.store.get_mttr_jobs('2026-10-19','2026-10-20')['total'],7)
        self.assertEqual(self.store.get_mttr_date_audit()['matchedJobs'],7)
        self.assertEqual(self.store.get_mttr(),original)
    def test_legacy_v3_enrichment_is_read_only_and_requires_no_reimport(self):
        original=self.mixed();old=self.strip_groups();validate_v3(old)
        self.assertEqual(Store(self.store.root).get_mttr(),original)
        with self.store.connect() as db:self.assertNotIn('durationGroups',json.loads(db.execute('SELECT data FROM mttr_dataset').fetchone()[0]))
    def test_new_and_old_backups_roundtrip(self):
        original=self.mixed();target=Store(Path(self.tmp.name)/'target');target.restore(self.store.backup())
        self.assertEqual(target.get_mttr(),original)
        self.strip_groups();old_target=Store(Path(self.tmp.name)/'old-target');old_target.restore(self.store.backup())
        self.assertEqual(old_target.get_mttr(),original)
    def test_groups_with_correct_totals_but_different_durations_are_rejected_by_ledger(self):
        original=self.mixed();backup=self.store.backup();dbpath=Path(self.tmp.name)/'bad.db'
        with zipfile.ZipFile(io.BytesIO(backup)) as archive:dbpath.write_bytes(archive.read('report.db'))
        with sqlite3.connect(dbpath) as db:
            value=json.loads(db.execute('SELECT data FROM mttr_dataset').fetchone()[0])
            for group in value['durationGroups']:
                if group['durationSeconds']==1799:group['durationSeconds']=1798
                elif group['durationSeconds']==1800:group['durationSeconds']=1801
            validate_v3(value)
            db.execute('UPDATE mttr_dataset SET data=?',(json.dumps(value),))
        out=io.BytesIO()
        with zipfile.ZipFile(out,'w') as archive:
            archive.writestr('manifest.json',json.dumps({'format':'fmemate-report-backup','version':1}));archive.write(dbpath,'report.db')
        with self.assertRaises(ApiError):self.store.restore(out.getvalue())
        self.assertEqual(self.store.get_mttr(),original)
    def test_bad_group_shape_values_order_and_subset_are_rejected(self):
        original=self.mixed();groups=original['durationGroups']
        bads=[None,{},groups[::-1],groups+[groups[-1]],[]]
        for key,bad_value in (('sameDay',1),('count',True),('count',0),('durationSeconds',float('nan')),('durationSeconds',float('inf')),('durationSeconds',-1),('date','2026-13-01')):
            modified=copy.deepcopy(groups);modified[0][key]=bad_value;bads.append(modified)
        for bad in bads:
            with self.assertRaises((MttrImportError,ValueError)):validate_v3({**original,'durationGroups':bad})
    def test_empty_eligible_set_and_updates_recompute_groups(self):
        data=self.pair([job('X',tid='UNKNOWN')]);self.assertEqual(data['durationGroups'],[]);validate_v3(data)
        data=self.mixed()
        corrected=self.pair([job('AT',created='2026/10/19 01:00',finished='2026/10/19 01:10',person='Alice')],update=True)
        self.assertEqual(corrected['totalJobs'],7)
        self.assertEqual(self.store.get_mttr_jobs('2026-10-19','2026-10-19',max_hours=.5)['total'],4)
    def test_store_rejects_invalid_limits_instead_of_silently_dropping_filter(self):
        self.mixed()
        for value in (True,False,'8',0,-1,float('nan'),float('inf'),float('-inf'),1e308,10**1000):
            with self.assertRaises(ApiError):self.store.get_mttr_jobs('2026-10-19','2026-10-19',max_hours=value)
    def test_http_numeric_validation_and_combined_filters(self):
        self.mixed();server=ReportServer(('127.0.0.1',0),self.store)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base='http://127.0.0.1:'+str(server.server_port)+'/api/mttr/jobs?from=2026-10-19&to=2026-10-19'
        try:
            for suffix,total in (('',6),('&maxHours=.5',3),('&maxHours=0.5&excludeCrossDay=true',2),('&maxHours=8',4),('&maxHours=8e0',4),('&maxHours=8&assignee=',1)):
                with urlopen(base+suffix) as response:self.assertEqual(json.load(response)['total'],total)
            for suffix in ('','0','-1','NaN','Infinity','1e309','1e308','0x8','false','8&maxHours=9'):
                with self.assertRaises(HTTPError) as error:urlopen(base+'&maxHours='+suffix)
                self.assertEqual(error.exception.code,400)
        finally:server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()
