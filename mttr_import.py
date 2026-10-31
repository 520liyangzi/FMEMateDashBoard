"""Streaming, standard-library-only MTTR import for the ticket system export.

Only daily aggregates survive an import. Every upload is a full replacement, so
reuploading the same export cannot inflate a previously imported dataset.
"""
from __future__ import annotations
import csv
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
import io
import json
import math
from pathlib import PurePosixPath
import re
import sqlite3
import tempfile
import xml.etree.ElementTree as ET
import zipfile

MAX_EXPANDED = 1024 * 1024 * 1024
MAX_ROWS = 2_000_000
MAX_TEXT = 65536
FIELDS = ('filename', 'importedAt', 'sheetName', 'sourceRows', 'matchedRows', 'validRows',
          'invalidDates', 'negativeDurations', 'excludedRows', 'days', 'earliestDate', 'latestDate')

class MttrImportError(ValueError):
    pass

class SafeXML:
    def __init__(self, stream):
        self.stream, self.tail = stream, b''
    def read(self, size=-1):
        chunk = self.stream.read(size)
        scan = (self.tail + chunk).upper()
        if b'<!DOCTYPE' in scan or b'<!ENTITY' in scan:
            raise MttrImportError('Excel XML declarations are unsupported. Resave the file as .xlsx.')
        self.tail = scan[-16:]
        return chunk

def local(tag):
    return tag.rsplit('}', 1)[-1]

def text_of(element):
    text = ''.join(e.text or '' for e in element.iter() if local(e.tag) == 't')
    if len(text) > MAX_TEXT:
        raise MttrImportError('An Excel cell is too long.')
    return text

def xml_small(archive, name):
    try:
        info = archive.getinfo(name)
        if info.file_size > 2 * 1024 * 1024:
            raise MttrImportError('Excel metadata is too large.')
        with archive.open(info) as stream:
            return ET.parse(SafeXML(stream)).getroot()
    except KeyError:
        raise MttrImportError('The Excel workbook is missing required metadata.')

def excel_time(value, date1904=False):
    value = str(value).strip()
    if not value:
        return None
    match = re.fullmatch(r'(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T]+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?', value)
    if match:
        try:
            y, m, d, h, minute, sec = map(int, match.groups()[:6])
            return datetime(y, m, d, h, minute, sec, int((match[7] or '').ljust(6, '0') or 0))
        except ValueError:
            return None
    # Fixed F/J columns contain datetimes, even if Excel stores them as numbers.
    if re.fullmatch(r'\d+(?:\.\d+)?(?:[eE][+-]?\d+)?', value):
        try:
            serial = float(value)
            if not math.isfinite(serial) or serial < 0 or (not date1904 and 60 <= serial < 61):
                return None
            base = datetime(1904, 1, 1) if date1904 else datetime(1899, 12, 30) if serial >= 61 else datetime(1899, 12, 31)
            # Date values in Excel have rounding noise; normalize to a second.
            return base + timedelta(seconds=round(serial * 86400))
        except (ValueError, OverflowError):
            return None
    return None

