"""Staged-file MTTR sources stay on disk, including exports over 128 MiB."""
from contextlib import closing
import csv
import io
from pathlib import Path
import sqlite3
import tempfile
import tracemalloc
import unittest
from unittest.mock import patch

from mttr_import import csv_rows, xlsx_rows, source_size, stage_mttr, MttrImportError
from job_mttr_import import stage_pair
from mttr_tests import workbook, HEADER, row
from job_mttr_tests import TT_HEADER, JOB_HEADER, tt, job, csv_bytes


class StreamImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def file(self, name, data):
        path = self.root / name
        path.write_bytes(data)
        return path

    def staged_summary(self, tt_source, tt_name, job_source, job_name):
        with stage_pair(tt_source, tt_name, job_source, job_name) as (summary, path):
            with closing(sqlite3.connect(path)) as db:
                records = db.execute('SELECT * FROM jobs ORDER BY jobId').fetchall()
            return summary, records

    def test_bytes_and_paths_equivalent_for_csv_xlsx_and_mixed_sources(self):
        for ext, serializer in (('csv', csv_bytes), ('xlsx', workbook)):
            tb = serializer([TT_HEADER, tt()])
            jb = serializer([JOB_HEADER, job(), job('J2', person='Engineer ไทย')])
            expected, expected_rows = self.staged_summary(tb, 'tt.'+ext, jb, 'job.'+ext)
            tp, jp = self.file('tt.'+ext, tb), self.file('job.'+ext, jb)
            with patch.object(Path, 'read_bytes', side_effect=AssertionError('no whole-file reads')):
                actual, rows = self.staged_summary(tp, 'tt.'+ext, jp, 'job.'+ext)
                mixed, mixed_rows = self.staged_summary(tb, 'tt.'+ext, jp, 'job.'+ext)
            for result in (expected, actual, mixed):
                result.pop('importedAt')
                for src in result['sources'].values():
                    src.pop('importedAt')
            self.assertEqual(actual, expected)
            self.assertEqual(mixed, expected)
            self.assertEqual(rows, expected_rows)
            self.assertEqual(mixed_rows, expected_rows)

    def test_legacy_staging_also_accepts_paths_and_rejects_empty_staged_files(self):
        p = self.file('legacy.csv', csv_bytes([HEADER, row()]))
        with stage_mttr(p, 'legacy.csv') as (summary, db_path):
            self.assertEqual(summary['validRows'], 1)
            with closing(sqlite3.connect(db_path)) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM tickets').fetchone()[0], 1)
        empty = self.file('empty.csv', b'')
        self.assertEqual(source_size(empty), 0)
        with self.assertRaisesRegex(MttrImportError, 'nonempty'):
            self.staged_summary(empty, 'empty.csv', p, 'job.csv')
        with self.assertRaisesRegex(MttrImportError, 'empty'):
            with stage_mttr(empty, 'empty.csv'):
                pass
        for bad in (str(p), None, 123, bytearray(b'x')):
            with self.assertRaises(MttrImportError):
                source_size(bad)
        with self.assertRaises(MttrImportError):
            source_size(self.root/'missing.csv')

    def test_streams_close_on_mapping_preview_failures_and_unicode_errors(self):
        # Force the bounded 20-row preview, including data past its cutoff.
        unknown = self.file('unknown.csv', b'unknown\n'+b'x\n'*100)
        opened = []
        actual_open = open
        def tracked_open(*args, **kwargs):
            stream = actual_open(*args, **kwargs)
            opened.append(stream)
            return stream
        with patch('mttr_import.open', side_effect=tracked_open, create=True):
            with self.assertRaises(MttrImportError) as error:
                self.staged_summary(unknown, 'tt.csv', b'unused', 'job.csv')
            self.assertEqual(error.exception.details['previewRows'], 20)
            self.assertTrue(opened)
            self.assertTrue(all(stream.closed for stream in opened))
            # A bad byte after the first read buffer must fail while iterating,
            # and retain the explicit UTF-8 validation message.
            invalid = self.file('invalid.csv', b'header\n'+b'x\n'*10000+b'\xff\n')
            with self.assertRaisesRegex(MttrImportError, 'UTF-8'):
                list(csv_rows(invalid))
            self.assertTrue(all(stream.closed for stream in opened))
        # Generator close must release both the ZipFile and its worksheet file.
        xp = self.file('preview.xlsx', workbook([{'A':'unknown'}]+[{'A':'x'}]*100))
        actual_zip = __import__('zipfile').ZipFile
        archives = []
        def tracked_zip(*args, **kwargs):
            archive = actual_zip(*args, **kwargs)
            archives.append(archive)
            return archive
        with patch('mttr_import.zipfile.ZipFile', side_effect=tracked_zip):
            with self.assertRaises(MttrImportError):
                self.staged_summary(xp, 'tt.xlsx', b'unused', 'job.xlsx')
        self.assertTrue(archives)
        self.assertTrue(all(archive.fp is None for archive in archives))
        # Windows cannot rename/delete open source files. Closed files remain
        # reusable after the validation failure on every supported platform.
        xp.rename(self.root/'released.xlsx')

    def test_large_csv_over_128_mib_is_parsed_with_bounded_python_memory(self):
        # These are real, valid Job rows plus an irrelevant long field, not a
        # sparse file or a giant single cell. No large byte/string fixture exists.
        path = self.root/'large-job.csv'
        count = 14000
        padding = 'x'*10000
        with path.open('w', encoding='utf-8-sig', newline='') as stream:
            writer = csv.writer(stream)
            writer.writerow(['jb_id','tt_id','jb_create_date','jb_finish_date','jb_assign_to','jb_status','unused_notes'])
            for index in range(count):
                writer.writerow([f'JOB-{index}','TT1','2026/10/19 0:00:00','2026/10/19 1:00:00','Alice','DONE',padding])
        self.assertGreater(path.stat().st_size, 128*1024*1024)
        tb = csv_bytes([TT_HEADER, tt()])
        tracemalloc.start()
        try:
            with patch.object(Path, 'read_bytes', side_effect=AssertionError('no whole-file reads')):
                with stage_pair(tb, 'tt.csv', path, 'large-job.csv') as (summary, staged):
                    self.assertEqual(summary['sources']['job']['sourceRows'], count)
                    self.assertEqual(summary['sources']['job']['validRows'], count)
                    with closing(sqlite3.connect(staged)) as db:
                        self.assertEqual(db.execute('SELECT count(*),sum(durationSeconds) FROM jobs').fetchone(), (count,count*3600))
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertLess(peak, 24*1024*1024, 'Parser must not materialize the entire CSV in Python memory.')

    def test_path_csv_preserves_limits_and_xlsx_errors(self):
        too_long = self.file('cell.csv', b'column\n'+b'x'*65537+b'\n')
        with self.assertRaisesRegex(MttrImportError, 'cell is too long'):
            list(csv_rows(too_long))
        corrupt = self.file('broken.xlsx', b'not a ZIP')
        with self.assertRaisesRegex(MttrImportError, 'Invalid .xlsx'):
            list(xlsx_rows(corrupt))
        with patch('mttr_import.MAX_EXPANDED', 5):
            valid = self.file('oversize.xlsx', workbook([TT_HEADER, tt()]))
            with self.assertRaisesRegex(MttrImportError, '1 GB limit'):
                list(xlsx_rows(valid))


if __name__ == '__main__':
    unittest.main()
