"""HTTP contract and persistence for the single-workbook alarm MTTR workflow."""
import csv
import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

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

    def stage(self, data, name='alarms.csv'):
        result = self.call(BASE + '/uploads', 'POST', {'alarm': {'name': name, 'size': len(data)}})
        prefix = BASE + '/uploads/' + result['uploadId']
        mid = len(data) // 2
        for offset, chunk in [(0, data[:mid]), (mid, data[mid:])]:
            self.assertEqual(self.call(prefix + '/alarm?offset=' + str(offset), 'POST', chunk,
                                       'application/octet-stream')['received'], offset + len(chunk))
        return prefix

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
        self.assertEqual(result['totalAlarms'], 2)
        self.assertEqual(result['storedRows'], 3)
        self.assertEqual([(d['date'], d['totalSeconds']) for d in result['days']],
                         [('2026-10-20', 600), ('2026-10-21', 3000)])
        self.assertEqual(result, self.call(BASE))
        refreshed = self.call(BASE + '/allowlist', 'POST', {'allowlist': '26564,26540'})
        self.assertEqual(refreshed['totalAlarms'], 3)
        self.assertEqual(sum(d['totalSeconds'] for d in refreshed['days']), 10800)
        backup = self.store.backup()
        cleared = self.call(BASE, 'DELETE')
        self.assertEqual(cleared['storedRows'], 0)
        self.assertEqual(cleared['allowlist'], refreshed['allowlist'])
        self.store.restore(backup)
        self.assertEqual(self.call(BASE), refreshed)
        self.assertFalse(self.call('/api/state')['hasLegacyMttr'])
        self.assertIsNone(self.call('/api/mttr'))

    def test_excel_reupload_and_invalid_file_do_not_change_ledger(self):
        header = {'B':'Alarm ID','I':'Duration','K':'Occurred','AE':'Job ID'}
        alarm = {'B':26540, 'I':('n',0.5), 'K':'2026/11/03 23:59:00', 'AE':'JOB-A'}
        data = workbook([header, alarm, alarm])
        for index in range(2):
            prefix = self.stage(data, name='alarms.xlsx')
            saved = self.call(prefix + '/import', 'POST', {'allowlist':'26540'})
            self.assertEqual(saved['totalAlarms'], 2)
            self.assertEqual(saved['days'][0]['totalSeconds'], 86400)
            self.assertEqual(saved['lastImport']['duplicateRows'], 2 if index else 0)
        invalid = self.stage(workbook([header, dict(alarm, I=0)]), name='uncleared.xlsx')
        with self.assertRaises(HTTPError) as exc:
            self.call(invalid + '/import', 'POST', {'allowlist':'26564'})
        self.assertEqual(exc.exception.code, 400)
        self.assertEqual(json.load(exc.exception)['details']['lastImport']['zeroDurations'], 1)
        self.assertEqual(self.call(BASE), saved)

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
        self.assertEqual(result['totalAlarms'], 1)
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
