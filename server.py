#!/usr/bin/env python3
"""FMEMate local report server. Python 3.10+, standard library only."""
from __future__ import annotations
import argparse
from contextlib import contextmanager, closing
import io
import json
import mimetypes
import math
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import uuid
import zipfile
from datetime import date, datetime, timedelta, timezone
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
from ai_service import AiError, AiService, make_prompt
from mttr_import import stage_mttr, finish_dataset, aggregate_tickets, validate_dataset, MttrImportError

ROOT = Path(__file__).resolve().parent
APP_VERSION = '1.8.2'
DEFAULT_PRESETS = ['Help me analyze this ticket', 'Which cell is faulty?']
LOG_FIELDS = ['taskId', 'clientId', 'question', 'time', 'date', 'answer', 'scene']
IMAGE_NAME = re.compile(r'^[0-9a-f]{32}\.(png|jpg|gif|webp)$')
MAX_BODY = 128 * 1024 * 1024
MAX_IMAGE = 10 * 1024 * 1024
SCHEMA = """
CREATE TABLE IF NOT EXISTS logs (taskId TEXT PRIMARY KEY, clientId TEXT NOT NULL, question TEXT NOT NULL, time TEXT NOT NULL, date TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', scene TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS logs_date ON logs(date);
CREATE INDEX IF NOT EXISTS logs_client ON logs(clientId);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS groups (date TEXT PRIMARY KEY, count INTEGER NOT NULL CHECK(count>=0));
CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, date TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, image TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS failure_notes (taskId TEXT PRIMARY KEY, reason TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_reports (id TEXT PRIMARY KEY, createdAt TEXT NOT NULL, dateFrom TEXT NOT NULL, dateTo TEXT NOT NULL, scene TEXT NOT NULL, model TEXT NOT NULL, demo INTEGER NOT NULL, zh TEXT NOT NULL, en TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS daily_summaries (date TEXT PRIMARY KEY, title TEXT NOT NULL, zh TEXT NOT NULL, en TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS site_visits (id TEXT PRIMARY KEY, date TEXT NOT NULL, site TEXT NOT NULL, description TEXT NOT NULL, photos TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mttr_tickets (ticketId TEXT PRIMARY KEY, createdAt TEXT NOT NULL, closedAt TEXT NOT NULL, durationSeconds REAL NOT NULL);
CREATE TABLE IF NOT EXISTS mttr_dataset (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL, added INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0);
"""

class ApiError(Exception):
    def __init__(self, status, message, details=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.details = details

def require_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ApiError(400, 'Invalid date; use YYYY-MM-DD.')
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ApiError(400, 'Invalid calendar date.')
    return value

def require_string(value, field, max_length=2000000, required=False):
    if not isinstance(value, str) or len(value) > max_length or (required and not value.strip()):
        raise ApiError(400, f'Invalid {field}.')
    return value

def validate_log(row):
    if not isinstance(row, dict):
        raise ApiError(400, 'Each record must be an object.')
    result = {}
    for field in LOG_FIELDS:
        value = row.get(field, '' if field in ('answer', 'scene') else None)
        result[field] = require_string(value, field, required=field not in ('answer', 'scene'))
    for field in ('taskId', 'clientId'):
        result[field] = result[field].strip()
        if len(result[field]) > 1000:
            raise ApiError(400, f'{field} is too long.')
    require_date(result['date'])
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}', result['time']):
        raise ApiError(400, 'Record time must use YYYY-MM-DDTHH:mm:ss.')
    try:
        datetime.fromisoformat(result['time'])
    except ValueError:
        raise ApiError(400, 'Invalid record time.')
    if result['time'][:10] != result['date']:
        raise ApiError(400, 'Record date and time do not match.')
    return result

def validate_presets(values):
    if not isinstance(values, list) or len(values) > 10000:
        raise ApiError(400, 'Presets must be an array with at most 10,000 entries.')
    clean = [require_string(v, 'preset', 10000).strip() for v in values]
    return list(dict.fromkeys(v for v in clean if v))

