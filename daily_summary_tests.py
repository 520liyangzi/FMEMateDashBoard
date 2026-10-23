"""Daily archive persistence, conflict protection and backup compatibility tests."""
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import zipfile

from server import ApiError, ReportServer, Store


class DailySummaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temporary.name) / 'data')
        self.server = ReportServer(('127.0.0.1', 0), self.store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def request(self, path, payload=None, method=None, origin=None):
        headers = {'Content-Type': 'application/json'}
        if origin:
            headers['Origin'] = origin
        req = Request(self.base + path, data=json.dumps(payload).encode() if payload is not None else None,
                      headers=headers, method=method)
        try:
            response = urlopen(req, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def create(self, day='2026-10-23', zh='今日推进上线验证。', en='Completed rollout checks today.', title='Daily progress'):
        status, response = self.request('/api/daily-summaries', {'date': day, 'title': title, 'zh': zh, 'en': en, 'expectedUpdatedAt': None})
        self.assertEqual(status, 200, response)
        return response['summary']

    def test_save_reload_update_and_date_order(self):
        first = self.create()
        self.assertEqual(set(first), {'date', 'title', 'zh', 'en', 'createdAt', 'updatedAt'})
        self.assertEqual(first['createdAt'], first['updatedAt'])
        newer = self.create('2026-10-24', zh='明日跟进。', en='', title='')
        persisted = Store(self.store.root).state()['dailySummaries']
        self.assertEqual(persisted, [newer, first])
        status, response = self.request('/api/daily-summaries', {'date': first['date'], 'zh': '修订后的中文\n\n保留段落。',
                                        'en': 'Revised English.', 'expectedUpdatedAt': first['updatedAt']})
        self.assertEqual(status, 200, response)
        updated = response['summary']
        self.assertEqual(updated['createdAt'], first['createdAt'])
        self.assertNotEqual(updated['updatedAt'], first['updatedAt'])
        self.assertEqual(updated['title'], '')
        self.assertEqual(updated['zh'], '修订后的中文\n\n保留段落。')
        self.assertEqual(self.request('/api/state')[1]['dailySummaries'], [newer, updated])

    def test_validation_is_atomic_and_requires_revision_token(self):
        saved = self.create()
        before = self.store.state()['dailySummaries']
        base = {'date': saved['date'], 'title': '', 'zh': 'Changed', 'en': '', 'expectedUpdatedAt': saved['updatedAt']}
        for change in ({'date': '2026-02-30'}, {'date': '10/23/2026'}, {'zh': ' ', 'en': '\n'}, {'zh': 'x' * 100001},
                       {'en': 'x' * 100001}, {'title': 'x' * 201}, {'title': None}, {'zh': 123}, {'expectedUpdatedAt': 123}):
            status, response = self.request('/api/daily-summaries', {**base, **change})
            self.assertEqual(status, 400, (change.keys(), response))
            self.assertEqual(self.store.state()['dailySummaries'], before)
        del base['expectedUpdatedAt']
        self.assertEqual(self.request('/api/daily-summaries', base)[0], 400)
        self.assertEqual(self.store.state()['dailySummaries'], before)

    def test_create_and_update_conflicts_delete_guards_and_origin(self):
        first = self.create()
        payload = {'date': first['date'], 'zh': 'Another edit', 'en': '', 'expectedUpdatedAt': None}
        self.assertEqual(self.request('/api/daily-summaries', payload)[0], 409)
        payload['expectedUpdatedAt'] = first['updatedAt']
        status, response = self.request('/api/daily-summaries', payload)
        self.assertEqual(status, 200, response)
        changed = response['summary']
        self.assertEqual(self.request('/api/daily-summaries', payload)[0], 409)
        stale_query = urlencode({'date': first['date'], 'expectedUpdatedAt': first['updatedAt']})
        self.assertEqual(self.request('/api/daily-summaries?' + stale_query, method='DELETE')[0], 409)
        self.assertEqual(self.request('/api/daily-summaries?date=' + first['date'], method='DELETE')[0], 400)
        query = urlencode({'date': first['date'], 'expectedUpdatedAt': changed['updatedAt']})
        self.assertEqual(self.request('/api/daily-summaries?' + query, method='DELETE', origin='https://elsewhere.example')[0], 403)
        self.assertEqual(self.request('/api/daily-summaries', {**payload, 'expectedUpdatedAt': changed['updatedAt']}, origin='https://elsewhere.example')[0], 403)
        status, response = self.request('/api/daily-summaries?' + query, method='DELETE')
        self.assertEqual(status, 200, response)
        self.assertEqual(response, {'ok': True, 'date': first['date']})
        self.assertEqual(self.request('/api/daily-summaries?' + query, method='DELETE')[0], 404)
        self.assertEqual(self.request('/api/daily-summaries', {**payload, 'expectedUpdatedAt': changed['updatedAt']})[0], 404)
        self.assertEqual(self.store.state()['dailySummaries'], [])

    def test_backup_restores_archive_and_legacy_backup_has_empty_archive(self):
        saved = self.create()
        backup = self.store.backup()
        destination = Store(Path(self.temporary.name) / 'restored')
        destination.restore(backup)
        self.assertEqual(destination.state()['dailySummaries'], [saved])
        legacy = self.rewrite_backup(backup, 'DROP TABLE daily_summaries')
        destination.restore(legacy)
        self.assertEqual(destination.state()['dailySummaries'], [])
        # The table is recreated even when the restored backup predates the feature.
        restored = destination.save_daily_summary({'date': '2026-10-25', 'zh': '', 'en': 'English only', 'expectedUpdatedAt': None})
        self.assertEqual(restored['summary']['en'], 'English only')

    def test_restore_rejects_invalid_archive_content_without_changes(self):
        saved = self.create()
        backup = self.store.backup()
        for sql in ("UPDATE daily_summaries SET date='2026-02-30'", "UPDATE daily_summaries SET zh='',en=' '",
                    "UPDATE daily_summaries SET updatedAt='not-a-timestamp'", "UPDATE daily_summaries SET updatedAt='2026-01-01T00:00:00+00:00'",
                    "ALTER TABLE daily_summaries ADD COLUMN extra TEXT"):
            invalid = self.rewrite_backup(backup, sql)
            with self.assertRaises(ApiError) as caught:
                self.store.restore(invalid)
            self.assertEqual(caught.exception.status, 400)
            self.assertEqual(self.store.state()['dailySummaries'], [saved])

    def test_clear_logs_preserves_the_manually_written_archive(self):
        saved = self.create()
        status, response = self.request('/api/reset', {'confirm': 'DELETE ALL DATA'})
        self.assertEqual(status, 200, response)
        self.assertEqual(self.store.state()['dailySummaries'], [saved])

    def rewrite_backup(self, content, sql):
        with tempfile.TemporaryDirectory(dir=self.temporary.name) as temporary:
            database = Path(temporary) / 'report.db'
            with zipfile.ZipFile(io.BytesIO(content)) as source:
                database.write_bytes(source.read('report.db'))
                with sqlite3.connect(database) as db:
                    db.execute(sql)
                result = io.BytesIO()
                with zipfile.ZipFile(result, 'w', zipfile.ZIP_DEFLATED) as destination:
                    destination.writestr('manifest.json', source.read('manifest.json'))
                    destination.write(database, 'report.db')
                return result.getvalue()


if __name__ == '__main__':
    unittest.main(verbosity=2)
