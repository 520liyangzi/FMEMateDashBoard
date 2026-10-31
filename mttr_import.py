"""Streaming, standard-library-only MTTR import for the ticket system export.

Minimal ticket identifiers and timestamps are staged on disk. The server merges
first valid IDs across uploads and exposes daily aggregates only.
"""
from __future__ import annotations
import csv
from datetime import date, datetime, timedelta, timezone
from contextlib import contextmanager, closing
from functools import lru_cache
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import tempfile
import xml.etree.ElementTree as ET
import zipfile

MAX_EXPANDED = 1024 * 1024 * 1024
MAX_ROWS = 2_000_000
MAX_TEXT = 65536
LEGACY_FIELDS = ('filename', 'importedAt', 'sheetName', 'sourceRows', 'matchedRows', 'validRows',
          'invalidDates', 'negativeDurations', 'excludedRows', 'days', 'earliestDate', 'latestDate')

V2_FIELDS = set(LEGACY_FIELDS) | {'formatVersion', 'totalTickets', 'addedRows', 'duplicateRows', 'missingIds', 'headerColumns', 'diagnostics'}
TICKET_SCHEMA = 'CREATE TABLE tickets (ticketId TEXT PRIMARY KEY, createdAt TEXT NOT NULL, closedAt TEXT NOT NULL, durationSeconds REAL NOT NULL)'

class MttrImportError(ValueError):
    def __init__(self, message, details=None):
        super().__init__(message)
        self.details = details

def source_size(content):
    """Internal staged Paths and legacy in-memory bytes are the only sources.

    Never interpret a client-provided string as a filesystem path. Staged files
    must remain available until the consuming generator/context has finished.
    """
    if isinstance(content, bytes):
        return len(content)
    if isinstance(content, os.PathLike):
        try:
            path = Path(content)
            if not path.is_file():
                raise MttrImportError('The staged import file is missing or unreadable. Upload it again.')
            return path.stat().st_size
        except (OSError, TypeError, ValueError) as exc:
            raise MttrImportError('The staged import file is missing or unreadable. Upload it again.') from exc
    raise MttrImportError('Invalid import source. Upload a file before importing.')

@contextmanager
def binary_source(content):
    """Own and close one byte stream without loading a staged file into RAM."""
    source_size(content)
    with (io.BytesIO(content) if isinstance(content, bytes) else open(content, 'rb')) as stream:
        yield stream

def normalized(value):
    return re.sub(r'\s+', ' ', str(value)).strip()

def category(value):
    value = re.sub(r'[‐‑‒–—−﹘﹣－]', '-', normalized(value))
    return re.sub(r'\s*-\s*', '-', value).upper()


ROLES = ('B','F','J','S','U')
DEFAULT_MAPPING = {key:key for key in ROLES}
HEADER_ALIASES = {
    'B': {'tt_id','ticket_id','ticketid','ttid','tt_number','ticket_number'},
    'F': {'tt_create_date','tt_created_date','tt_creation_date','tt_create_time','tt_created_time','tt_creation_time','tt_created_at','tt_create_datetime','ticket_create_date','ticket_created_date','ticket_created_at','created_time','created_at','create_date','created_date','creation_time','creation_date'},
    'J': {'tt_close_date','tt_closed_date','tt_close_time','tt_closed_time','tt_closed_at','tt_close_datetime','ticket_close_date','ticket_closed_date','ticket_closed_at','closed_time','close_time','close_date','closed_date','closed_at'},
    'S': {'tt_status_description','tt_status','ticket_status_description','ticket_status','status_description','status'},
    'U': {'tt_domain','tt_domain_description','ticket_domain','domain','domain_name','domain_description','network_domain','tt_category','ticket_category','category','network_category'},
}

def header_key(value):
    return re.sub(r'[^a-z0-9]+', '_', normalized(value).casefold()).strip('_')

def column_index(value):
    if not isinstance(value,str) or not re.fullmatch(r'[A-Z]{1,3}',value):
        return None
    number = 0
    for letter in value:
        number = number * 26 + ord(letter)-64
    return number if number <= 16384 else None

