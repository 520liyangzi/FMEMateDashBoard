"""Alarm occurrences are counted per row, elapsed Duration is never derived from dates."""
import csv
from datetime import datetime
import io
from pathlib import Path
import sqlite3
import tempfile
import unittest
from alarm_mttr import init_schema, get_dataset, set_allowlist, stage_import, merge_import, clear_alarm
from mttr_import import MttrImportError, column_index
from mttr_tests import workbook

HEADER={'A':'Site', 'B':'Alarm ID', 'I':'Duration', 'K':'Occurrence Time', 'AE':'Job ID'}
def row(alarm='26540',duration='0:05:10',occurred='2026/11/05  23:59:58',job='Job1',site='Tower A'):
    return {'A':site,'B':alarm,'I':duration,'K':occurred,'AE':job}

def csv_bytes(rows):
    stream=io.StringIO()
    writer=csv.writer(stream)
    for r in rows:
        values=['']*31
        for k,v in r.items():values[column_index(k)-1]=v
        writer.writerow(values)
    return stream.getvalue().encode('utf-8-sig')


class AlarmMttrTest(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        init_schema(self.db)
    def add(self,rows,allow='26540',*,xlsx=False,**kwargs):
        data=workbook([HEADER]+rows,**kwargs) if xlsx else csv_bytes([HEADER]+rows)
        with stage_import(data,'alarm.'+('xlsx' if xlsx else 'csv')) as staged,self.db:
            return merge_import(self.db,staged,allow)

    def test_weight_by_occurrence_keep_repeated_alarm_and_job_id_and_precise_seconds(self):
        d=self.add([row(),row(),row(duration='1:00:00.125',occurred='2026-11-06T00:00:01'),row(job='   '),
                    row(alarm='   '),row(duration='0'),row(duration='00:00:00.000'),row(duration='0:61:00'),
                    row(duration='-2'),row(occurred='2026/02/30 11:25:00'),row(alarm='126540')])
        self.assertEqual(d['days'],[{'date':'2026-11-05','totalSeconds':620.,'count':2},
                                   {'date':'2026-11-06','totalSeconds':3600.125,'count':1}])
        self.assertEqual((d['totalAlarms'],d['storedRows']),(3,4))
        imp=d['lastImport']
        self.assertEqual(tuple(imp[k] for k in ('missingJobIds','missingAlarmIds','invalidDates','invalidDurations','zeroDurations','matchedRows')),(1,1,1,2,2,3))

    def test_overlap_max_multiplicity_including_non_mapped_columns(self):
        self.add([row(),row(site='Tower B')])
        result=self.add([row(),row(),row(site='Tower B')])
        self.assertEqual((result['totalAlarms'],result['lastImport']['duplicateRows'],result['lastImport']['addedRows']),(3,2,1))
        repeated=self.add([row(),row(site='Tower B')])
        self.assertEqual((repeated['totalAlarms'],repeated['lastImport']['addedRows']),(3,0))

    def test_no_matches_reclassify_without_reimport_and_allowlist_empty_never_all(self):
        d=self.add([row(alarm='26540.0'),row(alarm='26564',duration='25:15:20')],'99999')
        self.assertEqual(d['totalAlarms'],0)
        self.assertEqual(d['storedRows'],2)
        d=set_allowlist(self.db,'26540， 26564,26540,,')
        self.assertEqual(d['allowlist'],['26540','26564'])
        self.assertEqual(d['days'],[{'date':'2026-11-05','count':2,'totalSeconds':310.+25*3600+15*60+20}])
        empty=set_allowlist(self.db,'   ')
        self.assertEqual((empty['days'],empty['earliestDate'],empty['latestDate']),([],None,None))
        self.assertEqual(set_allowlist(self.db,'2645')['totalAlarms'],0)
        cleared=clear_alarm(self.db)
        self.assertEqual((cleared['lastImport'],cleared['storedRows'],cleared['allowlist']),(None,0,['2645']))

    def test_real_xlsx_duration_cells_and_1904_occurrence_serial(self):
        serial=(datetime(2026,11,5,6,4)-datetime(1904,1,1)).total_seconds()/86400
        d=self.add([row(duration=('n',310/86400),occurred=('n',serial)),row(duration=('n','0'),occurred=('n',serial)),
                    row(duration=('n','1.5'),occurred=('n',serial+1)),row(duration='2.5',occurred=('n',serial))],
                   xlsx=True,date1904=True)
        self.assertEqual(d['days'],[{'date':'2026-11-05','count':1,'totalSeconds':310.},
                                   {'date':'2026-11-06','count':1,'totalSeconds':36*3600.}])
        self.assertEqual((d['lastImport']['zeroDurations'],d['lastImport']['invalidDurations']),(1,1))

    def test_subsecond_native_excel_occurrence_never_rounds_into_next_date(self):
        d=self.add([row(occurred=('n','46318.99999710648'))],xlsx=True)
        self.assertEqual(d['days'][0]['date'],'2026-10-23')
        same=self.add([row(occurred='2026-10-23 23:59:59.750')])
        self.assertEqual((same['totalAlarms'],same['lastImport']['duplicateRows']),(1,1))

    def test_cross_format_overlap_with_different_native_excel_representations(self):
        self.add([row(duration=('n',310/86400),occurred='2026/11/05 6:40:00',alarm=('n','26540'))],xlsx=True)
        d=self.add([row(occurred='2026-11-05T06:40:00',alarm='26540.0')])
        self.assertEqual((d['totalAlarms'],d['lastImport']['duplicateRows']),(1,1))

    def test_invalid_upload_and_invalid_allowlist_preserve_both_settings_and_history(self):
        original=self.add([row()])
        for records in [[row(duration='0:00:00')],[row(occurred='11/05/2026')],[row(duration='NaN')],[row(duration='01:02:90')]]:
            with self.assertRaises(MttrImportError):
                self.add(records,'999')
            self.assertEqual(get_dataset(self.db),original)
        with self.assertRaises(MttrImportError):
            self.add([row(duration='01:00:00')],['bad,compound'])
        self.assertEqual(get_dataset(self.db),original)

    def test_staged_upload_streams_from_path_and_changed_mapping_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'source.csv'
            path.write_bytes(csv_bytes([HEADER,row(duration='123:45:06')]))
            with stage_import(path,'source.csv') as stage,self.db:
                out=merge_import(self.db,stage,'26540')
            self.assertEqual(out['days'][0]['totalSeconds'],123*3600+45*60+6)
            with self.assertRaises(MttrImportError), stage_import(path,'source.csv','F','minutes'):
                pass

if __name__=='__main__':unittest.main()
