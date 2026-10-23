"""Integration tests: python backend_tests.py. Uses a temporary database only."""
import base64
import io
import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from server import Store, ReportServer

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=')

def record(task='T-001', **changes):
    row = {'taskId': task, 'clientId': 'CLIENT-1', 'question': 'Help me analyze this ticket?', 'time': '2026-09-22T16:57:00', 'date': '2026-09-22', 'answer': '', 'scene': 'MML'}
    row.update(changes)
    return row

def multipart(fields, files=None):
    boundary = 'report-test-boundary-3f146a'
    result = []
    for name, value in fields.items():
        result.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    for name, (filename, content, mime) in (files or {}).items():
        result.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode() + content + b'\r\n')
    result.append(f'--{boundary}--\r\n'.encode())
    return b''.join(result), 'multipart/form-data; boundary=' + boundary

class BackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.static = self.base / 'dist'
        self.static.mkdir()
        (self.static / 'index.html').write_text('<h1>report</h1>')
        self.store = Store(self.base / 'data')
        self.server = ReportServer(('127.0.0.1', 0), self.store, self.static)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def request(self, path, data=None, method=None, headers=None):
        headers = dict(headers or {})
        if isinstance(data, dict):
            data = json.dumps(data).encode()
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req) as response:
                body = response.read()
                return response.status, json.loads(body) if 'json' in response.headers.get('Content-Type', '') else body
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def import_rows(self, rows, job='job1', complete=True):
        return self.request('/api/import', {'id': job, 'name': 'sample.xlsx', 'records': rows, 'rejected': 2, 'complete': complete})

    def test_dedup_mml_and_persistence(self):
        status, result = self.import_rows([record(), record(answer='Sorry, duplicate changed answer'), record('T-002', answer='Sorry, please try again')])
        self.assertEqual(status, 200)
        self.assertEqual(result, {'added': 2, 'duplicates': 1, 'total': 2})
        rows = self.request('/api/logs')[1]['records']
        self.assertEqual(rows[0]['answer'], '')
        self.assertEqual(rows[0]['scene'], 'MML')
        self.assertIn('Sorry', rows[1]['answer'])
        reopened = Store(self.base / 'data')
        self.assertEqual(reopened.state()['total'], 2)
        self.assertEqual(reopened.state()['history'][0]['rejected'], 2)
        self.assertEqual(self.import_rows([record()], job='job2')[1]['duplicates'], 1)

    def test_validation_is_atomic_and_history_batches(self):
        status, _ = self.import_rows([record(), record('bad', time='2026-02-30T16:57:00', date='2026-02-30')])
        self.assertEqual(status, 400)
        self.assertEqual(self.store.state()['total'], 0)
        self.import_rows([record()], complete=False)
        self.import_rows([record(), record('T-002')], complete=True)
        history = self.store.state()['history'][0]
        self.assertEqual((history['added'], history['duplicates'], history['rejected'], history['complete']), (2, 1, 2, 1))
        self.assertEqual(self.import_rows([record()])[0], 409)

    def test_group_presets_reset(self):
        self.assertEqual(self.request('/api/groups', {'date': '2026-10-22', 'count': 36})[0], 200)
        self.request('/api/groups', {'date': '2026-10-22', 'count': 40})
        self.request('/api/presets', {'presets': ['A?', 'B!', 'A?']})
        state = self.store.state()
        self.assertEqual(state['groups'], [{'date': '2026-10-22', 'count': 40}])
        self.assertEqual(state['presets'], ['A?', 'B!'])
        self.assertEqual(self.request('/api/groups', {'date': '2026-10-23', 'count': -1})[0], 400)
        self.assertEqual(self.request('/api/groups', {'date': '2026-10-23', 'count': True})[0], 400)
        self.import_rows([record()])
        self.assertEqual(self.request('/api/reset', {'confirm': 'no'})[0], 400)
        self.assertEqual(self.request('/api/reset', {'confirm': 'DELETE ALL DATA'})[0], 200)
        self.assertEqual(self.store.state()['total'], 0)
        self.assertEqual(len(self.store.state()['groups']), 1)
        self.assertEqual(self.store.state()['presets'], ['A?', 'B!'])

    def test_feedback_image_and_backup_restore(self):
        fields = {'date': '2026-10-23', 'author': 'Field team', 'text': 'Useful!'}
        data, mime = multipart(fields, {'image': ('screen.png', PNG, 'image/png')})
        status, feedback = self.request('/api/feedback', data, headers={'Content-Type': mime})
        self.assertEqual(status, 201)
        self.assertEqual(self.request(feedback['imageUrl'])[1], PNG)
        data, mime = multipart(fields, {'image': ('malicious.png', b'<script>bad</script>', 'image/png')})
        self.assertEqual(self.request('/api/feedback', data, headers={'Content-Type': mime})[0], 400)
        self.import_rows([record()])
        backup = self.request('/api/backup')[1]
        with zipfile.ZipFile(io.BytesIO(backup)) as z:
            self.assertIn('report.db', z.namelist())
            self.assertIn(feedback['imageUrl'].lstrip('/'), z.namelist())
        self.request('/api/reset', {'confirm': 'DELETE ALL DATA'})
        self.request('/api/feedback?id=' + feedback['id'], method='DELETE')
        data, mime = multipart({}, {'backup': ('backup.zip', backup, 'application/zip')})
        status, result = self.request('/api/restore', data, headers={'Content-Type': mime})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.store.state()['total'], 1)
        self.assertEqual(self.request(feedback['imageUrl'])[1], PNG)
        self.assertTrue((self.store.root / result['backup']).is_file())

    def test_traversal_unknown_api_and_cross_origin(self):
        for path in ('/%2e%2e/server.py', '/uploads/../report.db', '/api/not-found'):
            self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.request('/api/groups', {'date': '2026-10-23', 'count': 1}, headers={'Origin': 'https://other.example'})[0], 403)
        self.assertEqual(self.request('/api/groups', {'date': '2026-10-23', 'count': 1}, headers={'Origin': self.url})[0], 200)
        self.assertEqual(self.request('/')[0], 200)

    def test_restore_rejects_unsafe_archive_without_changes(self):
        self.import_rows([record()])
        raw = io.BytesIO()
        with zipfile.ZipFile(raw, 'w') as z:
            z.writestr('../outside.txt', 'bad')
        data, mime = multipart({}, {'backup': ('bad.zip', raw.getvalue(), 'application/zip')})
        self.assertEqual(self.request('/api/restore', data, headers={'Content-Type': mime})[0], 400)
        self.assertEqual(self.store.state()['total'], 1)

    def rewrite_backup(self, backup, mutate):
        """Edit only an isolated backup copy to test restore's trust boundary."""
        with tempfile.TemporaryDirectory() as temporary:
            db_path = Path(temporary) / 'report.db'
            with zipfile.ZipFile(io.BytesIO(backup)) as archive:
                db_path.write_bytes(archive.read('report.db'))
                with sqlite3.connect(db_path) as db:
                    mutate(db)
                result = io.BytesIO()
                with zipfile.ZipFile(result, 'w', zipfile.ZIP_DEFLATED) as rebuilt:
                    for name in archive.namelist():
                        rebuilt.writestr(name, db_path.read_bytes() if name == 'report.db' else archive.read(name))
            return result.getvalue()

    def restore_backup(self, backup):
        data, mime = multipart({}, {'backup': ('backup.zip', backup, 'application/zip')})
        return self.request('/api/restore', data, headers={'Content-Type': mime})

    def test_failure_notes_save_update_clear_validate_and_persist(self):
        self.assertEqual(self.request('/api/state')[1]['failureNotes'], {})
        self.import_rows([record('failed', answer='SORRY upstream unavailable'), record('normal', answer='OK')])
        reason = "  Upstream timeout\nRetry after gateway recovery.  "
        status, result = self.request('/api/failure-notes', {'taskId': 'failed', 'reason': reason})
        self.assertEqual(status, 200, result)
        self.assertEqual(result, {'ok': True, 'taskId': 'failed', 'reason': reason.strip()})
        self.assertEqual(self.request('/api/state')[1]['failureNotes'], {'failed': reason.strip()})
        self.assertEqual(Store(self.base / 'data').state()['failureNotes']['failed'], reason.strip())
        self.assertEqual(self.import_rows([record('failed', answer='OK')], job='repeat')[1]['duplicates'], 1)
        self.assertEqual(self.store.state()['failureNotes']['failed'], reason.strip())
        self.assertEqual(self.request('/api/failure-notes', {'taskId': 'missing', 'reason': 'x'})[0], 404)
        self.assertEqual(self.request('/api/failure-notes', {'taskId': 'normal', 'reason': 'x'})[0], 400)
        self.assertEqual(self.request('/api/failure-notes', {'taskId': 'failed', 'reason': 'x' * 10001})[0], 400)
        self.assertEqual(self.request('/api/failure-notes', {'taskId': 'failed', 'reason': None})[0], 400)
        self.request('/api/failure-notes', {'taskId': 'failed', 'reason': 'Second investigation result'})
        self.assertEqual(self.store.state()['failureNotes'], {'failed': 'Second investigation result'})
        self.request('/api/failure-notes', {'taskId': 'failed', 'reason': ' \n '})
        self.assertEqual(self.store.state()['failureNotes'], {})
        # Task IDs and reasons are values, including SQL-looking text.
        task_id = "task'); DROP TABLE logs; --"
        self.import_rows([record(task_id, answer='Sorry')], job='quoted')
        self.request('/api/failure-notes', {'taskId': task_id, 'reason': "SQL-looking ' reason"})
        self.assertEqual(self.store.state()['total'], 3)
        self.assertEqual(self.store.state()['failureNotes'][task_id], "SQL-looking ' reason")

    def test_failure_notes_backup_restore_reset_and_legacy_upgrade(self):
        self.import_rows([record('failed', answer='Sorry, tool failed')])
        self.request('/api/failure-notes', {'taskId': 'failed', 'reason': 'Known upstream outage'})
        backup = self.request('/api/backup')[1]
        self.request('/api/reset', {'confirm': 'DELETE ALL DATA'})
        self.assertEqual(self.store.state()['failureNotes'], {})
        self.assertEqual(self.restore_backup(backup)[0], 200)
        self.assertEqual(self.store.state()['failureNotes'], {'failed': 'Known upstream outage'})
        legacy = self.rewrite_backup(backup, lambda db: db.execute('DROP TABLE failure_notes'))
        status, result = self.restore_backup(legacy)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.store.state()['total'], 1)
        self.assertEqual(self.store.state()['failureNotes'], {})
        self.assertEqual(self.request('/api/failure-notes', {'taskId': 'failed', 'reason': 'Saved after legacy restore'})[0], 200)
        # Existing on-disk databases from older versions also gain the table on startup.
        legacy_data = self.base / 'old-data'
        old = Store(legacy_data)
        with old.connect() as db:
            db.execute('DROP TABLE failure_notes')
        self.assertEqual(Store(legacy_data).state()['failureNotes'], {})

    def test_failure_note_restore_rejects_untrusted_contents_without_changes(self):
        self.import_rows([record('failed', answer='Sorry failure'), record('normal', answer='OK')])
        self.request('/api/failure-notes', {'taskId': 'failed', 'reason': 'Keep this live reason'})
        original = self.request('/api/backup')[1]
        mutations = [
            lambda db: db.execute("UPDATE failure_notes SET taskId='missing'"),
            lambda db: db.execute("UPDATE failure_notes SET taskId='normal'"),
            lambda db: db.execute('UPDATE failure_notes SET reason=?', ('x' * 10001,)),
            lambda db: db.execute("UPDATE failure_notes SET updatedAt='not a timestamp'"),
            lambda db: db.execute("ALTER TABLE failure_notes ADD COLUMN unexpected TEXT"),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                broken = self.rewrite_backup(original, mutate)
                self.assertEqual(self.restore_backup(broken)[0], 400)
                self.assertEqual(self.store.state()['failureNotes'], {'failed': 'Keep this live reason'})
                self.assertEqual(self.store.state()['total'], 2)
        def duplicate_ids(db):
            db.execute('ALTER TABLE failure_notes RENAME TO old_notes')
            db.execute('CREATE TABLE failure_notes(taskId TEXT,reason TEXT,updatedAt TEXT)')
            db.execute('INSERT INTO failure_notes SELECT * FROM old_notes')
            db.execute('INSERT INTO failure_notes SELECT * FROM old_notes')
            db.execute('DROP TABLE old_notes')
        self.assertEqual(self.restore_backup(self.rewrite_backup(original, duplicate_ids))[0], 400)
        self.assertEqual(self.store.state()['failureNotes'], {'failed': 'Keep this live reason'})

    def test_offline_asset_bundle(self):
        self.assertEqual(self.request('/api/offline-assets')[0], 400)
        assets = self.static / 'assets'
        assets.mkdir()
        (assets / 'app.js').write_text('console.log("offline");', encoding='utf-8')
        (assets / 'style.css').write_text('body{color:#123}', encoding='utf-8')
        (self.static / 'index.html').write_text('<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/style.css">', encoding='utf-8')
        status, bundle = self.request('/api/offline-assets')
        self.assertEqual(status, 200)
        self.assertEqual(bundle, {'js': 'console.log("offline");', 'css': 'body{color:#123}'})
        (self.static / 'index.html').write_text('<script src="/../server.py"></script>', encoding='utf-8')
        self.assertEqual(self.request('/api/offline-assets')[0], 400)
        (self.static / 'index.html').write_text('<script src="https://example.com/third-party.js"></script>', encoding='utf-8')
        self.assertEqual(self.request('/api/offline-assets')[0], 400)

if __name__ == '__main__':
    unittest.main(verbosity=2)