def column_name(number):
    result = ''
    while number:
        number, digit = divmod(number-1,26)
        result = chr(digit+65)+result
    return result

def valid_mapping(value, available=None):
    return (isinstance(value,dict) and set(value)==set(ROLES)
            and all(column_index(v) is not None for v in value.values())
            and len(set(value.values()))==5
            and (available is None or all(v in available for v in value.values())))

def mapping_preview(headers, preview, suggestions, sheet_name, reason):
    columns = set(headers)
    for row in preview:
        columns.update(key for key in row if key != '_row')
    samples = {key: [] for key in columns}
    hidden = {'B'} | {key for key,value in headers.items() if header_key(value) in HEADER_ALIASES['B']}
    for row in preview:
        for key in columns - hidden:
            value = normalized(row.get(key,''))[:80]
            if value and value not in samples[key] and len(samples[key]) < 3:
                samples[key].append(value)
    # Values can help a person select the category, but never auto-authorize an
    # unknown column. A human must confirm the entire mapping in this case.
    if 'U' not in suggestions:
        candidates = [key for key,values in samples.items() if any(category(v) in ('RADIO-OSP','RADIO-ISP') for v in values)]
        if len(candidates)==1:
            suggestions = {**suggestions,'U':candidates[0]}
    details = {'requiresMapping': True, 'sheetName': sheet_name, 'previewRows': len(preview),
               'availableColumns': [{'column': key, 'header': normalized(headers.get(key,''))[:200], 'samples': samples[key]} for key in sorted(columns,key=lambda key:column_index(key) or 16385)],
               'suggestedMapping': suggestions}
    return MttrImportError('请确认工单字段映射 / Confirm ticket column mapping. '+reason+' 原数据未改变 / Existing data unchanged.', details)

def prepare_mapping(rows, result, requested):
    first = next(rows,None)
    headers = {key:value for key,value in (first or {}).items() if key != '_row'} if first and first['_row']==1 else {}
    initial = [] if not first or first['_row']==1 else [first]
    candidates = {role:[key for key,value in headers.items() if header_key(value) in HEADER_ALIASES[role]] for role in ROLES}
    suggested = {role:columns[0] for role,columns in candidates.items() if len(columns)==1}
    nonblank = any(normalized(value) for value in headers.values())
    automatic = suggested if nonblank else DEFAULT_MAPPING.copy()
    if requested is None and valid_mapping(automatic):
        return automatic, headers, initial
    # A mapping failure previews no more than 20 data rows and never modifies
    # either the temporary ticket ledger or the live database.
    preview = list(initial)
    while len(preview)<20:
        row = next(rows,None)
        if row is None:
            break
        preview.append(row)
    available = set(headers)
    for row in preview:
        available.update(key for key in row if key != '_row')
    if requested is not None and valid_mapping(requested,available):
        return dict(requested), headers, preview
    reason = ('Choose five distinct existing columns for ticket ID, creation time, closing time, status and category.'
              if requested is not None else 'Headers are missing or ambiguous; job initiation/assignment times and operator fields are not ticket closing times.')
    raise mapping_preview(headers,preview,suggested,result['sheetName'],reason)


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
    value = normalized(value)
    if not value:
        return None
    match = re.fullmatch(r'(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?', value)
    if match:
        try:
            y, m, d, h, minute = map(int, match.groups()[:5])
            sec = int(match[6] or 0)
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
    source_size(content)
    try:
        archive = zipfile.ZipFile(io.BytesIO(content) if isinstance(content, bytes) else content)
    except (zipfile.BadZipFile, ValueError, OSError):
        raise MttrImportError('Invalid .xlsx file. Resave the ticket export as .xlsx.')
    with archive, tempfile.TemporaryDirectory(prefix='fmemate-mttr-') as tmp:
        infos = archive.infolist()
        names = [i.filename for i in infos]
        if len(infos) > 20000 or len(names) != len(set(names)) or sum(i.file_size for i in infos) > MAX_EXPANDED:
            raise MttrImportError('The expanded workbook exceeds the 1 GB limit, has too many entries, or contains duplicate paths. Split the export into smaller files.')
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
                            row_number = int(element.attrib.get('r', count))
                            if row_number < 1 or row_number > MAX_ROWS:
                                raise MttrImportError('Invalid worksheet row number.')
                            values, nonempty = {'_row': row_number}, False
                            for cell in element:
                                if local(cell.tag) != 'c':
                                    continue
                                ref = re.fullmatch(r'([A-Z]+)\d+', cell.attrib.get('r', ''))
                                if ref is None:
                                    raise MttrImportError('An Excel cell has no valid column reference.')
                                column = ref[1]
                                if column_index(column) is None:
                                    raise MttrImportError('Invalid Excel column reference.')
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
                                # Read every source column for header mapping.
                                values[column] = '' if kind in ('e', 'b') else value
                            # Preserve physical row 1 even when blank; never treat
                            # the first nonempty data row as a header.
                            if nonempty or row_number == 1:
                                yield values
                            if len(stack) > 1:
                                stack[-2].remove(element)
                            element.clear()
                        stack.pop()
        finally:
            db.close()

