"""HTTP contract and persistence for per-Job MTTR based on eligible alarm durations."""
import csv
import io
import json
import sqlite3
import zipfile
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import alarm_mttr
from server import Store, ReportServer
from mttr_tests import workbook


BASE = '/api/mttr/alarms'


def alarm_sheet(*entries):
    stream = io.StringIO(newline='')
    writer = csv.writer(stream)
    header = [''] * 31
    header[1], header[8], header[10], header[30] = 'Alarm ID', 'Duration', 'Occurred', 'Job ID'
    writer.writerow(header)
    for alarm, duration, occurred, job in entries:
        row = [''] * 31
        row[1], row[8], row[10], row[30] = alarm, duration, occurred, job
        writer.writerow(row)
    return stream.getvalue().encode()


class AlarmHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / 'report')
        self.server = ReportServer(('127.0.0.1', 0), self.store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def call(self, path, method='GET', body=None, content_type='application/json', headers=None):
        if body is not None and content_type == 'application/json':
            body = json.dumps(body).encode()
        req = Request(self.url + path, method=method, data=body,
                      headers={'Content-Type': content_type, **(headers or {})})
        with urlopen(req) as result:
            return json.load(result)

    def stage(self, data, name='alarms.csv', mapping=False):
        route = BASE + ('/job-uploads' if mapping else '/uploads')
        source = 'job' if mapping else 'alarm'
        result = self.call(route, 'POST', {source: {'name': name, 'size': len(data)}})
        prefix = route + '/' + result['uploadId']
        mid = len(data) // 2
        for offset, chunk in [(0, data[:mid]), (mid, data[mid:])]:
            self.assertEqual(self.call(prefix + '/' + source + '?offset=' + str(offset), 'POST', chunk,
                                       'application/octet-stream')['received'], offset + len(chunk))
        return prefix

    def restore_older_schema(self, tables, prepare=None):
        with zipfile.ZipFile(io.BytesIO(self.store.backup())) as bundle:
            manifest = bundle.read('manifest.json')
            path = Path(self.tmp.name) / 'archived.db'
            path.write_bytes(bundle.read('report.db'))
        db = sqlite3.connect(path)
        try:
            with db:
                for name in alarm_mttr.ALARM_TABLES-tables:
                    db.execute('DROP TABLE ' + name)
                if prepare:
                    prepare(db)
        finally:
            db.close()
        archive = io.BytesIO()
        with zipfile.ZipFile(archive,'w') as bundle:
            bundle.writestr('manifest.json', manifest)
            bundle.writestr('report.db', path.read_bytes())
        self.store.restore(archive.getvalue())

    def test_import_allowlist_and_backup_restore(self):
        data = alarm_sheet(
            ('26540', '00:10:00', '2026-10-20 23:59:00', 'JOB-A'),
            ('26540', '00:50:00', '2026-10-21 00:02:00', 'JOB-A'),
            ('26564', '02:00:00', '2026-10-21 02:00:00', 'JOB-B'),
            ('26540', '00:00:00', '2026-10-21 02:01:00', 'JOB-B'),
            ('26540', '05:00:00', '2026-10-21 02:02:00', '   '),
        )
        self.assertFalse(self.call('/api/state')['hasLegacyMttr'])
        result = self.call(self.stage(data) + '/import', 'POST', {'allowlist': '26540'})
        self.assertEqual((result['formatVersion'], result['source']), (5, 'alarm-jobs'))
        self.assertEqual(result['totalAlarms'], 0)
        self.assertEqual(result['totalJobs'], 0)
        self.assertEqual(result['unassignedJobs'], 1)
        self.assertEqual(result['storedRows'], 3)
        self.assertEqual((result['days'],result['personDays'],result['assignees']),([],[],[]))
        self.assertEqual(result, self.call(BASE))
        refreshed = self.call(BASE + '/allowlist', 'POST', {'allowlist': '26564,26540'})
        self.assertEqual((refreshed['totalAlarms'],refreshed['totalJobs'],refreshed['unassignedJobs']), (0,0,2))
        jobs = workbook([{'B':'TT ID','C':'Job ID','AL':'AL person'},
                         {'B':'ignored','C':'JOB-A','AL':'Alice'},
                         {'B':'ignored','C':'JOB-B','AL':'Bob'}])
        refreshed = self.call(self.stage(jobs, 'jobs.xlsx', True) + '/import', 'POST', {})
        self.assertEqual((refreshed['totalAlarms'],refreshed['totalJobs'],refreshed['assignees']), (3,2,['Alice','Bob']))
        self.assertEqual(sum(d['totalSeconds'] for d in refreshed['days']),10200)
        self.assertEqual(refreshed['unassignedJobs'], 0)
        self.assertEqual([(r['assignee'],r['count'],r['totalSeconds']) for r in refreshed['personDays']],
                         [('Alice',1,3000),('Bob',1,7200)])
        backup = self.store.backup()
        cleared = self.call(BASE, 'DELETE')
        self.assertEqual(cleared['storedRows'], 0)
        self.assertEqual(cleared['allowlist'], refreshed['allowlist'])
        self.store.restore(backup)
        restored = self.call(BASE)
        self.assertNotEqual(restored['revision'], refreshed['revision'])
        self.assertEqual({k:v for k,v in restored.items() if k!='revision'},
                         {k:v for k,v in refreshed.items() if k!='revision'})
        self.assertFalse(self.call('/api/state')['hasLegacyMttr'])
        self.assertIsNone(self.call('/api/mttr'))

    def test_excel_reupload_and_invalid_file_do_not_change_ledger(self):
        self.call(self.stage(workbook([{'C':'Job ID','AL':'AL person'},{'C':'JOB-A','AL':'Alice'}]),
                             'jobs.xlsx',True)+'/import','POST',{})
        header = {'B':'Alarm ID','I':'Duration','K':'Occurred','AE':'Job ID'}
        alarm = {'B':26540, 'I':('n',0.5), 'K':'2026/11/03 23:59:00', 'AE':'JOB-A'}
        data = workbook([header, alarm, alarm])
        for index in range(2):
            prefix = self.stage(data, name='alarms.xlsx')
            saved = self.call(prefix + '/import', 'POST', {'allowlist':'26540'})
            self.assertEqual(saved['totalAlarms'], 2)
            self.assertEqual(saved['totalJobs'], 1)
            self.assertEqual(saved['days'][0]['totalSeconds'], 43200)
            self.assertEqual(saved['lastImport']['duplicateRows'], 2 if index else 0)
        invalid = self.stage(workbook([header, dict(alarm, I=0)]), name='uncleared.xlsx')
        with self.assertRaises(HTTPError) as exc:
            self.call(invalid + '/import', 'POST', {'allowlist':'26564'})
        self.assertEqual(exc.exception.code, 400)
        self.assertEqual(json.load(exc.exception)['details']['lastImport']['zeroDurations'], 1)
        self.assertEqual(self.call(BASE), saved)

    def test_mapping_first_and_owner_reassignment_do_not_multiply_jobs(self):
        def owners(name):
            rows=[{'C':'job_id','AL':'AL person'}, {'C':'J1','AL':name}, {'C':'J1','AL':name}]
            return self.call(self.stage(workbook(rows), 'assignments.xlsx', True) + '/import', 'POST', {})
        first=owners('Alice')
        self.assertEqual((first['mappedJobs'],first['totalJobs']), (1,0))
        data=alarm_sheet(('26540','01:00:00','2026-10-19','J1'),
                         ('26540','01:00:00','2026-10-29','J1'),
                         ('26540','00:30:00','2026-10-29','J2'),
                         ('26564','02:00:00','2026-11-01','J1'))
        first=self.call(self.stage(data)+'/import','POST',{'allowlist':'26540'})
        self.assertEqual((first['totalJobs'],first['unassignedJobs']), (1,1))
        self.assertEqual(first['days'],[{'date':'2026-10-19','count':1,'totalSeconds':3600}])
        for _ in range(2):
            second=owners('Bob')
            self.assertEqual(second['days'],first['days'])
            named=[r for r in second['personDays'] if r['assignee']]
            self.assertEqual([(r['assignee'],r['date'],r['count'],r['totalSeconds']) for r in named],
                             [('Bob','2026-10-19',1,3600)])
        updated=self.call(BASE+'/allowlist','POST',{'allowlist':'26564,26540'})
        self.assertEqual(updated['totalJobs'],1)
        self.assertEqual(next(r for r in updated['personDays'] if r['assignee']=='Bob'),
                         {'assignee':'Bob','date':'2026-11-01','count':1,'totalSeconds':7200})

    def test_multiple_job_workbooks_merge_in_order_with_independent_commits(self):
        alarms = alarm_sheet(('26540','00:30:00','2026-10-19','J1'),
                             ('26540','01:00:00','2026-10-19','J1'),
                             ('26540','02:00:00','2026-10-19','J2'),
                             ('26540','03:00:00','2026-10-19','J3'))
        before = self.call(self.stage(alarms) + '/import', 'POST', {'allowlist':'26540'})
        self.assertEqual((before['totalJobs'],before['unassignedJobs']), (0,3))

        def owner_file(filename, pairs):
            rows = [{'C':'Job ID','AL':'AL person'}] + [{'C':j,'AL':p} for j,p in pairs]
            return self.stage(workbook(rows), filename, True) + '/import'

        first = self.call(owner_file('part-1.xlsx',[('J1','Alice'),('J2','Bob')]), 'POST', {})
        self.assertEqual((first['assignees'],first['totalJobs'],first['unassignedJobs']), (['Alice','Bob'],2,1))
        self.assertEqual(first['lastJobImport']['filename'], 'part-1.xlsx')
        # Even a valid reassignment at the start of the bad file must not leak.
        bad = owner_file('conflict.xlsx',[('J1','Wrong owner'),('J3','Carol'),('J3','Other owner')])
        with self.assertRaises(HTTPError) as exc:
            self.call(bad, 'POST', {})
        self.assertEqual(exc.exception.code, 400)
        self.assertEqual(self.call(BASE), first)

        final = self.call(owner_file('part-2.xlsx',[('J1','Dana'),('J3','Carol')]), 'POST', {})
        self.assertEqual((final['lastJobImport']['filename'],final['lastJobImport']['mappedJobs']), ('part-2.xlsx',2))
        self.assertEqual((final['mappedJobs'],final['totalJobs'],final['totalAlarms'],final['unassignedJobs']), (3,3,4,0))
        self.assertEqual(final['assignees'], ['Bob','Carol','Dana'])
        self.assertEqual(final['days'], [{'date':'2026-10-19','count':3,'totalSeconds':21600}])
        details = self.call(BASE + '/job-details', 'POST', {})
        self.assertEqual([(r['jobId'],r['assignee'],r['seconds']) for r in details['rows']],
                         [('J1','Dana',3600),('J2','Bob',7200),('J3','Carol',10800)])

    def test_reject_incomplete_or_invalid_mapping_without_changing_ownership(self):
        raw=workbook([{'C':'Job ID','AL':'AL person'},{'C':'J1','AL':'Owner'}])
        saved=self.call(self.stage(raw,'ok.xlsx',True)+'/import','POST',{})
        bad=self.stage(workbook([{'C':'Job ID','AL':'AL person'},{'C':'', 'AL':'Owner'}]),'invalid.xlsx',True)
        with self.assertRaises(HTTPError) as exc:
            self.call(bad+'/import','POST',{})
        self.assertEqual(exc.exception.code,400)
        self.assertEqual(self.call(BASE),saved)
        self.assertEqual(self.call(bad,'DELETE'),{'ok':True})
        sid=self.call(BASE+'/job-uploads','POST',{'job':{'name':'partial.xlsx','size':9000}})['uploadId']
        prefix=BASE+'/job-uploads/'+sid
        with self.assertRaises(HTTPError) as exc:
            self.call(prefix+'/import','POST',{})
        self.assertEqual(exc.exception.code,409)
        with self.assertRaises(HTTPError) as exc:
            self.call(prefix+'/import','POST',{'allowlist':'26540'})
        self.assertEqual(exc.exception.code,400)
        self.assertEqual(self.call(prefix,'DELETE'),{'ok':True})
        self.assertEqual(self.call(BASE),saved)

    def test_job_details_match_dashboard_with_filters_and_paging(self):
        route = BASE + '/job-details'
        def details(**filters):
            return self.call(route, 'POST', filters)
        def import_alarms(entries):
            return self.call(self.stage(alarm_sheet(*entries)) + '/import', 'POST', {'allowlist':'26540,26564'})

        empty = details()
        self.assertEqual(empty['rows'], [])
        owners = workbook([{'C':'Job ID', 'AL':'AL person'},
                           {'C':'J-A','AL':'Alice'}, {'C':'J-B','AL':'Bob'}, {'C':'J-C','AL':'Bob'},
                           {'C':'never-alarmed','AL':'Catalogue only'}])
        self.call(self.stage(owners,'jobs.xlsx',True) + '/import','POST',{})
        dashboard = import_alarms([
            ('26540','00:10:00','2026-10-21','J-A'),
            ('26564','00:20:00','2026-10-22','J-A'), # selects duration and attribution date
            ('26540','00:40:00','2026-10-22','J-B'),
            ('26540','01:00:00','2026-10-23','J-C'),
            ('26540','01:30:00','2026-10-23','J-D'), # unassigned
            ('99999','10:00:00','2026-10-23','J-A'), # not on allowlist
            ('26540','00:00:00','2026-10-23','J-C'), # uncleared
        ])
        full = details()
        self.assertEqual(full['revision'],dashboard['revision'])
        self.assertNotEqual(full['revision'],empty['revision'])
        self.assertEqual((dashboard['assignees'],dashboard['mappedJobs'],dashboard['unassignedJobs']), (['Alice','Bob'],4,1))
        self.assertEqual((full['total'],full['totalSeconds']), (3,7200))
        self.assertEqual((full['total'],full['totalSeconds']),
                         (dashboard['totalJobs'],sum(d['totalSeconds'] for d in dashboard['days'])))
        self.assertEqual([r['jobId'] for r in full['rows']], ['J-C','J-A','J-B'])
        self.assertEqual([(r['assignee'],r['date'],r['seconds'],r['alarmCount'],r['alarmId'])
                          for r in full['rows'] if r['jobId']=='J-A'],
                         [('Alice','2026-10-22',1200,2,'26564')])
        first, second = details(limit=2), details(limit=2,offset=2)
        self.assertEqual(first['revision'],second['revision'])
        self.assertEqual(first['rows'] + second['rows'],full['rows'])
        self.assertEqual((second['total'],second['totalSeconds'],second['limit'],second['offset']), (3,7200,2,2))
        past = details(limit=2,offset=99)
        self.assertEqual((past['rows'],past['total'],past['totalSeconds']), ([],3,7200))
        for filters, ids, seconds in [
            ({'assignees':None}, ['J-C','J-A','J-B'], 7200),
            ({'assignees':[]}, [], 0),
            ({'assignees':['']}, [], 0),
            ({'assignees':['','Catalogue only','Alice']}, ['J-A'], 1200),
            ({'assignees':['Bob']}, ['J-C','J-B'], 6000),
            ({'assignees':['Bob','Alice','Bob'], 'start':'2026-10-22','end':'2026-10-22'}, ['J-A','J-B'], 3600),
            ({'end':'2026-10-21'}, [], 0),
            ({'start':'2026-10-23'}, ['J-C'], 3600),
        ]:
            with self.subTest(filters=filters):
                page = details(**filters)
                self.assertEqual([r['jobId'] for r in page['rows']],ids)
                self.assertEqual((page['total'],page['totalSeconds']), (len(ids),seconds))

    def test_job_detail_filters_reject_invalid_arguments(self):
        for filters in ({'dateFrom':'2026-10-01'}, {'offset':-1}, {'limit':True}, {'limit':5001},
                        {'start':'2026-02-31'}, {'start':'2026-10-02','end':'2026-10-01'},
                        {'assignees':'Alice'}, {'assignees':[4]}):
            with self.subTest(filters=filters), self.assertRaises(HTTPError) as exc:
                self.call(BASE + '/job-details','POST',filters)
            self.assertEqual(exc.exception.code,400)

    def test_al_policy_scopes_totals_people_and_details_and_survives_restore(self):
        def policy(mode, names):
            return self.call(BASE+'/al-policy','POST',{'mode':mode,'names':names})
        # Save a list before uploading anything: it must also affect future files.
        saved = policy('include',[' ANA ','ana'])
        self.assertEqual(saved['alPolicy'], {'mode':'include','names':['ANA']})
        owners = workbook([{'C':'Job ID','AG':'jb_assign_to','AL':'AL person'},
                           {'C':'A','AG':'Bo','AL':'Ana'}, {'C':'B','AG':'Ana','AL':'Bo'},
                           {'C':'C','AG':'Ana','AL':''}, {'C':'D','AG':'','AL':'Ana'}])
        self.call(self.stage(owners,'assignments.xlsx',True)+'/import','POST',{})
        alarms = alarm_sheet(('26540','00:10:00','2026-10-01','A'),('26540','00:20:00','2026-10-02','A'),
                             ('26540','00:30:00','2026-10-02','B'),('26540','00:50:00','2026-10-02','C'),
                             ('26540','01:00:00','2026-10-03','D'))
        included = self.call(self.stage(alarms)+'/import','POST',{'allowlist':'26540'})
        def check(report, people, ids, alarms, seconds, filtered_out):
            self.assertEqual(report['assignees'],people)
            self.assertEqual((report['totalJobs'],report['totalAlarms'],report['unassignedJobs']), (len(ids),alarms,1))
            self.assertEqual(report['alDiagnostics']['missingALJobs'],1)
            self.assertEqual(report['alDiagnostics']['filteredOutJobs'],filtered_out)
            self.assertEqual(sum(r['totalSeconds'] for r in report['personDays']),seconds)
            details = self.call(BASE+'/job-details','POST',{})
            self.assertEqual((details['revision'],details['total'],details['totalSeconds']),
                             (report['revision'],len(ids),seconds))
            self.assertEqual({r['jobId'] for r in details['rows']},set(ids))
            self.assertEqual({r['assignee'] for r in details['rows']},set(people))
        check(included,['Ana'],['A','D'],3,4800,1)
        # A personal/range lookup cannot reintroduce AL names excluded by the saved list.
        zero = self.call(BASE+'/job-details','POST',{'start':'2026-10-02','assignees':['Bo']})
        self.assertEqual((zero['total'], zero['totalSeconds']),(0,0))
        excluded = policy('exclude',['Ana'])
        self.assertNotEqual(excluded['revision'],included['revision'])
        check(excluded,['Bo'],['B'],1,1800,2)
        self.assertEqual(Store(self.store.root).get_alarm_mttr(), excluded)
        backup = self.store.backup()
        all_people = policy('all',[])
        check(all_people,['Ana','Bo'],['A','B','D'],4,6600,0)
        invalid = [{'mode':'other','names':[]}, {'mode':'include','names':'Ana'}, {'mode':'exclude','names':[]},
                   {'mode':'all','names':[],'groupBy':'AG'}, {'mode':'all'}, {'mode':'include','names':[7]}]
        for args in invalid:
            with self.subTest(args=args), self.assertRaises(HTTPError) as err:
                self.call(BASE+'/al-policy','POST',args)
            self.assertEqual(err.exception.code,400)
        self.assertEqual(self.call(BASE),all_people)
        self.store.restore(backup)
        restored = self.call(BASE)
        self.assertEqual(restored['alPolicy'],excluded['alPolicy'])
        self.assertNotEqual(restored['revision'],excluded['revision'])
        check(restored,['Bo'],['B'],1,1800,2)
        cleared = self.call(BASE,'DELETE')
        self.assertEqual((cleared['totalJobs'],cleared['alPolicy']),(0,excluded['alPolicy']))

    def test_ag_only_archive_preserves_alarm_ledger_but_never_treats_ag_as_al(self):
        alarms = alarm_sheet(('26540','00:25:00','2026-10-20','J1'))
        self.call(self.stage(alarms)+'/import','POST',{'allowlist':'26540'})
        pre_al = {'alarm_mttr_allowlist','alarm_mttr_rows','alarm_mttr_last_import','alarm_mttr_job_owners',
                  'alarm_mttr_job_links','alarm_mttr_job_import','alarm_mttr_job_max','alarm_mttr_revision'}
        def add_legacy_owner(db):
            db.execute('INSERT INTO alarm_mttr_job_owners VALUES(?,?)',('J1','Legacy dispatcher'))
            stats = {'filename':'legacy.xlsx','sheetName':'Sheet1','importedAt':'2026-10-20T12:30:00+00:00',
                     'sourceRows':1,'missingJobIds':0,'missingAssignees':0,'validRows':1,'duplicateRows':0,'mappedJobs':1}
            db.execute('INSERT INTO alarm_mttr_job_import VALUES(1,?)',(json.dumps(stats),))
        self.restore_older_schema(pre_al,add_legacy_owner)
        source = self.call(BASE)
        self.assertEqual((source['mappedJobs'],source['unassignedJobs'],source['totalJobs'],source['storedRows']), (0,1,0,1))
        self.assertEqual(source['alPolicy'],{'mode':'all','names':[]})
        self.assertFalse(source['needsAlarmReimport'])
        ag_only = workbook([{'C':'Job ID','AG':'jb_assign_to'}, {'C':'J1','AG':'Legacy dispatcher'}])
        with self.assertRaises(HTTPError) as exc:
            self.call(self.stage(ag_only,'ag-only.xlsx',True)+'/import','POST',{})
        self.assertEqual(exc.exception.code,400)
        self.assertEqual(self.call(BASE),source)
        al = workbook([{'C':'Job ID','AL':'AL person'}, {'C':'J1','AL':'Field engineer'}])
        fixed = self.call(self.stage(al,'al.xlsx',True)+'/import','POST',{})
        self.assertEqual((fixed['totalJobs'],fixed['totalAlarms'],fixed['assignees']), (1,1,['Field engineer']))
        self.assertEqual(fixed['days'],[{'date':'2026-10-20','count':1,'totalSeconds':1500}])

    def test_v4_backup_does_not_invent_job_ids_and_original_export_relinks_rows(self):
        data=alarm_sheet(('26540','00:05:10','2026-10-19','J1'),('26540','00:07:00','2026-10-21','J1'))
        current=self.call(self.stage(data)+'/import','POST',{'allowlist':'26540'})
        # Recreate the v2.0 SQLite layout exactly: the old ledger held only a
        # row signature/category/date/duration, leaving Job IDs unrecoverable.
        self.restore_older_schema({'alarm_mttr_allowlist','alarm_mttr_rows','alarm_mttr_last_import'})
        archived=self.call(BASE)
        self.assertTrue(archived['needsAlarmReimport'])
        self.assertEqual((archived['totalJobs'],archived['days'],archived['legacyUnlinkedRows']), (0,[],2))
        self.assertEqual(archived['allowlist'],current['allowlist'])
        recovered=self.call(self.stage(data)+'/import','POST',{'allowlist':'26540'})
        self.assertFalse(recovered['needsAlarmReimport'])
        self.assertEqual((recovered['totalJobs'],recovered['legacyUnlinkedRows'],recovered['totalAlarms'],recovered['unassignedJobs']), (0,0,0,1))
        self.assertEqual(recovered['days'],current['days'])
        owners=workbook([{'C':'Job ID','AL':'AL person'},{'C':'J1','AL':'Alice'}])
        restored=self.call(self.stage(owners,'jobs.xlsx',True)+'/import','POST',{})
        self.assertEqual((restored['totalJobs'],restored['totalAlarms'],restored['unassignedJobs']), (1,2,0))
        self.assertEqual(restored['days'],[{'date':'2026-10-21','count':1,'totalSeconds':420}])

    def test_http_rejects_bad_requests_without_consuming_retry(self):
        prefix = self.stage(alarm_sheet(('26540', '12:00:00','2026-10-01', 'J')))
        for body in ({'allowlist': ['26540']}, {'allowlist':'26540','dateColumn':'Q'}):
            with self.assertRaises(HTTPError) as exc:
                self.call(prefix + '/import', 'POST', body)
            self.assertEqual(exc.exception.code, 400)
        with self.assertRaises(HTTPError) as exc:
            self.call(prefix + '/import', 'POST', {'allowlist':'26540'}, headers={'Origin':'https://foreign.invalid'})
        self.assertEqual(exc.exception.code, 403)
        self.assertEqual(self.call(BASE)['storedRows'], 0)
        result = self.call(prefix + '/import', 'POST', {'allowlist':'26540'})
        self.assertEqual((result['storedRows'],result['unassignedJobs'],result['totalAlarms']), (1,1,0))
        with self.assertRaises(HTTPError) as exc:
            self.call(prefix, 'DELETE')
        self.assertEqual(exc.exception.code, 404)

    def test_incomplete_upload_is_cancellable_and_clear_is_isolated(self):
        spec = {'alarm':{'name':'test.xlsx','size':12000}}
        sid = self.call(BASE + '/uploads', 'POST', spec)['uploadId']
        with self.assertRaises(HTTPError) as exc:
            self.call(BASE + '/uploads/' + sid + '/import', 'POST', {'allowlist':'26540'})
        self.assertEqual(exc.exception.code, 409)
        self.assertEqual(self.call(BASE + '/uploads/' + sid, 'DELETE'), {'ok': True})
        with self.store.connect() as db:
            db.execute('INSERT INTO mttr_dataset VALUES(1,?)', ('{"formatVersion":1}',))
        self.call(BASE, 'DELETE')
        self.assertTrue(self.call('/api/state')['hasLegacyMttr'])
        self.assertEqual(self.call('/api/mttr')['formatVersion'], 1)


if __name__ == '__main__':
    unittest.main()
