"""AI gateway integration tests. All provider calls use a local fake server."""
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from unittest.mock import patch
import zipfile

from ai_service import AiError, AiService, extract_content, make_prompt, parse_reports
from server import ApiError, ReportServer, Store


FAKE_KEY = 'test-provider-key-no-real-credential'
REPORTS = {'zh': '# FMEMate 项目进展\n\n本期共 3 次使用，1 位可识别活跃用户。browser 对应的实际人数未知。',
           'en': '# FMEMate progress\n\nThere were 3 interactions and 1 identifiable active user. The actual number of people behind browser is unknown.'}
PAYLOAD = {'facts': {'schemaVersion': 1, 'demo': False,
                    'range': {'from': '2026-10-23', 'to': '2026-10-23', 'days': 1, 'scene': 'all'},
                    'totals': {'uses': 3, 'users': 1, 'browserUses': 2}}, 'instructions': 'Write a concise update.'}


class MockProvider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.calls.append({'path': self.path, 'authorization': self.headers.get('Authorization'), 'body': body})
        mode = self.server.mode
        if mode == 'redirect':
            self.send_response(307)
            self.send_header('Location', self.server.base + '/do-not-follow')
            self.end_headers()
            return
        if mode == 'auth_error':
            status, result = 401, {'error': {'message': FAKE_KEY + ' provider private raw data'}}
        elif mode == 'bad_json':
            status, result = 200, {'choices': [{'message': {'content': 'not valid report JSON'}, 'finish_reason': 'stop'}]}
        elif mode == 'truncated':
            status, result = 200, {'choices': [{'message': {'content': json.dumps(REPORTS)}, 'finish_reason': 'length'}]}
        elif mode == 'incomplete':
            status, result = 200, {'status': 'incomplete', 'output': [], 'incomplete_details': {'reason': 'max_output_tokens'}}
        else:
            generated = dict(REPORTS)
            if mode == 'echo_key':
                generated['en'] += ' ' + FAKE_KEY
            content = json.dumps(generated, ensure_ascii=False)
            if mode == 'fenced':
                content = '```json\n' + content + '\n```'
            if self.path.endswith('/responses'):
                result = {'status': 'completed', 'output': [{'type': 'reasoning', 'summary': []},
                          {'type': 'message', 'content': [{'type': 'output_text', 'text': content}]}]}
            else:
                result = {'choices': [{'message': {'content': content}, 'finish_reason': 'stop'}]}
            status = 200
        raw = json.dumps(result, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class AiBackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / 'data')
        self.provider = ThreadingHTTPServer(('127.0.0.1', 0), MockProvider)
        self.provider.calls = []
        self.provider.mode = 'ok'
        self.provider.base = f'http://127.0.0.1:{self.provider.server_port}'
        self.provider_thread = threading.Thread(target=self.provider.serve_forever, daemon=True)
        self.provider_thread.start()
        self.app = ReportServer(('127.0.0.1', 0), self.store)
        self.app_thread = threading.Thread(target=self.app.serve_forever, daemon=True)
        self.app_thread.start()
        self.app_base = f'http://127.0.0.1:{self.app.server_port}'

    def tearDown(self):
        self.app.shutdown()
        self.app.server_close()
        self.provider.shutdown()
        self.provider.server_close()
        self.app_thread.join()
        self.provider_thread.join()
        self.tmp.cleanup()

    def request(self, path, payload=None, headers=None):
        request = Request(self.app_base + path, data=json.dumps(payload).encode() if payload is not None else None,
                          headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as exc:
            response = exc
        with response:
            return response.status, json.loads(response.read())

    def configure(self, api_format='chat_completions'):
        status, result = self.request('/api/ai/config', {'baseUrl': self.provider.base + '/v1', 'apiFormat': api_format,
                                       'model': 'local-test-model', 'apiKey': FAKE_KEY, 'maxOutputTokens': 4096, 'timeoutSeconds': 30})
        self.assertEqual(status, 200)
        self.assertTrue(result['configured'])
        return result

    def test_config_is_server_only_persistent_and_blank_preserves_key(self):
        result = self.configure()
        self.assertNotIn('apiKey', result)
        self.assertNotIn(FAKE_KEY, json.dumps(result))
        self.assertEqual(os.stat(self.store.ai.path).st_mode & 0o777, 0o600)
        reloaded = Store(self.store.root)
        self.assertEqual(reloaded.ai.load()['apiKey'], FAKE_KEY)
        status, result = self.request('/api/ai/config', {'model': 'new-test-model', 'apiKey': ''})
        self.assertEqual(status, 200)
        self.assertTrue(result['hasApiKey'])
        self.assertEqual(self.store.ai.load()['apiKey'], FAKE_KEY)
        self.assertNotIn(FAKE_KEY, json.dumps(self.request('/api/state')[1]))
        status, result = self.request('/api/ai/config', {'clearApiKey': True})
        self.assertFalse(result['hasApiKey'])
        self.assertEqual(self.store.ai.load()['apiKey'], '')

    def test_preview_requires_no_key_and_enforces_data_methodology(self):
        status, result = self.request('/api/ai/preview', PAYLOAD)
        self.assertEqual(status, 200)
        self.assertEqual(set(result), {'system', 'user'})
        self.assertIn('browser', result['system'])
        self.assertIn('MML NEVER', result['system'])
        self.assertIn('untrusted DATA', result['system'])
        self.assertIn('2026-10-23', result['user'])
        self.assertEqual(len(self.provider.calls), 0)
        status, result = self.request('/api/ai/generate', PAYLOAD)
        self.assertEqual(status, 400)
        self.assertEqual(len(self.provider.calls), 0)

    def test_chat_and_responses_generate_both_reports_and_persist_history(self):
        for api_format in ('chat_completions', 'responses'):
            self.configure(api_format)
            status, result = self.request('/api/ai/generate', PAYLOAD)
            self.assertEqual(status, 200, result)
            report = result['report']
            self.assertEqual(report['zh'], REPORTS['zh'])
            self.assertEqual(report['en'], REPORTS['en'])
            self.assertEqual(report['from'], '2026-10-23')
            self.assertFalse(report['demo'])
            self.assertNotIn(FAKE_KEY, json.dumps(report))
            call = self.provider.calls[-1]
            self.assertEqual(call['authorization'], 'Bearer ' + FAKE_KEY)
            self.assertFalse(call['body']['store'])
            self.assertEqual(call['body']['model'], 'local-test-model')
            if api_format == 'responses':
                self.assertEqual(call['path'], '/v1/responses')
                self.assertEqual(call['body']['max_output_tokens'], 4096)
                self.assertIn('facts', call['body']['input'])
            else:
                self.assertEqual(call['path'], '/v1/chat/completions')
                self.assertEqual(call['body']['max_completion_tokens'], 4096)
                self.assertEqual([m['role'] for m in call['body']['messages']], ['system', 'user'])
        status, result = self.request('/api/ai/reports?limit=1&offset=1')
        self.assertEqual(status, 200)
        self.assertEqual(result['total'], 2)
        self.assertEqual(len(result['reports']), 1)
        state = Store(self.store.root).state()
        self.assertEqual(state['aiReportsTotal'], 2)
        self.assertEqual(len(state['aiReports']), 2)

    def test_provider_errors_redirections_and_incomplete_outputs_never_save(self):
        self.configure()
        for mode in ('auth_error', 'redirect', 'bad_json', 'truncated'):
            self.provider.mode = mode
            before = len(self.provider.calls)
            status, result = self.request('/api/ai/generate', PAYLOAD)
            self.assertEqual(status, 502, (mode, result))
            self.assertNotIn(FAKE_KEY, json.dumps(result))
            self.assertNotIn('provider private raw data', json.dumps(result))
            self.assertEqual(len(self.provider.calls), before + 1)
        self.configure('responses')
        self.provider.mode = 'incomplete'
        self.assertEqual(self.request('/api/ai/generate', PAYLOAD)[0], 502)
        self.assertEqual(self.store.get_ai_reports()['total'], 0)

    def test_fenced_json_and_secret_echo_scrubbing(self):
        self.configure()
        for mode in ('fenced', 'echo_key'):
            self.provider.mode = mode
            status, result = self.request('/api/ai/generate', PAYLOAD)
            self.assertEqual(status, 200, result)
            self.assertNotIn(FAKE_KEY, json.dumps(result))
        self.assertIn('[REDACTED]', result['report']['en'])

    def test_validation_and_cross_origin_do_not_call_provider(self):
        self.configure()
        for config in ({'baseUrl': 'https://user:password@example.com/v1'}, {'baseUrl': 'https://example.com/v1?key=abc'},
                       {'baseUrl': 'https://example.com/v1/chat/completions'}, {'baseUrl': 'file:///etc/passwd'},
                       {'timeoutSeconds': 2}, {'maxOutputTokens': True}, {'apiKey': 'abc\nheader'}, {'apiFormat': 'bad'}):
            self.assertEqual(self.request('/api/ai/config', config)[0], 400, config)
        self.assertEqual(self.request('/api/ai/config', {'model': 'test'}, {'Origin': 'https://another.example'})[0], 403)
        for value in ({}, {'facts': {}}, {'facts': {**PAYLOAD['facts'], 'range': {'from': '2026-10-30', 'to': '2026-10-23'}}},
                      {'facts': {**PAYLOAD['facts'], 'demo': 'false'}}, {'facts': {**PAYLOAD['facts'], 'evidence': 'x' * 3000000}}):
            self.assertIn(self.request('/api/ai/generate', value)[0], (400, 413))
        self.assertEqual(len(self.provider.calls), 0)
        self.assertEqual(self.request('/api/ai/reports?limit=500')[0], 400)

    def test_backup_includes_reports_but_excludes_key_and_legacy_restore(self):
        self.configure()
        self.assertEqual(self.request('/api/ai/generate', PAYLOAD)[0], 200)
        backup = self.store.backup()
        with zipfile.ZipFile(io.BytesIO(backup)) as archive:
            self.assertNotIn('ai-config.json', archive.namelist())
            self.assertNotIn(FAKE_KEY.encode(), archive.read('report.db'))
        other = Store(Path(self.tmp.name) / 'other')
        other.ai.save_config({'apiKey': 'other-local-key', 'model': 'other-model'})
        other.restore(backup)
        self.assertEqual(other.get_ai_reports()['reports'][0]['zh'], REPORTS['zh'])
        self.assertEqual(other.ai.load()['apiKey'], 'other-local-key')
        for drop_tables in (('ai_reports',), ('failure_notes',), ('ai_reports', 'failure_notes')):
            legacy = self.rewrite_backup(backup, drop_tables)
            other.restore(legacy)
            self.assertEqual(other.get_ai_reports()['total'], 0 if 'ai_reports' in drop_tables else 1)
            self.assertEqual(other.ai.load()['apiKey'], 'other-local-key')

    def test_restore_rejects_invalid_reports_atomically(self):
        self.configure()
        self.request('/api/ai/generate', PAYLOAD)
        backup = self.store.backup()
        invalid = self.rewrite_backup(backup, (), "UPDATE ai_reports SET dateFrom='bad-date'")
        with self.assertRaises(ApiError):
            self.store.restore(invalid)
        self.assertEqual(self.store.get_ai_reports()['total'], 1)
        self.assertEqual(self.store.ai.load()['apiKey'], FAKE_KEY)

    def rewrite_backup(self, content, drop_tables, sql=None):
        directory = Path(self.tmp.name) / ('legacy-' + str(len(list(Path(self.tmp.name).iterdir()))))
        directory.mkdir()
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            database = directory / 'report.db'
            database.write_bytes(archive.read('report.db'))
            with sqlite3.connect(database) as db:
                for table in drop_tables:
                    db.execute('DROP TABLE ' + table)
                if sql:
                    db.execute(sql)
            result = io.BytesIO()
            with zipfile.ZipFile(result, 'w', zipfile.ZIP_DEFLATED) as new:
                new.writestr('manifest.json', archive.read('manifest.json'))
                new.write(database, 'report.db')
            return result.getvalue()

    def test_timeouts_are_safe_and_response_parsers_reject_refusals(self):
        self.configure()
        with patch('ai_service.build_opener') as opener:
            opener.return_value.open.side_effect = URLError(TimeoutError())
            with self.assertRaises(AiError) as caught:
                self.store.generate_ai_report(PAYLOAD)
            self.assertEqual(caught.exception.status, 504)
        for response, api_format in (({'choices': [{'message': {'refusal': 'No'}, 'finish_reason': 'stop'}]}, 'chat_completions'),
                                     ({'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'refusal'}]}]}, 'responses')):
            with self.assertRaises(AiError):
                extract_content(response, api_format)
        with self.assertRaises(AiError):
            parse_reports('{"zh":"only Chinese"}')
        with self.assertRaises(AiError):
            make_prompt({'facts': {**PAYLOAD['facts'], 'bad': float('nan')}})


if __name__ == '__main__':
    unittest.main(verbosity=2)