def xlsx_rows(content):
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except (zipfile.BadZipFile, ValueError):
        raise MttrImportError('Invalid .xlsx file. Resave the ticket export as .xlsx.')
    with archive, tempfile.TemporaryDirectory(prefix='fmemate-mttr-') as tmp:
        infos = archive.infolist()
        names = [i.filename for i in infos]
        if len(infos) > 20000 or len(names) != len(set(names)) or sum(i.file_size for i in infos) > MAX_EXPANDED:
            raise MttrImportError('The expanded workbook is too large or contains duplicate paths.')
        if any(i.flag_bits & 1 for i in infos):
            raise MttrImportError('Password-protected workbooks are unsupported.')
        workbook = xml_small(archive, 'xl/workbook.xml')
        props = next((e for e in workbook if local(e.tag) == 'workbookPr'), None)
        date1904 = props is not None and props.attrib.get('date1904', '').lower() in ('1', 'true')
        sheets = [e for e in workbook.iter() if local(e.tag) == 'sheet']
        if not sheets:
            raise MttrImportError('The workbook has no worksheets.')
        first = sheets[0]
        rel_id = next((v for k, v in first.attrib.items() if k.endswith('}id')), '')
        rels = xml_small(archive, 'xl/_rels/workbook.xml.rels')
        relation = next((e for e in rels if e.attrib.get('Id') == rel_id and e.attrib.get('Type', '').endswith('/worksheet')), None)
        if relation is None or relation.attrib.get('TargetMode') == 'External':
            raise MttrImportError('The first worksheet is missing or external.')
        target = relation.attrib.get('Target', '')
        if not target or '\\' in target or '..' in PurePosixPath(target).parts:
            raise MttrImportError('Invalid worksheet path.')
        sheet_path = target.lstrip('/') if target.startswith('/') else 'xl/' + target
        if sheet_path not in names:
            raise MttrImportError('The first worksheet is missing.')
        db = sqlite3.connect(tmp + '/strings.db')
        try:
            db.execute('CREATE TABLE strings (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
            if 'xl/sharedStrings.xml' in names:
                with archive.open('xl/sharedStrings.xml') as stream:
                    stack = []
                    index = 0
                    for event, element in ET.iterparse(SafeXML(stream), events=('start', 'end')):
                        if event == 'start':
                            stack.append(element)
                        else:
                            if local(element.tag) == 'si':
                                db.execute('INSERT INTO strings VALUES (?,?)', (index, text_of(element)))
                                index += 1
                                if len(stack) > 1:
                                    stack[-2].remove(element)
                                element.clear()
                            stack.pop()
                db.commit()
            @lru_cache(maxsize=2048)
            def shared(index):
                if not re.fullmatch(r'\d+', index):
                    raise MttrImportError('Invalid Excel shared-string reference.')
                found = db.execute('SELECT value FROM strings WHERE id=?', (int(index),)).fetchone()
                if found is None:
                    raise MttrImportError('An Excel shared-string value is missing.')
                return found[0]
            yield {'sheetName': first.attrib.get('name', 'Sheet 1')[:200], 'date1904': date1904}
            with archive.open(sheet_path) as stream:
                stack = []
                count = 0
                for event, element in ET.iterparse(SafeXML(stream), events=('start', 'end')):
                    if event == 'start':
                        stack.append(element)
                    else:
                        if local(element.tag) == 'row':
                            count += 1
                            if count > MAX_ROWS:
                                raise MttrImportError('The workbook has more than 2,000,000 rows.')
                            values, nonempty = {}, False
                            for cell in element:
                                if local(cell.tag) != 'c':
                                    continue
                                ref = re.fullmatch(r'([A-Z]+)\d+', cell.attrib.get('r', ''))
                                if ref is None:
                                    raise MttrImportError('An Excel cell has no valid column reference.')
                                column = ref[1]
                                raw = next((v.text or '' for v in cell if local(v.tag) == 'v'), '')
                                kind = cell.attrib.get('t', '')
                                if kind == 'inlineStr':
                                    value = text_of(cell)
                                elif kind == 's' and raw:
                                    value = shared(raw)
                                else:
                                    value = raw
                                if len(value) > MAX_TEXT:
                                    raise MttrImportError('An Excel cell is too long.')
                                nonempty = nonempty or bool(value.strip())
                                if column in ('F', 'J', 'S', 'U'):
                                    # Excel errors must not be interpreted as normal values.
                                    values[column] = '' if kind in ('e', 'b') else value
                            if nonempty:
                                yield values
                            if len(stack) > 1:
                                stack[-2].remove(element)
                            element.clear()
                        stack.pop()
        finally:
            db.close()

def csv_rows(content):
    try:
        stream = io.StringIO(content.decode('utf-8-sig'), newline='')
    except UnicodeDecodeError:
        raise MttrImportError('CSV must use UTF-8 encoding; alternatively upload .xlsx.')
    yield {'sheetName': 'CSV', 'date1904': False}
    for index, row in enumerate(csv.reader(stream)):
        if index >= MAX_ROWS:
            raise MttrImportError('The CSV has more than 2,000,000 rows.')
        if any(len(v) > MAX_TEXT for v in row):
            raise MttrImportError('A CSV cell is too long.')
        if any(v.strip() for v in row):
            yield {key: row[col] if col < len(row) else '' for key, col in (('F', 5), ('J', 9), ('S', 18), ('U', 20))}

def import_mttr(content, filename):
    filename = str(filename or '').replace('\\', '/').rsplit('/', 1)[-1][:255]
    suffix = PurePosixPath(filename).suffix.lower()
    if suffix not in ('.xlsx', '.csv'):
        raise MttrImportError('Upload .xlsx or UTF-8 .csv. Save older .xls files as .xlsx first.')
    if not content:
        raise MttrImportError('The ticket export is empty.')
    result = dict(filename=filename, importedAt=datetime.now(timezone.utc).isoformat(), sourceRows=0,
                  matchedRows=0, validRows=0, invalidDates=0, negativeDurations=0, excludedRows=0)
    days = {}
    rows = xlsx_rows(content) if suffix == '.xlsx' else csv_rows(content)
    try:
        metadata = next(rows)
        result['sheetName'] = metadata['sheetName']
        for row in rows:
            if str(row.get('S', '')).strip().casefold() == 'tt_status_description':
                continue
            result['sourceRows'] += 1
            if str(row.get('S', '')).strip().upper() != 'CLOSE' or str(row.get('U', '')).strip().upper() not in ('RADIO-OSP', 'RADIO-ISP'):
                result['excludedRows'] += 1
                continue
            result['matchedRows'] += 1
            created = excel_time(row.get('F', ''), metadata['date1904'])
            closed = excel_time(row.get('J', ''), metadata['date1904'])
            if created is None or closed is None:
                result['invalidDates'] += 1
                continue
            seconds = (closed - created).total_seconds()
            if seconds < 0:
                result['negativeDurations'] += 1
                continue
            result['validRows'] += 1
            day = closed.date().isoformat()
            bucket = days.setdefault(day, {'date': day, 'count': 0, 'totalSeconds': 0})
            bucket['count'] += 1
            bucket['totalSeconds'] += seconds
    except MttrImportError:
        raise
    except (ET.ParseError, zipfile.BadZipFile, RuntimeError, csv.Error, ValueError, OverflowError, KeyError, OSError) as exc:
        raise MttrImportError('The ticket export is corrupt or unsupported. Resave it as .xlsx.') from exc
    finally:
        rows.close()
    if not result['validRows']:
        raise MttrImportError('No valid closed Radio-OSP/Radio-ISP tickets were found in columns F/J/S/U. Previous data is unchanged.')
    result['days'] = [days[d] for d in sorted(days)]
    result['earliestDate'], result['latestDate'] = min(days), max(days)
    return result

def validate_dataset(value):
    """Validate compact aggregates when restoring an untrusted backup."""
    if not isinstance(value, dict) or set(value) != set(FIELDS):
        raise MttrImportError('Invalid MTTR dataset fields.')
    for key, limit in (('filename', 255), ('sheetName', 200), ('importedAt', 100)):
        if not isinstance(value[key], str) or not value[key] or len(value[key]) > limit:
            raise MttrImportError('Invalid MTTR metadata.')
    if datetime.fromisoformat(value['importedAt']).tzinfo is None:
        raise MttrImportError('Invalid MTTR import timestamp.')
    for key in ('sourceRows', 'matchedRows', 'validRows', 'invalidDates', 'negativeDurations', 'excludedRows'):
        if type(value[key]) is not int or not 0 <= value[key] <= MAX_ROWS:
            raise MttrImportError('Invalid MTTR row counts.')
    if value['sourceRows'] != value['matchedRows'] + value['excludedRows'] or value['matchedRows'] != value['validRows'] + value['invalidDates'] + value['negativeDurations']:
        raise MttrImportError('Inconsistent MTTR row counts.')
    days = value['days']
    if not isinstance(days, list) or not days or len(days) > MAX_ROWS:
        raise MttrImportError('Invalid MTTR daily aggregates.')
    previous = ''
    count = 0
    for row in days:
        if not isinstance(row, dict) or set(row) != {'date', 'count', 'totalSeconds'}:
            raise MttrImportError('Invalid MTTR daily aggregate fields.')
        day = row['date']
        if not isinstance(day, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day) or date.fromisoformat(day).isoformat() != day or day <= previous:
            raise MttrImportError('Invalid MTTR aggregate date order.')
        if type(row['count']) is not int or row['count'] <= 0 or row['count'] > MAX_ROWS:
            raise MttrImportError('Invalid MTTR aggregate ticket count.')
        seconds = row['totalSeconds']
        if type(seconds) not in (int, float) or not math.isfinite(seconds) or seconds < 0 or seconds > row['count'] * 315537897600:
            raise MttrImportError('Invalid MTTR aggregate duration.')
        count += row['count']
        previous = day
    if count != value['validRows'] or value['earliestDate'] != days[0]['date'] or value['latestDate'] != days[-1]['date']:
        raise MttrImportError('Inconsistent MTTR aggregate totals.')
    return value