def csv_rows(content):
    try:
        with binary_source(content) as binary:
            with io.TextIOWrapper(binary, encoding='utf-8-sig', newline='') as stream:
                yield {'sheetName': 'CSV', 'date1904': False}
                for index, row in enumerate(csv.reader(stream)):
                    if index >= MAX_ROWS:
                        raise MttrImportError('The CSV has more than 2,000,000 rows.')
                    if len(row)>16384:
                        raise MttrImportError('The CSV has more columns than Excel supports.')
                    if any(len(v) > MAX_TEXT for v in row):
                        raise MttrImportError('A CSV cell is too long.')
                    if index == 0 or any(v.strip() for v in row):
                        yield {'_row': index + 1, **{column_name(col+1):value for col,value in enumerate(row)}}
    except UnicodeDecodeError:
        raise MttrImportError('CSV must use UTF-8 encoding; alternatively upload .xlsx.')

def aggregate_tickets(db, table='tickets'):
    return [{'date': r[0], 'count': r[1], 'totalSeconds': r[2]} for r in db.execute(
        f'SELECT substr(closedAt,1,10),count(*),sum(durationSeconds) FROM {table} GROUP BY substr(closedAt,1,10) ORDER BY 1')]

def finish_dataset(result, days, added):
    result = {**result, 'days': days, 'totalTickets': sum(d['count'] for d in days),
              'addedRows': added, 'duplicateRows': result['validRows'] - added,
              'earliestDate': days[0]['date'], 'latestDate': days[-1]['date']}
    return result

def no_valid_error(result, examples):
    details = {k: result[k] for k in ('sourceRows', 'matchedRows', 'validRows', 'missingIds', 'invalidDates', 'negativeDurations', 'excludedRows', 'headerColumns', 'diagnostics', 'sheetName')}
    details['examples'] = examples
    details['columnMapping'] = result.get('columnMapping',DEFAULT_MAPPING)
    headers = '; '.join(f'{k}→{result.get("columnMapping",DEFAULT_MAPPING)[k]}={v or "(blank)"}' for k,v in result['headerColumns'].items())
    observed = '; '.join(f'{k}={json.dumps(v,ensure_ascii=False)}' for k,v in examples.items())
    message = (f'没有可导入工单 / No valid tickets. 工作表 / Sheet: {result["sheetName"]}; '
               f'从第2行读取 / Start row 2; 数据 / Rows {result["sourceRows"]}; '
               f'分类匹配 / Category {result["diagnostics"]["categoryMatches"]}; '
               f'状态CLOSE / Status {result["diagnostics"]["statusMatches"]}; '
               f'同时匹配 / Both {result["matchedRows"]}; '
               f'缺少工单ID / Missing ticket IDs {result["missingIds"]}; '
               f'日期无效 / Invalid dates {result["invalidDates"]}; '
               f'负时长 / Negative durations {result["negativeDurations"]}. '
               f'第1行表头 / Headers: {headers}. 示例 / Examples: {observed}. '
               '原数据未改变 / Existing data unchanged.')
    return MttrImportError(message, details)

