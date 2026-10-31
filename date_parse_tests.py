"""Regression evidence for the reported Job 2026/10/31 18:04:00 date.

Uses synthetic XLSX/CSV; the user's actual workbook is not available here.
"""
from contextlib import closing
from datetime import datetime
import io
from pathlib import Path
import sqlite3
import tempfile
import unittest
import zipfile

from mttr_import import excel_time, xlsx_rows
from job_mttr_import import stage_pair
from server import Store
from mttr_tests import workbook
from job_mttr_tests import TT_HEADER, JOB_HEADER, tt, job, csv_bytes

CREATED = datetime(2026, 10, 31, 17, 4)
FINISHED = datetime(2026, 10, 31, 18, 4)


def styled_workbook(rows, date1904=False):
    """Real XLSX numeric cells with a date style, not formatted date strings."""
    raw = workbook(rows, date1904=date1904)
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw)) as source, zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as target:
        for info in source.infolist():
            value = source.read(info.filename)
            if info.filename == 'xl/worksheets/sheet1.xml':
                value = value.replace(b't="n"', b't="n" s="1"')
            target.writestr(info.filename, value)
        target.writestr('xl/styles.xml', '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy/mm/dd hh:mm:ss"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>')
    return output.getvalue()


class JobDateParseTests(unittest.TestCase):
    def staged_job(self, content, filename='job.xlsx'):
        tb = workbook([TT_HEADER, tt()])
        with stage_pair(tb, 'tt.xlsx', content, filename) as (summary, db_path):
            with closing(sqlite3.connect(db_path)) as db:
                result = db.execute('SELECT createdAt,finishedAt,durationSeconds FROM jobs').fetchone()
            return summary, result

    def test_exact_user_text_slash_double_spaces_and_iso_remain_october_31(self):
        for text in ('2026/10/31 18:04:00', '2026/10/31  18:04:00', ' 2026/10/31\u00a0 18:04:00 ', '2026-10-31T18:04:00'):
            self.assertEqual(excel_time(text), FINISHED)
            data = workbook([JOB_HEADER, job(created='2026/10/31 17:04:00', finished=text)])
            summary, parsed = self.staged_job(data)
            self.assertEqual(summary['mappings']['job']['created'], 'G')
            self.assertEqual(summary['mappings']['job']['finished'], 'I')
            self.assertEqual(parsed, ('2026-10-31T17:04:00', '2026-10-31T18:04:00', 3600))

    def test_styled_numeric_excel_dates_use_the_declared_1900_or_1904_calendar(self):
        for date1904 in (False, True):
            epoch = datetime(1904, 1, 1) if date1904 else datetime(1899, 12, 30)
            start_serial = (CREATED-epoch).total_seconds()/86400
            finish_serial = (FINISHED-epoch).total_seconds()/86400
            data = styled_workbook([JOB_HEADER, job(created=('n', start_serial), finished=('n', finish_serial))], date1904=date1904)
            rows = xlsx_rows(data)
            try:
                metadata = next(rows)
                self.assertEqual(metadata['date1904'], date1904)
                self.assertEqual(next(rows)['_row'], 1)
                numeric = next(rows)['I']
                self.assertEqual(excel_time(numeric, metadata['date1904']), FINISHED)
            finally:
                rows.close()
            _, parsed = self.staged_job(data)
            self.assertEqual(parsed, ('2026-10-31T17:04:00', '2026-10-31T18:04:00', 3600))

    def test_csv_and_xlsx_iso_cell_dates_match_without_timezone_conversion(self):
        rows = [JOB_HEADER, job(created='2026/10/31 17:04:00', finished='2026/10/31 18:04:00')]
        _, csv_result = self.staged_job(csv_bytes(rows), 'job.csv')
        _, xlsx_result = self.staged_job(workbook(rows))
        _, typed_iso = self.staged_job(workbook([JOB_HEADER, job(created=('d', '2026-10-31T17:04:00'), finished=('d', '2026-10-31T18:04:00'))]))
        self.assertEqual(csv_result, xlsx_result)
        self.assertEqual(typed_iso, xlsx_result)
        self.assertEqual(csv_result[1][:10], '2026-10-31')

    def test_header_mapping_uses_job_finish_not_other_future_date_columns(self):
        header = {**JOB_HEADER, 'J':'jb_history_assign_date', 'L':'tt_close_date'}
        data = {**job(created='2026/10/31 17:04:00', finished='2026/10/31 18:04:00'), 'J':'2026/12/14 18:04:00', 'L':'2026/12/14 18:04:00'}
        summary, parsed = self.staged_job(workbook([header, data]))
        self.assertEqual(summary['mappings']['job']['finished'], 'I')
        self.assertEqual(parsed[1], '2026-10-31T18:04:00')

    def test_imported_october_dates_reach_iso_daily_and_person_aggregates_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp)/'data')
            result = store.import_mttr_pair({
                'ttFile': {'filename':'tt.xlsx', 'data':workbook([TT_HEADER, tt()])},
                'jobFile': {'filename':'job.xlsx', 'data':workbook([JOB_HEADER, job(created='2026/10/31 17:04:00', finished='2026/10/31 18:04:00')])},
            })
            self.assertEqual(result['earliestDate'], '2026-10-31')
            self.assertEqual(result['latestDate'], '2026-10-31')
            self.assertEqual(result['days'], [{'date':'2026-10-31', 'count':1, 'totalSeconds':3600}])
            self.assertEqual(result['personDays'], [{'assignee':'Alice', 'date':'2026-10-31', 'count':1, 'totalSeconds':3600}])

    def test_first_valid_job_id_can_retain_a_previously_imported_future_finish_date(self):
        # This is intentional deduplication evidence, not a date parser bug:
        # uploading corrected dates for an existing ID does not replace its row.
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp)/'data')
            def upload(finish):
                return store.import_mttr_pair({
                    'ttFile': {'filename':'tt.xlsx', 'data':workbook([TT_HEADER, tt()])},
                    'jobFile': {'filename':'job.xlsx', 'data':workbook([JOB_HEADER, job(created='2026/10/31 17:04:00', finished=finish)])},
                })
            first = upload('2026/12/14 18:04:00')
            self.assertEqual(first['latestDate'], '2026-12-14')
            second = upload('2026/10/31 18:04:00')
            self.assertEqual(second['sources']['job']['duplicates'], 1)
            self.assertEqual(second['latestDate'], '2026-12-14')
            self.assertEqual(second['days'], first['days'])


if __name__ == '__main__':
    unittest.main()
