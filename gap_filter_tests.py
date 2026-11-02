"""Assignee MTTR gaps use a fixed, symmetric, period-aware cohort."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen
from server import Store,ReportServer,ApiError
from job_mttr_tests import TT_HEADER,JOB_HEADER,tt,job,workbook

BASE={'from':'2026-10-19','to':'2026-10-19'}
CURRENT={'from':'2026-10-26','to':'2026-10-26'}

def timed(jid,person,hours,day='2026/10/19'):
    whole=int(hours);minutes=round((hours-whole)*60)
    return job(jid,created=day+' 00:00:00',finished=f'{day} {whole:02d}:{minutes:02d}:00',person=person)

class GapFilterTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.store=Store(Path(self.tmp.name)/'data')
    def tearDown(self):self.tmp.cleanup()
    def pair(self,jobs):
        return self.store.import_mttr_pair({'ttFile':{'filename':'tt.xlsx','data':workbook([TT_HEADER,tt()])},'jobFile':{'filename':'job.xlsx','data':workbook([JOB_HEADER]+jobs)}})
    def mixed(self):
        jobs=[]
        for person,base,current in [('Alice',1,10),('Bob',10,1),('Equal',10,2),('Keep',5,2),('Zero',0,8),('',1,10)]:
            jobs.extend([timed(person+'-B',person,base),timed(person+'-C',person,current,'2026/10/26')])
        jobs.extend([timed('Missing-B','Missing',1),timed('Alice-OLD','Alice',1,'2026/10/18')])
        return self.pair(jobs)
    def audit(self,**kwargs):
        return self.store.get_mttr_jobs('2026-10-19','2026-10-26',gap_hours=8,baseline=BASE,current=CURRENT,**kwargs)
    def test_gap_is_absolute_inclusive_and_missing_or_unassigned_are_retained(self):
        original=self.mixed();result=self.audit()
        self.assertEqual({r['jobId'] for r in result['records']},{'Keep-B','Keep-C','Missing-B','-B','-C'})
        self.assertEqual(result['total'],5)
        self.assertEqual(self.store.get_mttr(),original)
        self.assertEqual(self.store.get_mttr_date_audit()['matchedJobs'],14)
        self.assertEqual(self.store.get_mttr_jobs('2026-10-19','2026-10-26')['total'],13)
    def test_selected_person_and_detail_dates_do_not_change_cohort(self):
        self.mixed()
        self.assertEqual(self.audit(assignee='Alice')['total'],0)
        self.assertEqual(self.audit(assignee='Keep')['total'],2)
        self.assertEqual(self.audit(assignee='')['total'],2)
        self.assertEqual(self.store.get_mttr_jobs('2026-10-26','2026-10-26',gap_hours=8,baseline=BASE,current=CURRENT)['total'],2)
        self.assertEqual(self.store.get_mttr_jobs('2026-10-18','2026-10-18',gap_hours=8,baseline=BASE,current=CURRENT)['total'],0)
        page=self.audit(limit=2,offset=2);self.assertEqual((page['total'],len(page['records'])),(5,2))
    def test_zero_baseline_can_be_excluded_without_percentage_availability(self):
        self.pair([timed('Z-B','Zero',0),timed('Z-C','Zero',8,'2026/10/26')])
        self.assertEqual(self.audit()['total'],0)
        self.assertEqual(self.store.get_mttr_jobs('2026-10-19','2026-10-26',gap_hours=8.1,baseline=BASE,current=CURRENT)['total'],2)
    def test_decimal_hours_equal_boundary(self):
        self.pair([timed('D-B','Decimal',1),timed('D-C','Decimal',1.5,'2026/10/26')])
        self.assertEqual(self.store.get_mttr_jobs('2026-10-19','2026-10-26',gap_hours=.5,baseline=BASE,current=CURRENT)['total'],0)
        self.assertEqual(self.store.get_mttr_jobs('2026-10-19','2026-10-26',gap_hours=.5001,baseline=BASE,current=CURRENT)['total'],2)
    def test_job_filters_are_applied_before_fixed_gap_comparison(self):
        self.pair([timed('W-B1','Weighted',4),timed('W-B2','Weighted',20),timed('W-C','Weighted',4,'2026/10/26')])
        self.assertEqual(self.audit()['total'],0)
        self.assertEqual(self.audit(max_hours=10)['total'],2)
        # Crossing midnight is excluded before means; no baseline then means
        # that the current-period Job cannot establish a two-period gap.
        self.pair([job('X-B',created='2026/10/18 12:00',finished='2026/10/19 00:00',person='Cross'),timed('X-C','Cross',2,'2026/10/26')])
        self.assertNotIn('X-C',{r['jobId'] for r in self.audit()['records']})
        self.assertIn('X-C',{r['jobId'] for r in self.audit(exclude_cross_day=True)['records']})
        self.assertIn('X-C',{r['jobId'] for r in self.audit(max_hours=8)['records']})
    def test_changed_or_overlapping_periods_recalculate_cohort(self):
        self.mixed()
        identical=self.store.get_mttr_jobs('2026-10-19','2026-10-26',gap_hours=8,baseline=BASE,current=BASE)
        self.assertEqual(identical['total'],13)
        no_prior=self.store.get_mttr_jobs('2026-10-19','2026-10-26',gap_hours=8,baseline={'from':'2026-10-01','to':'2026-10-01'},current=CURRENT)
        self.assertEqual(no_prior['total'],13)
    def test_store_validation_rejects_invalid_gap_or_incomplete_periods(self):
        self.mixed()
        for value in (True,False,'8',0,-1,float('nan'),float('inf'),1e308,10**1000):
            with self.assertRaises(ApiError):self.store.get_mttr_jobs(BASE['from'],CURRENT['to'],gap_hours=value,baseline=BASE,current=CURRENT)
        for period in (None,{}, {'from':'2026-10-20','to':'2026-10-19'}, {'from':'2026-02-30','to':'2026-03-01'}, {'from':BASE['from'],'to':BASE['to'],'extra':1}):
            with self.assertRaises(ApiError):self.store.get_mttr_jobs(BASE['from'],CURRENT['to'],gap_hours=8,baseline=period,current=CURRENT)
        with self.assertRaises(ApiError):self.store.get_mttr_jobs(BASE['from'],CURRENT['to'],baseline=BASE)
    def test_http_validation_and_combined_scope(self):
        self.mixed();server=ReportServer(('127.0.0.1',0),self.store)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base='http://127.0.0.1:'+str(server.server_port)+'/api/mttr/jobs?from=2026-10-19&to=2026-10-26'
        dates='&baselineFrom=2026-10-19&baselineTo=2026-10-19&currentFrom=2026-10-26&currentTo=2026-10-26'
        try:
            for suffix,total in (('',13),('&gapHours=8'+dates,5),('&gapHours=8e0'+dates+'&assignee=Alice',0),('&gapHours=8'+dates+'&assignee=',2),('&gapHours=8'+dates+'&maxHours=8&excludeCrossDay=true',8)):
                with urlopen(base+suffix) as response:self.assertEqual(json.load(response)['total'],total)
            for value in ('','0','-1','NaN','Infinity','1e309','1e308','0x8','8&gapHours=9'):
                with self.assertRaises(HTTPError) as error:urlopen(base+'&gapHours='+value+dates)
                self.assertEqual(error.exception.code,400)
            for suffix in ('&gapHours=8',dates, '&gapHours=8'+dates.replace('2026-10-26&currentTo','bad&currentTo'), '&gapHours=8'+dates+'&currentTo=2026-10-27'):
                with self.assertRaises(HTTPError) as error:urlopen(base+suffix)
                self.assertEqual(error.exception.code,400)
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