@contextmanager
def stage_mttr(content, filename, mapping=None):
    filename = str(filename or '').replace('\\', '/').rsplit('/', 1)[-1][:255]
    suffix = PurePosixPath(filename).suffix.lower()
    if suffix not in ('.xlsx', '.csv'):
        raise MttrImportError('Upload .xlsx or UTF-8 .csv. Save older .xls files as .xlsx first.')
    if not source_size(content):
        raise MttrImportError('The ticket export is empty.')
    result = dict(formatVersion=2, filename=filename, importedAt=datetime.now(timezone.utc).isoformat(), sourceRows=0,
                  matchedRows=0, validRows=0, invalidDates=0, negativeDurations=0, excludedRows=0, missingIds=0,
                  headerColumns={k: '' for k in ('B','F','J','S','U')}, diagnostics={'categoryMatches':0, 'statusMatches':0})
    examples = {k: [] for k in ('S','U','F','J')}
    rows = xlsx_rows(content) if suffix == '.xlsx' else csv_rows(content)
    with tempfile.TemporaryDirectory(prefix='fmemate-mttr-tickets-') as tmp:
        path = tmp + '/tickets.db'
        db = sqlite3.connect(path)
        try:
            db.execute(TICKET_SCHEMA)
            try:
                metadata = next(rows)
                result['sheetName'] = metadata['sheetName']
                chosen, headers, preview = prepare_mapping(rows,result,mapping)
                result['columnMapping'] = chosen
                result['headerColumns'] = {role: normalized(headers.get(column,''))[:200] for role,column in chosen.items()}
                # The preview is bounded; all remaining rows stream from the file.
                from itertools import chain
                for source in chain(preview,rows):
                    if source['_row'] == 1:
                        continue
                    row = {role:source.get(column,'') for role,column in chosen.items()}
                    result['sourceRows'] += 1
                    for key in examples:
                        value = normalized(row.get(key,''))[:100]
                        if value not in examples[key] and len(examples[key]) < 3:
                            examples[key].append(value)
                    domain_match = category(row.get('U','')) in ('RADIO-OSP','RADIO-ISP')
                    status_match = normalized(row.get('S','')).upper() == 'CLOSE'
                    result['diagnostics']['categoryMatches'] += int(domain_match)
                    result['diagnostics']['statusMatches'] += int(status_match)
                    if not domain_match or not status_match:
                        result['excludedRows'] += 1
                        continue
                    result['matchedRows'] += 1
                    ticket_id = str(row.get('B','')).strip()
                    if not ticket_id or len(ticket_id) > 1000:
                        result['missingIds'] += 1
                        continue
                    created = excel_time(row.get('F',''), metadata['date1904'])
                    closed = excel_time(row.get('J',''), metadata['date1904'])
                    if created is None or closed is None:
                        result['invalidDates'] += 1
                        continue
                    seconds = (closed-created).total_seconds()
                    if seconds < 0:
                        result['negativeDurations'] += 1
                        continue
                    result['validRows'] += 1
                    db.execute('INSERT OR IGNORE INTO tickets VALUES (?,?,?,?)',
                               (ticket_id, created.isoformat(), closed.isoformat(), seconds))
                if not result['validRows']:
                    raise no_valid_error(result, examples)
                db.commit()
            except MttrImportError:
                raise
            except (ET.ParseError, zipfile.BadZipFile, RuntimeError, csv.Error, ValueError, OverflowError, KeyError, OSError) as exc:
                raise MttrImportError('The ticket export is corrupt or unsupported. Resave it as .xlsx.') from exc
            finally:
                rows.close()
        finally:
            db.close()
        yield result, path