def image_extension(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'jpg'
    if data.startswith((b'GIF87a', b'GIF89a')):
        return 'gif'
    if len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'webp'
    raise ApiError(400, 'Screenshot must be a PNG, JPEG, GIF or WebP image.')

class AssetParser(HTMLParser):
    """Collect only the built page's script and stylesheet references."""
    def __init__(self):
        super().__init__()
        self.scripts = []
        self.styles = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('src'):
            self.scripts.append(attrs['src'])
        if tag == 'link' and 'stylesheet' in attrs.get('rel', '').split() and attrs.get('href'):
            self.styles.append(attrs['href'])

def offline_assets(static_dir):
    """Read a self-contained Vite build for the browser's offline export."""
    root = Path(static_dir).resolve()
    index = root / 'index.html'
    if not index.is_file():
        raise ApiError(404, 'Frontend build is missing. Run npm install and npm run build first.')
    parser = AssetParser()
    parser.feed(index.read_text(encoding='utf-8'))
    if not parser.scripts:
        raise ApiError(400, 'Frontend JavaScript build is missing. Run npm run build first.')

    def read_asset(reference, extension):
        parsed = urlsplit(reference)
        if parsed.scheme or parsed.netloc:
            raise ApiError(400, 'Offline export requires all frontend assets to be bundled locally.')
        path = unquote(parsed.path)
        if '\x00' in path or '\\' in path or '..' in path.split('/'):
            raise ApiError(400, 'Frontend asset path is invalid.')
        target = (root / path.lstrip('/')).resolve()
        if root not in target.parents or target.suffix not in extension or not target.is_file():
            raise ApiError(404, 'A frontend asset is missing or invalid. Run npm run build first.')
        return target.read_text(encoding='utf-8')

    return {'js': '\n;\n'.join(read_asset(src, ('.js', '.mjs')) for src in parser.scripts),
            'css': '\n'.join(read_asset(href, ('.css',)) for href in parser.styles)}

class Store:
    def __init__(self, data_dir):
        self.root = Path(data_dir).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.uploads = self.root / 'uploads'
        self.uploads.mkdir(exist_ok=True)
        self.db_path = self.root / 'report.db'
        self.lock = threading.RLock()
        self.ai = AiService(self.root)
        with self.connect() as db:
            db.executescript(SCHEMA)
            db.execute('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)', ('presets', json.dumps(DEFAULT_PRESETS)))

    @contextmanager
    def connect(self, path=None):
        db = sqlite3.connect(path or self.db_path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def state(self):
        with self.lock, self.connect() as db:
            presets = json.loads(db.execute("SELECT value FROM settings WHERE key='presets'").fetchone()[0])
            return {'presets': presets, 'groups': [dict(r) for r in db.execute('SELECT date,count FROM groups ORDER BY date')],
                    'feedback': [self.feedback_row(r) for r in db.execute('SELECT * FROM feedback ORDER BY date DESC,rowid DESC')],
                    'history': [dict(r) for r in db.execute('SELECT * FROM history ORDER BY createdAt DESC,rowid DESC')],
                    'failureNotes': {r['taskId']: r['reason'] for r in db.execute('SELECT taskId,reason FROM failure_notes')},
                    'aiReports': [self.ai_report_row(r) for r in db.execute('SELECT * FROM ai_reports ORDER BY createdAt DESC,rowid DESC LIMIT 20')],
                    'aiReportsTotal': db.execute('SELECT count(*) FROM ai_reports').fetchone()[0],
                    'siteVisits': [self.visit_row(r) for r in db.execute('SELECT * FROM site_visits ORDER BY date DESC,createdAt DESC,id')],
                    'dailySummaries': [dict(r) for r in db.execute('SELECT date,title,zh,en,createdAt,updatedAt FROM daily_summaries ORDER BY date DESC')],
                    'total': db.execute('SELECT count(*) FROM logs').fetchone()[0]}

    def get_mttr(self):
        with self.lock, self.connect() as db:
            row = db.execute('SELECT data FROM mttr_dataset WHERE id=1').fetchone()
            return json.loads(row['data']) if row else None

    def import_mttr(self, fields):
        if 'file' not in fields or not set(fields)<={'file','mapping'} or not fields['file'].get('filename'):
            raise ApiError(400, 'Select one ticket export in the file field.')
        mapping = None
        if 'mapping' in fields:
            try:
                mapping = json.loads(fields['mapping'].get('value',''))
            except (ValueError,TypeError):
                raise ApiError(400, 'Column mapping must be a JSON object.')
            if mapping is None:
                raise ApiError(400, 'Column mapping must specify all five fields.')
        try:
            with stage_mttr(fields['file']['data'], fields['file']['filename'],mapping) as (summary, staged):
                with self.lock, self.connect() as db:
                    db.execute('ATTACH DATABASE ? AS incoming_mttr', (staged,))
                    existing = db.execute('SELECT data FROM mttr_dataset WHERE id=1').fetchone()
                    if existing and json.loads(existing['data']).get('formatVersion') != 2:
                        # Legacy snapshots have no IDs. Rebuild only after a fully
                        # parsed, valid upload; failed uploads leave legacy data intact.
                        db.execute('DELETE FROM mttr_tickets')
                    db.execute('INSERT OR IGNORE INTO mttr_tickets(ticketId,createdAt,closedAt,durationSeconds) SELECT ticketId,createdAt,closedAt,durationSeconds FROM incoming_mttr.tickets')
                    added = db.execute('SELECT changes()').fetchone()[0]
                    dataset = finish_dataset(summary, aggregate_tickets(db, 'mttr_tickets'), added)
                    db.execute('INSERT INTO mttr_dataset(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
                               (json.dumps(dataset, ensure_ascii=False, allow_nan=False),))
                return dataset
        except MttrImportError as exc:
            raise ApiError(400, str(exc), exc.details)

    def delete_mttr(self):
        with self.lock, self.connect() as db:
            db.execute('DELETE FROM mttr_dataset')
            db.execute('DELETE FROM mttr_tickets')
        return {'ok': True}

    @staticmethod
    def validate_mttr_ticket(row):
        ticket_id = require_string(row['ticketId'], 'MTTR ticket ID', 1000, True)
        if ticket_id != ticket_id.strip():
            raise ApiError(400, 'Backup MTTR ticket ID has surrounding whitespace.')
        stamps = []
        for key in ('createdAt','closedAt'):
            value = require_string(row[key], 'MTTR timestamp', 100, True)
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?',value):
                raise ApiError(400, 'Backup MTTR ticket timestamp is invalid.')
            stamps.append(datetime.fromisoformat(value))
        duration = row['durationSeconds']
        if type(duration) not in (int,float) or not math.isfinite(duration) or duration < 0 or abs((stamps[1]-stamps[0]).total_seconds()-duration) > 0.000001:
            raise ApiError(400, 'Backup MTTR ticket duration is invalid.')
        return (ticket_id,row['createdAt'],row['closedAt'],duration)

    @staticmethod
    def visit_row(row):
        return {**{key: row[key] for key in ('id', 'date', 'site', 'description', 'createdAt', 'updatedAt')},
                'photos': ['/uploads/' + image for image in json.loads(row['photos'])]}

    @staticmethod
    def validate_visit(row):
        clean = {'id': require_string(row.get('id'), 'visit id', 100, True),
                 'date': require_date(row.get('date')),
                 'site': require_string(row.get('site', ''), 'site name', 200).strip(),
                 'description': require_string(row.get('description', ''), 'visit description', 20000).strip()}
        photos = row.get('photos')
        if not isinstance(photos, list) or len(photos) > 10 or any(not isinstance(x, str) or not IMAGE_NAME.fullmatch(x) for x in photos) or len(photos) != len(set(photos)):
            raise ApiError(400, 'Use at most 10 distinct visit photos.')
        if not photos and not clean['description']:
            raise ApiError(400, 'Add a visit description or at least one photo.')
        clean['photos'] = photos
        stamps = []
        for key in ('createdAt', 'updatedAt'):
            value = require_string(row.get(key), key, 100, True)
            try:
                parsed = datetime.fromisoformat(value)
            except ValueError:
                raise ApiError(400, 'Invalid visit timestamp.')
            if parsed.tzinfo is None:
                raise ApiError(400, 'Visit timestamps must include a timezone.')
            clean[key] = value
            stamps.append(parsed)
        if stamps[0] > stamps[1]:
            raise ApiError(400, 'Invalid visit timestamp order.')
        return clean

    def cleanup_visit_photos(self, images):
        # Keep any image still referenced elsewhere, including restored backups.
        with self.connect() as db:
            used = {r[0] for r in db.execute("SELECT image FROM feedback WHERE image != ''")}
            for row in db.execute('SELECT photos FROM site_visits'):
                used.update(json.loads(row[0]))
        for image in set(images) - used:
            if IMAGE_NAME.fullmatch(image):
                try:
                    (self.uploads / image).unlink(missing_ok=True)
                except OSError:
                    pass  # Saved record is authoritative; stale files are not exported.

    def save_visit(self, fields):
        try:
            payload = json.loads(fields.get('metadata', {}).get('value', ''))
        except (ValueError, TypeError):
            raise ApiError(400, 'Invalid visit metadata.')
        if not isinstance(payload, dict) or 'expectedUpdatedAt' not in payload:
            raise ApiError(400, 'Visit metadata must include expectedUpdatedAt.')
        item_id = payload.get('id')
        if item_id is not None:
            require_string(item_id, 'visit id', 100, True)
        expected = payload['expectedUpdatedAt']
        if expected is not None:
            require_string(expected, 'expected visit timestamp', 100, True)
        keep = payload.get('keepPhotos', [])
        if not isinstance(keep, list) or len(keep) > 10 or any(not isinstance(x, str) or not x.startswith('/uploads/') or not IMAGE_NAME.fullmatch(x[9:]) for x in keep) or len(keep) != len(set(keep)):
            raise ApiError(400, 'Invalid retained visit photos.')
        incoming = []
        for key, part in fields.items():
            if key == 'metadata':
                continue
            if not re.fullmatch(r'photo_[0-9]', key):
                raise ApiError(400, 'Invalid visit photo field.')
            raw = part.get('data', b'')
            if not raw or len(raw) > MAX_IMAGE:
                raise ApiError(413, 'Each photo must be nonempty and 10 MB or smaller.')
            incoming.append((uuid.uuid4().hex + '.' + image_extension(raw), raw))
        photos = [x[9:] for x in keep] + [x[0] for x in incoming]
        stamp = datetime.now(timezone.utc).isoformat()
        clean = self.validate_visit({**payload, 'id': item_id or uuid.uuid4().hex, 'photos': photos, 'createdAt': stamp, 'updatedAt': stamp})
        written = []
        with self.lock:
            old_photos = []
            try:
                with self.connect() as db:
                    existing = db.execute('SELECT * FROM site_visits WHERE id=?', (clean['id'],)).fetchone()
                    if item_id and not existing:
                        raise ApiError(404, 'Visit no longer exists. Reload before editing.')
                    if existing and existing['updatedAt'] != expected:
                        raise ApiError(409, 'Visit changed in another window. Reload before saving.')
                    if not existing and expected is not None:
                        raise ApiError(409, 'New visits require expectedUpdatedAt: null.')
                    old_photos = json.loads(existing['photos']) if existing else []
                    if not set(x[9:] for x in keep) <= set(old_photos):
                        raise ApiError(400, 'Retained photos must belong to this visit.')
                    if existing:
                        clean['createdAt'] = existing['createdAt']
                        previous = datetime.fromisoformat(existing['updatedAt'])
                        if datetime.fromisoformat(clean['updatedAt']) <= previous:
                            clean['updatedAt'] = (previous + timedelta(microseconds=1)).isoformat()
                    for image, raw in incoming:
                        written.append(image)
                        (self.uploads / image).write_bytes(raw)
                    db.execute('INSERT INTO site_visits(id,date,site,description,photos,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET date=excluded.date,site=excluded.site,description=excluded.description,photos=excluded.photos,updatedAt=excluded.updatedAt',
                               (clean['id'], clean['date'], clean['site'], clean['description'], json.dumps(photos), clean['createdAt'], clean['updatedAt']))
            except Exception:
                for image in written:
                    (self.uploads / image).unlink(missing_ok=True)
                raise
            self.cleanup_visit_photos(old_photos)
        return {'visit': {**clean, 'photos': ['/uploads/' + x for x in photos]}}

    def delete_visit(self, item_id, expected):
        require_string(item_id, 'visit id', 100, True)
        require_string(expected, 'expected visit timestamp', 100, True)
        with self.lock:
            with self.connect() as db:
                row = db.execute('SELECT * FROM site_visits WHERE id=?', (item_id,)).fetchone()
                if not row:
                    raise ApiError(404, 'Visit no longer exists.')
                if row['updatedAt'] != expected:
                    raise ApiError(409, 'Visit changed in another window. Reload before deleting.')
                photos = json.loads(row['photos'])
                db.execute('DELETE FROM site_visits WHERE id=?', (item_id,))
            self.cleanup_visit_photos(photos)
        return {'ok': True, 'id': item_id}

    @staticmethod
    def validate_daily_summary(row):
        day = require_date(row.get('date'))
        title = require_string(row.get('title', ''), 'daily summary title', 200).strip()
        zh = require_string(row.get('zh', ''), 'Chinese daily summary', 100000).strip()
        en = require_string(row.get('en', ''), 'English daily summary', 100000).strip()
        if not zh and not en:
            raise ApiError(400, 'Enter a Chinese or English daily summary before saving.')
        clean = {'date': day, 'title': title, 'zh': zh, 'en': en}
        stamps = []
        for field in ('createdAt', 'updatedAt'):
            value = require_string(row.get(field), 'daily summary ' + field, 100, True)
            try:
                parsed = datetime.fromisoformat(value)
            except ValueError:
                raise ApiError(400, 'Invalid daily summary timestamp.')
            if parsed.tzinfo is None:
                raise ApiError(400, 'Daily summary timestamps must include a timezone.')
            clean[field] = value
            stamps.append(parsed)
        if stamps[0] > stamps[1]:
            raise ApiError(400, 'Daily summary update time precedes its creation time.')
        return clean

    def save_daily_summary(self, payload):
        if not isinstance(payload, dict):
            raise ApiError(400, 'Daily summary must be an object.')
        if 'expectedUpdatedAt' not in payload:
            raise ApiError(400, 'Include expectedUpdatedAt: null for a new date, or the saved timestamp when updating.')
        expected = payload['expectedUpdatedAt']
        if expected is not None:
            require_string(expected, 'expected daily summary timestamp', 100, True)
        stamp = datetime.now(timezone.utc).isoformat()
        clean = self.validate_daily_summary({**payload, 'createdAt': stamp, 'updatedAt': stamp})
        with self.lock, self.connect() as db:
            existing = db.execute('SELECT createdAt,updatedAt FROM daily_summaries WHERE date=?', (clean['date'],)).fetchone()
            if expected is None and existing:
                raise ApiError(409, 'A daily summary already exists for this date. Reload it before editing.')
            if expected is not None and existing is None:
                raise ApiError(404, 'The daily summary no longer exists. Reload the archive before saving.')
            if existing and existing['updatedAt'] != expected:
                raise ApiError(409, 'This daily summary changed in another window. Reload it before saving your changes.')
            if existing:
                clean['createdAt'] = existing['createdAt']
                # Keep the edit token monotonic even when the system clock moves backwards.
                now = datetime.now(timezone.utc)
                previous = datetime.fromisoformat(existing['updatedAt'])
                if now <= previous:
                    now = previous + timedelta(microseconds=1)
                clean['updatedAt'] = now.isoformat()
            db.execute('INSERT INTO daily_summaries(date,title,zh,en,createdAt,updatedAt) VALUES(?,?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET title=excluded.title,zh=excluded.zh,en=excluded.en,updatedAt=excluded.updatedAt',
                       tuple(clean[field] for field in ('date', 'title', 'zh', 'en', 'createdAt', 'updatedAt')))
        return {'summary': clean}

    def delete_daily_summary(self, day, expected):
        require_date(day)
        require_string(expected, 'expected daily summary timestamp', 100, True)
        with self.lock, self.connect() as db:
            existing = db.execute('SELECT updatedAt FROM daily_summaries WHERE date=?', (day,)).fetchone()
            if existing is None:
                raise ApiError(404, 'The daily summary no longer exists.')
            if existing['updatedAt'] != expected:
                raise ApiError(409, 'This daily summary changed in another window. Reload it before deleting.')
            db.execute('DELETE FROM daily_summaries WHERE date=?', (day,))
        return {'ok': True, 'date': day}

    @staticmethod
    def ai_report_row(row):
        return {'id': row['id'], 'createdAt': row['createdAt'], 'from': row['dateFrom'], 'to': row['dateTo'],
                'scene': row['scene'], 'model': row['model'], 'demo': bool(row['demo']), 'zh': row['zh'], 'en': row['en']}

    @staticmethod
    def validate_ai_report(row):
        for field, limit in [('id', 1000), ('createdAt', 100), ('dateFrom', 10), ('dateTo', 10), ('model', 200), ('zh', 60000), ('en', 60000)]:
            require_string(row[field], 'AI report ' + field, limit, True)
        require_string(row['scene'], 'AI report scene', 1000)
        require_date(row['dateFrom'])
        require_date(row['dateTo'])
        if row['dateFrom'] > row['dateTo'] or type(row['demo']) is not int or row['demo'] not in (0, 1):
            raise ApiError(400, 'Invalid AI report range or demo flag.')
        datetime.fromisoformat(row['createdAt'])
        return tuple(row[key] for key in ('id', 'createdAt', 'dateFrom', 'dateTo', 'scene', 'model', 'demo', 'zh', 'en'))

    def get_ai_reports(self, offset=0, limit=20):
        with self.lock, self.connect() as db:
            return {'reports': [self.ai_report_row(r) for r in db.execute('SELECT * FROM ai_reports ORDER BY createdAt DESC,rowid DESC LIMIT ? OFFSET ?', (limit, offset))],
                    'total': db.execute('SELECT count(*) FROM ai_reports').fetchone()[0]}

    @staticmethod
    def validate_ai_request(payload):
        prompt = make_prompt(payload)
        scope = payload['facts']['range']
        start, end = require_date(scope.get('from')), require_date(scope.get('to'))
        if start > end:
            raise ApiError(400, 'The AI report start date must not be later than its end date.')
        require_string(scope.get('scene', ''), 'AI report scene', 1000)
        if type(payload['facts'].get('demo')) is not bool:
            raise ApiError(400, 'The AI report demo flag must be a boolean.')
        return prompt

    def generate_ai_report(self, payload):
        self.validate_ai_request(payload)
        result = self.ai.generate(payload)
        scope = payload['facts']['range']
        row = {'id': uuid.uuid4().hex, 'createdAt': datetime.now(timezone.utc).isoformat(),
               'dateFrom': scope['from'], 'dateTo': scope['to'], 'scene': scope.get('scene', ''),
               'model': result['model'], 'demo': int(payload['facts']['demo']), 'zh': result['zh'], 'en': result['en']}
        values = self.validate_ai_report(row)
        with self.lock, self.connect() as db:
            db.execute('INSERT INTO ai_reports(id,createdAt,dateFrom,dateTo,scene,model,demo,zh,en) VALUES(?,?,?,?,?,?,?,?,?)', values)
        return {'report': self.ai_report_row(row)}

    @staticmethod
    def feedback_row(r):
        return {'id': r['id'], 'date': r['date'], 'author': r['author'], 'text': r['text'], 'imageUrl': '/uploads/' + r['image'] if r['image'] else ''}

    def get_logs(self, offset, limit):
        with self.lock, self.connect() as db:
            return {'records': [dict(r) for r in db.execute('SELECT * FROM logs ORDER BY time,taskId LIMIT ? OFFSET ?', (limit, offset))], 'total': db.execute('SELECT count(*) FROM logs').fetchone()[0]}

    def import_logs(self, payload):
        import_id = require_string(payload.get('id'), 'import id', 1000, True)
        name = require_string(payload.get('name'), 'file name', 2000, True)
        records = payload.get('records')
        if not isinstance(records, list) or len(records) > 500:
            raise ApiError(400, 'Import batches accept at most 500 records.')
        clean = [validate_log(row) for row in records]
        rejected = payload.get('rejected', 0)
        if type(rejected) is not int or rejected < 0:
            raise ApiError(400, 'Invalid rejected count.')
        with self.lock, self.connect() as db:
            existing = db.execute('SELECT complete FROM history WHERE id=?', (import_id,)).fetchone()
            if existing and existing['complete']:
                raise ApiError(409, 'This import has already completed; create a new import id.')
            db.execute('INSERT OR IGNORE INTO history(id,name,createdAt,rejected) VALUES(?,?,?,?)', (import_id, name, datetime.now(timezone.utc).isoformat(), rejected))
            before = db.total_changes
            db.executemany('INSERT OR IGNORE INTO logs(taskId,clientId,question,time,date,answer,scene) VALUES(?,?,?,?,?,?,?)', [tuple(row[f] for f in LOG_FIELDS) for row in clean])
            added = db.total_changes - before
            duplicates = len(clean) - added
            db.execute('UPDATE history SET added=added+?,duplicates=duplicates+?,complete=? WHERE id=?', (added, duplicates, int(bool(payload.get('complete'))), import_id))
            return {'added': added, 'duplicates': duplicates, 'total': db.execute('SELECT count(*) FROM logs').fetchone()[0]}

    def save_failure_note(self, payload):
        task_id = require_string(payload.get('taskId'), 'taskId', 1000, True).strip()
        reason = require_string(payload.get('reason'), 'failure reason', 10000).strip()
        with self.lock, self.connect() as db:
            record = db.execute('SELECT answer FROM logs WHERE taskId=?', (task_id,)).fetchone()
            if record is None:
                raise ApiError(404, 'The log record does not exist.')
            if 'sorry' not in record['answer'].lower():
                raise ApiError(400, 'Reasons can only be saved for Sorry failure records.')
            if reason:
                db.execute('INSERT INTO failure_notes(taskId,reason,updatedAt) VALUES(?,?,?) ON CONFLICT(taskId) DO UPDATE SET reason=excluded.reason,updatedAt=excluded.updatedAt', (task_id, reason, datetime.now(timezone.utc).isoformat()))
            else:
                db.execute('DELETE FROM failure_notes WHERE taskId=?', (task_id,))
        return {'ok': True, 'taskId': task_id, 'reason': reason}

    def add_feedback(self, fields):
        day = require_date(fields.get('date', {}).get('value'))
        author = require_string(fields.get('author', {}).get('value', ''), 'author', 2000).strip()
        text = require_string(fields.get('text', {}).get('value', ''), 'feedback text', 100000).strip()
        image = fields.get('image')
        filename = ''
        raw = image.get('data', b'') if image else b''
        if raw:
            if len(raw) > MAX_IMAGE:
                raise ApiError(413, 'Screenshots must be 10 MB or smaller.')
            filename = uuid.uuid4().hex + '.' + image_extension(raw)
        if not text and not filename:
            raise ApiError(400, 'Add feedback text or a screenshot.')
        item_id = uuid.uuid4().hex
        with self.lock:
            if filename:
                (self.uploads / filename).write_bytes(raw)
            try:
                with self.connect() as db:
                    db.execute('INSERT INTO feedback(id,date,author,text,image) VALUES(?,?,?,?,?)', (item_id, day, author, text, filename))
            except Exception:
                if filename:
                    (self.uploads / filename).unlink(missing_ok=True)
                raise
        return {'id': item_id, 'date': day, 'author': author, 'text': text, 'imageUrl': '/uploads/' + filename if filename else ''}

    def backup(self):
        with self.lock, tempfile.TemporaryDirectory() as tmp:
            db_copy = Path(tmp) / 'report.db'
            with self.connect() as src, closing(sqlite3.connect(db_copy)) as dest:
                src.backup(dest)
            result = io.BytesIO()
            with zipfile.ZipFile(result, 'w', zipfile.ZIP_DEFLATED) as z:
                z.writestr('manifest.json', json.dumps({'format': 'fmemate-report-backup', 'version': 1, 'createdAt': datetime.now(timezone.utc).isoformat()}))
                z.write(db_copy, 'report.db')
                with self.connect() as db:
                    images = {r[0] for r in db.execute("SELECT image FROM feedback WHERE image != ''")}
                    for row in db.execute('SELECT photos FROM site_visits'):
                        images.update(json.loads(row[0]))
                for image in images:
                    if IMAGE_NAME.fullmatch(image) and (self.uploads / image).is_file():
                        z.write(self.uploads / image, 'uploads/' + image)
            return result.getvalue()

    def restore(self, content):
        try:
            archive = zipfile.ZipFile(io.BytesIO(content))
        except (zipfile.BadZipFile, ValueError):
            raise ApiError(400, 'Invalid backup ZIP.')
        with archive, tempfile.TemporaryDirectory(dir=self.root, prefix='.restore-') as tmp:
            tmp = Path(tmp)
            names = archive.namelist()
            if len(names) != len(set(names)) or len(names) > 20000 or sum(i.file_size for i in archive.infolist()) > 512 * 1024 * 1024:
                raise ApiError(400, 'Backup is too large or contains duplicate paths.')
            if any(n not in ('manifest.json', 'report.db') and not (n.startswith('uploads/') and IMAGE_NAME.fullmatch(n[8:])) for n in names):
                raise ApiError(400, 'Backup contains an unsupported or unsafe file path.')
            try:
                manifest = json.loads(archive.read('manifest.json'))
                if manifest.get('format') != 'fmemate-report-backup' or manifest.get('version') != 1:
                    raise ApiError(400, 'Unsupported backup format.')
                db_bytes = archive.read('report.db')
            except (KeyError, json.JSONDecodeError):
                raise ApiError(400, 'Backup is missing its database or manifest.')
            if not db_bytes.startswith(b'SQLite format 3\0'):
                raise ApiError(400, 'Backup database is invalid.')
            source_path = tmp / 'source.db'
            source_path.write_bytes(db_bytes)
            new_db = tmp / 'report.db'
            new_uploads = tmp / 'uploads'
            new_uploads.mkdir()
            source = None
            try:
                source = sqlite3.connect(source_path.as_uri() + '?mode=ro&immutable=1', uri=True)
                source.row_factory = sqlite3.Row
                source.execute('PRAGMA trusted_schema=OFF')
                schema = source.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall()
                required_tables = {'logs', 'settings', 'groups', 'feedback', 'history'}
                tables = {r['name'] for r in schema if r['type'] == 'table'}
                # Legacy backups may omit either of the subsequently added tables.
                if not required_tables <= tables or not tables <= required_tables | {'failure_notes', 'ai_reports', 'daily_summaries', 'site_visits', 'mttr_dataset', 'mttr_tickets'} or any(r['type'] not in ('table', 'index') or 'VIRTUAL' in (r['sql'] or '').upper() for r in schema):
                    raise ApiError(400, 'Backup database contains unsupported schema objects.')
                if 'failure_notes' in tables and {r['name'] for r in source.execute('PRAGMA table_info(failure_notes)')} != {'taskId', 'reason', 'updatedAt'}:
                    raise ApiError(400, 'Backup failure reason columns are invalid.')
                if 'ai_reports' in tables and {r['name'] for r in source.execute('PRAGMA table_info(ai_reports)')} != {'id', 'createdAt', 'dateFrom', 'dateTo', 'scene', 'model', 'demo', 'zh', 'en'}:
                    raise ApiError(400, 'Backup AI report columns are invalid.')
                if 'daily_summaries' in tables and {r['name'] for r in source.execute('PRAGMA table_info(daily_summaries)')} != {'date', 'title', 'zh', 'en', 'createdAt', 'updatedAt'}:
                    raise ApiError(400, 'Backup daily summary columns are invalid.')
                if 'site_visits' in tables and {r['name'] for r in source.execute('PRAGMA table_info(site_visits)')} != {'id', 'date', 'site', 'description', 'photos', 'createdAt', 'updatedAt'}:
                    raise ApiError(400, 'Backup site visit columns are invalid.')
                if 'mttr_dataset' in tables and {r['name'] for r in source.execute('PRAGMA table_info(mttr_dataset)')} != {'id', 'data'}:
                    raise ApiError(400, 'Backup MTTR columns are invalid.')
                if 'mttr_tickets' in tables and {r['name'] for r in source.execute('PRAGMA table_info(mttr_tickets)')} != {'ticketId','createdAt','closedAt','durationSeconds'}:
                    raise ApiError(400, 'Backup MTTR ticket columns are invalid.')
                if source.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    raise ApiError(400, 'Backup database integrity check failed.')
                with self.connect(new_db) as dest:
                    dest.executescript(SCHEMA)
                    mttr_snapshot = None
                    if 'mttr_dataset' in tables:
                        rows = source.execute('SELECT id,data FROM mttr_dataset').fetchall()
                        if len(rows) > 1 or any(row['id'] != 1 for row in rows):
                            raise ApiError(400, 'Backup MTTR snapshot is invalid.')
                        for row in rows:
                            try:
                                dataset = validate_dataset(json.loads(row['data']))
                            except (MttrImportError, ValueError, TypeError, KeyError):
                                raise ApiError(400, 'Backup MTTR data is invalid.')
                            mttr_snapshot = dataset
                            dest.execute('INSERT INTO mttr_dataset(id,data) VALUES(1,?)', (json.dumps(dataset, allow_nan=False),))
                    if 'mttr_tickets' in tables:
                        for row in source.execute('SELECT ticketId,createdAt,closedAt,durationSeconds FROM mttr_tickets'):
                            clean = self.validate_mttr_ticket(dict(row))
                            dest.execute('INSERT INTO mttr_tickets VALUES(?,?,?,?)',clean)
                    ledger_days = aggregate_tickets(dest, 'mttr_tickets')
                    if mttr_snapshot and mttr_snapshot.get('formatVersion') == 2:
                        expected = mttr_snapshot['days']
                        if len(ledger_days) != len(expected) or any(a['date'] != b['date'] or a['count'] != b['count'] or not math.isclose(a['totalSeconds'], b['totalSeconds'], rel_tol=1e-12, abs_tol=1e-5) for a,b in zip(ledger_days,expected)):
                            raise ApiError(400, 'Backup MTTR ticket ledger does not match its statistics.')
                    elif ledger_days:
                        raise ApiError(400, 'Backup MTTR ticket ledger has no matching versioned snapshot.')
                    if 'site_visits' in tables:
                        for row in source.execute('SELECT * FROM site_visits'):
                            clean = self.validate_visit({**dict(row), 'photos': json.loads(row['photos'])})
                            for image in clean['photos']:
                                if 'uploads/' + image not in names:
                                    raise ApiError(400, 'A backup visit photo is missing.')
                                raw = archive.read('uploads/' + image)
                                if len(raw) > MAX_IMAGE or image.rsplit('.', 1)[1] != image_extension(raw):
                                    raise ApiError(400, 'Invalid backup visit photo.')
                                (new_uploads / image).write_bytes(raw)
                            dest.execute('INSERT INTO site_visits VALUES(?,?,?,?,?,?,?)', (clean['id'], clean['date'], clean['site'], clean['description'], json.dumps(clean['photos']), clean['createdAt'], clean['updatedAt']))
                    if 'daily_summaries' in tables:
                        for row in source.execute('SELECT date,title,zh,en,createdAt,updatedAt FROM daily_summaries'):
                            clean = self.validate_daily_summary(dict(row))
                            dest.execute('INSERT INTO daily_summaries(date,title,zh,en,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
                                         tuple(clean[field] for field in ('date', 'title', 'zh', 'en', 'createdAt', 'updatedAt')))
                    if 'ai_reports' in tables:
                        for row in source.execute('SELECT id,createdAt,dateFrom,dateTo,scene,model,demo,zh,en FROM ai_reports'):
                            values = self.validate_ai_report(dict(row))
                            dest.execute('INSERT INTO ai_reports(id,createdAt,dateFrom,dateTo,scene,model,demo,zh,en) VALUES(?,?,?,?,?,?,?,?,?)', values)
                    for row in source.execute('SELECT taskId,clientId,question,time,date,answer,scene FROM logs'):
                        clean = validate_log(dict(row))
                        dest.execute('INSERT INTO logs VALUES(?,?,?,?,?,?,?)', tuple(clean[f] for f in LOG_FIELDS))
                    if 'failure_notes' in tables:
                        for row in source.execute('SELECT taskId,reason,updatedAt FROM failure_notes'):
                            task_id = require_string(row['taskId'], 'failure taskId', 1000, True)
                            reason = require_string(row['reason'], 'failure reason', 10000, True).strip()
                            stamp = require_string(row['updatedAt'], 'failure reason timestamp', 100, True)
                            datetime.fromisoformat(stamp)
                            target = dest.execute('SELECT answer FROM logs WHERE taskId=?', (task_id,)).fetchone()
                            if target is None or 'sorry' not in target['answer'].lower():
                                raise ApiError(400, 'Backup failure reasons must refer to existing Sorry failure records.')
                            dest.execute('INSERT INTO failure_notes(taskId,reason,updatedAt) VALUES(?,?,?)', (task_id, reason, stamp))
                    setting = source.execute("SELECT value FROM settings WHERE key='presets'").fetchone()
                    presets = validate_presets(json.loads(setting[0])) if setting else DEFAULT_PRESETS
                    dest.execute('INSERT INTO settings VALUES(?,?)', ('presets', json.dumps(presets)))
                    for row in source.execute('SELECT date,count FROM groups'):
                        day = require_date(row['date'])
                        count = row['count']
                        if type(count) is not int or count < 0:
                            raise ApiError(400, 'Invalid group count in backup.')
                        dest.execute('INSERT INTO groups VALUES(?,?)', (day, count))
                    for row in source.execute('SELECT id,date,author,text,image FROM feedback'):
                        require_string(row['id'], 'feedback id', 1000, True)
                        require_date(row['date'])
                        require_string(row['author'], 'author', 2000)
                        require_string(row['text'], 'feedback text', 100000)
                        image = require_string(row['image'], 'image file', 1000)
                        if image:
                            if not IMAGE_NAME.fullmatch(image) or 'uploads/' + image not in names:
                                raise ApiError(400, 'A backup screenshot is missing or invalid.')
                            raw = archive.read('uploads/' + image)
                            if len(raw) > MAX_IMAGE or image.rsplit('.', 1)[1] != image_extension(raw):
                                raise ApiError(400, 'Invalid backup screenshot.')
                            (new_uploads / image).write_bytes(raw)
                        dest.execute('INSERT INTO feedback VALUES(?,?,?,?,?)', tuple(row))
                    for row in source.execute('SELECT id,name,createdAt,added,duplicates,rejected,complete FROM history'):
                        for field in ('id', 'name', 'createdAt'):
                            require_string(row[field], field, 2000, True)
                        for field in ('added', 'duplicates', 'rejected', 'complete'):
                            if type(row[field]) is not int or row[field] < 0:
                                raise ApiError(400, 'Invalid import history in backup.')
                        dest.execute('INSERT INTO history VALUES(?,?,?,?,?,?,?)', tuple(row))
            except (sqlite3.Error, TypeError, ValueError, KeyError):
                raise ApiError(400, 'Backup database content is invalid.')
            finally:
                if source is not None:
                    source.close()
            with self.lock:
                backup_name = 'before-restore-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:6] + '.zip'
                (self.root / backup_name).write_bytes(self.backup())
                # All live requests hold this same lock. Prepare and validate everything
                # before swapping, retaining rollback paths if a filesystem error occurs.
                old_db = tmp / 'old.db'
                old_uploads = tmp / 'old-uploads'
                os.replace(self.db_path, old_db)
                try:
                    os.replace(self.uploads, old_uploads)
                    os.replace(new_db, self.db_path)
                    os.replace(new_uploads, self.uploads)
                except Exception:
                    if self.db_path.exists():
                        self.db_path.unlink()
                    os.replace(old_db, self.db_path)
                    if old_uploads.exists():
                        if self.uploads.exists():
                            shutil.rmtree(self.uploads)
                        os.replace(old_uploads, self.uploads)
                    raise
            return {'ok': True, 'backup': backup_name}

class ReportServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, store, static_dir=None):
        self.store = store
        self.static_dir = Path(static_dir or ROOT / 'dist').resolve()
        super().__init__(address, Handler)

class Handler(BaseHTTPRequestHandler):
    server_version = f'FMEMateReport/{APP_VERSION}'
    def log_message(self, format, *args):
        # Never print request bodies, questions, answers, or identifiers.
        print('%s - %s' % (self.address_string(), format % args))

    def send_bytes(self, status, body, content_type='application/json; charset=utf-8', headers=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-store' if self.path.startswith(('/api/', '/uploads/')) else 'no-cache')
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def json(self, payload, status=200):
        self.send_bytes(status, json.dumps(payload, ensure_ascii=False).encode())

    def check_origin(self):
        origin = self.headers.get('Origin')
        if origin:
            parsed = urlsplit(origin)
            if parsed.scheme not in ('http', 'https') or parsed.netloc.lower() != self.headers.get('Host', '').lower():
                raise ApiError(403, 'Cross-origin writes are not permitted.')
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise ApiError(403, 'Cross-site writes are not permitted.')

    def body(self):
        try:
            length = int(self.headers.get('Content-Length', '-1'))
        except ValueError:
            raise ApiError(400, 'Invalid content length.')
        if length < 0 or length > MAX_BODY:
            raise ApiError(413, 'Request must include a content length and be 128 MB or smaller.')
        body = self.rfile.read(length)
        if len(body) != length:
            raise ApiError(400, 'Incomplete request body.')
        return body

    def json_body(self):
        if self.headers.get_content_type() != 'application/json':
            raise ApiError(415, 'Use application/json.')
        try:
            result = json.loads(self.body())
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ApiError(400, 'Invalid JSON body.')
        if not isinstance(result, dict):
            raise ApiError(400, 'JSON body must be an object.')
        return result

    def multipart(self):
        if self.headers.get_content_type() != 'multipart/form-data':
            raise ApiError(415, 'Use multipart/form-data.')
        content_type = self.headers.get('Content-Type', '')
        if '\r' in content_type or '\n' in content_type:
            raise ApiError(400, 'Invalid multipart header.')
        message = BytesParser(policy=email_policy).parsebytes(('Content-Type: ' + content_type + '\r\nMIME-Version: 1.0\r\n\r\n').encode() + self.body())
        if not message.is_multipart():
            raise ApiError(400, 'Invalid multipart body.')
        result = {}
        for part in message.iter_parts():
            name = part.get_param('name', header='content-disposition')
            if not name or name in result:
                raise ApiError(400, 'Invalid or duplicate multipart field.')
            data = part.get_payload(decode=True) or b''
            result[name] = {'data': data, 'filename': part.get_filename(), 'value': data.decode('utf-8', errors='replace') if not part.get_filename() else ''}
        return result

    def handle_error(self, exc):
        if isinstance(exc, (ApiError, AiError)):
            payload = {'error': exc.message}
            if getattr(exc, 'details', None) is not None:
                payload['details'] = exc.details
            self.json(payload, exc.status)
        elif isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            pass
        else:
            error_type = type(exc).__name__
            missing_name = getattr(exc, 'name', None) if isinstance(exc, NameError) else None
            if not isinstance(missing_name, str) or len(missing_name) > 128 or not missing_name.isidentifier():
                missing_name = None
            detail = f'{error_type}: undefined Python name {missing_name}' if missing_name else error_type
            print('Request failed:', detail, flush=True)
            # Print locations only: exception messages, source lines and frame locals
            # can contain uploaded logs or credentials. Basenames omit user paths.
            trace = exc.__traceback__
            while trace is not None:
                code = trace.tb_frame.f_code
                filename = code.co_filename.replace('\\', '/').rsplit('/', 1)[-1]
                print(f'  {filename}:{trace.tb_lineno} in {code.co_name}', flush=True)
                trace = trace.tb_next
            self.json({'error': f'The operation failed ({detail}). Check the server console for the error location.'}, 500)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            url = urlsplit(self.path)
            path = unquote(url.path)
            params = parse_qs(url.query)
            if path == '/api/mttr':
                return self.json(self.server.store.get_mttr())
            if path == '/api/state':
                return self.json(self.server.store.state())
            if path == '/api/ai/config':
                return self.json(self.server.store.ai.get_config())
            if path == '/api/ai/reports':
                try:
                    offset = int(params.get('offset', ['0'])[0])
                    limit = int(params.get('limit', ['20'])[0])
                except ValueError:
                    raise ApiError(400, 'Invalid AI report pagination.')
                if offset < 0 or not 1 <= limit <= 100:
                    raise ApiError(400, 'AI report limit must be between 1 and 100.')
                return self.json(self.server.store.get_ai_reports(offset, limit))
            if path == '/api/logs':
                try:
                    offset = int(params.get('offset', ['0'])[0])
                    limit = int(params.get('limit', ['5000'])[0])
                except ValueError:
                    raise ApiError(400, 'Invalid pagination.')
                if offset < 0 or limit < 1 or limit > 10000:
                    raise ApiError(400, 'Invalid pagination range.')
                return self.json(self.server.store.get_logs(offset, limit))
            if path == '/api/offline-assets':
                return self.json(offline_assets(self.server.static_dir))
            if path == '/api/backup':
                body = self.server.store.backup()
                return self.send_bytes(200, body, 'application/zip', {'Content-Disposition': 'attachment; filename="FMEMate-backup-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.zip"'})
            if path.startswith('/api/'):
                raise ApiError(404, 'Unknown API route.')
            if path.startswith('/uploads/'):
                image = path[len('/uploads/'):]
                if not IMAGE_NAME.fullmatch(image):
                    raise ApiError(404, 'Screenshot not found.')
                with self.server.store.lock:
                    file = self.server.store.uploads / image
                    if not file.is_file():
                        raise ApiError(404, 'Screenshot not found.')
                    body = file.read_bytes()
                return self.send_bytes(200, body, mimetypes.guess_type(file.name)[0] or 'application/octet-stream', {'Content-Security-Policy': "default-src 'none'; sandbox"})
            if '\x00' in path or '\\' in path or '..' in path.split('/'):
                raise ApiError(404, 'File not found.')
            target = (self.server.static_dir / path.lstrip('/')).resolve()
            if self.server.static_dir not in target.parents and target != self.server.static_dir:
                raise ApiError(404, 'File not found.')
            if target.is_dir():
                target = target / 'index.html'
            if not target.is_file() and not Path(path).suffix:
                target = self.server.static_dir / 'index.html'
            if not target.is_file():
                raise ApiError(404, 'Frontend is unavailable. Run npm install and npm run build first.')
            return self.send_bytes(200, target.read_bytes(), mimetypes.guess_type(target.name)[0] or 'application/octet-stream')
        except Exception as exc:
            self.handle_error(exc)

    def do_POST(self):
        try:
            self.check_origin()
            path = urlsplit(self.path).path
            store = self.server.store
            if path == '/api/ai/config':
                return self.json(store.ai.save_config(self.json_body()))
            if path == '/api/ai/preview':
                return self.json(store.validate_ai_request(self.json_body()))
            if path == '/api/ai/generate':
                return self.json(store.generate_ai_report(self.json_body()))
            if path == '/api/mttr/import':
                return self.json(store.import_mttr(self.multipart()))
            if path == '/api/site-visits':
                return self.json(store.save_visit(self.multipart()))
            if path == '/api/daily-summaries':
                return self.json(store.save_daily_summary(self.json_body()))
            if path == '/api/import':
                return self.json(store.import_logs(self.json_body()))
            if path == '/api/failure-notes':
                return self.json(store.save_failure_note(self.json_body()))
            if path == '/api/presets':
                presets = validate_presets(self.json_body().get('presets'))
                with store.lock, store.connect() as db:
                    db.execute("INSERT INTO settings(key,value) VALUES('presets',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(presets, ensure_ascii=False),))
                return self.json({'ok': True})
            if path == '/api/groups':
                payload = self.json_body()
                day = require_date(payload.get('date'))
                count = payload.get('count')
                if type(count) is not int or count < 0 or count > 100000000:
                    raise ApiError(400, 'Member count must be a nonnegative integer.')
                with store.lock, store.connect() as db:
                    db.execute('INSERT INTO groups(date,count) VALUES(?,?) ON CONFLICT(date) DO UPDATE SET count=excluded.count', (day, count))
                return self.json({'ok': True})
            if path == '/api/feedback':
                return self.json(store.add_feedback(self.multipart()), 201)
            if path == '/api/restore':
                fields = self.multipart()
                if 'backup' not in fields:
                    raise ApiError(400, 'Select a backup ZIP file.')
                return self.json(store.restore(fields['backup']['data']))
            if path == '/api/reset':
                if self.json_body().get('confirm') != 'DELETE ALL DATA':
                    raise ApiError(400, 'Explicit reset confirmation is required.')
                with store.lock, store.connect() as db:
                    db.execute('DELETE FROM failure_notes')
                    db.execute('DELETE FROM logs')
                    db.execute('DELETE FROM history')
                return self.json({'ok': True})
            raise ApiError(404, 'Unknown API route.')
        except Exception as exc:
            self.handle_error(exc)

    def do_DELETE(self):
        try:
            self.check_origin()
            url = urlsplit(self.path)
            params = parse_qs(url.query)
            store = self.server.store
            if url.path == '/api/mttr':
                return self.json(store.delete_mttr())
            if url.path == '/api/site-visits':
                return self.json(store.delete_visit(params.get('id', [''])[0], params.get('expectedUpdatedAt', [''])[0]))
            if url.path == '/api/daily-summaries':
                return self.json(store.delete_daily_summary(params.get('date', [''])[0], params.get('expectedUpdatedAt', [''])[0]))
            if url.path == '/api/groups':
                day = require_date(params.get('date', [''])[0])
                with store.lock, store.connect() as db:
                    db.execute('DELETE FROM groups WHERE date=?', (day,))
                return self.json({'ok': True})
            if url.path == '/api/feedback':
                item_id = params.get('id', [''])[0]
                with store.lock, store.connect() as db:
                    row = db.execute('SELECT image FROM feedback WHERE id=?', (item_id,)).fetchone()
                    db.execute('DELETE FROM feedback WHERE id=?', (item_id,))
                    if row and IMAGE_NAME.fullmatch(row['image']):
                        (store.uploads / row['image']).unlink(missing_ok=True)
                return self.json({'ok': True})
            raise ApiError(404, 'Unknown API route.')
        except Exception as exc:
            self.handle_error(exc)

def main():
    parser = argparse.ArgumentParser(description='Run the local FMEMate reporting dashboard.')
    parser.add_argument('--host', default='127.0.0.1', help='Bind address; use 0.0.0.0 only on a trusted LAN.')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--data-dir', type=Path, default=ROOT / 'data')
    args = parser.parse_args()
    server = ReportServer((args.host, args.port), Store(args.data_dir))
    print(f'FMEMate Project Pulse v{APP_VERSION}: http://localhost:{args.port}')
    print(f'Data: {Path(args.data_dir).resolve()}')
    if args.host not in ('127.0.0.1', 'localhost', '::1'):
        print('LAN access enabled. This local service has no authentication; use a trusted network only.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.')
    finally:
        server.server_close()

if __name__ == '__main__':
    main()