def import_mttr(content, filename, mapping=None):
    """Standalone preview, deduplicated within this file. Store performs the merge."""
    with stage_mttr(content, filename, mapping) as (result, path):
        with closing(sqlite3.connect(path)) as db:
            days = aggregate_tickets(db)
        return finish_dataset(result, days, sum(d['count'] for d in days))

def validate_dataset(value):
    """Validate compact aggregates when restoring an untrusted backup."""
    v2 = isinstance(value, dict) and value.get('formatVersion') == 2
    if not isinstance(value, dict) or (set(value)-({'columnMapping'} if v2 else set())) != (V2_FIELDS if v2 else set(LEGACY_FIELDS)):
        raise MttrImportError('Invalid MTTR dataset fields.')
    for key, limit in (('filename', 255), ('sheetName', 200), ('importedAt', 100)):
        if not isinstance(value[key], str) or not value[key] or len(value[key]) > limit:
            raise MttrImportError('Invalid MTTR metadata.')
    if datetime.fromisoformat(value['importedAt']).tzinfo is None:
        raise MttrImportError('Invalid MTTR import timestamp.')
    for key in ('sourceRows', 'matchedRows', 'validRows', 'invalidDates', 'negativeDurations', 'excludedRows'):
        if type(value[key]) is not int or not 0 <= value[key] <= MAX_ROWS:
            raise MttrImportError('Invalid MTTR row counts.')
    if v2 and (type(value['missingIds']) is not int or not 0 <= value['missingIds'] <= MAX_ROWS):
        raise MttrImportError('Invalid MTTR missing-ID count.')
    if value['sourceRows'] != value['matchedRows'] + value['excludedRows'] or value['matchedRows'] != value['validRows'] + value['invalidDates'] + value['negativeDurations'] + (value['missingIds'] if v2 else 0):
        raise MttrImportError('Inconsistent MTTR row counts.')
    if v2:
        if 'columnMapping' in value and not valid_mapping(value['columnMapping']):
            raise MttrImportError('Invalid MTTR column mapping.')
        for key in ('totalTickets','addedRows','duplicateRows','missingIds'):
            if type(value[key]) is not int or value[key] < 0 or value[key] > 9007199254740991:
                raise MttrImportError('Invalid MTTR deduplication counts.')
        if value['totalTickets'] < 1 or value['validRows'] != value['addedRows'] + value['duplicateRows'] or value['addedRows'] > value['totalTickets']:
            raise MttrImportError('Inconsistent MTTR deduplication counts.')
        if not isinstance(value['headerColumns'],dict) or set(value['headerColumns']) != {'B','F','J','S','U'} or any(not isinstance(v,str) or len(v)>200 for v in value['headerColumns'].values()):
            raise MttrImportError('Invalid MTTR header metadata.')
        if not isinstance(value['diagnostics'],dict) or set(value['diagnostics']) != {'categoryMatches','statusMatches'} or any(type(v) is not int or not 0<=v<=value['sourceRows'] for v in value['diagnostics'].values()):
            raise MttrImportError('Invalid MTTR filter diagnostics.')
        if value['matchedRows'] > min(value['diagnostics'].values()):
            raise MttrImportError('Inconsistent MTTR filter diagnostics.')
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
        if type(row['count']) is not int or row['count'] <= 0 or row['count'] > (value['totalTickets'] if v2 else MAX_ROWS):
            raise MttrImportError('Invalid MTTR aggregate ticket count.')
        seconds = row['totalSeconds']
        if type(seconds) not in (int, float) or not math.isfinite(seconds) or seconds < 0 or seconds > row['count'] * 315537897600:
            raise MttrImportError('Invalid MTTR aggregate duration.')
        count += row['count']
        previous = day
    if count != (value['totalTickets'] if v2 else value['validRows']) or value['earliestDate'] != days[0]['date'] or value['latestDate'] != days[-1]['date']:
        raise MttrImportError('Inconsistent MTTR aggregate totals.')
    return value
