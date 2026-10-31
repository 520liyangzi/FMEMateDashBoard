"""MTTR import, filtering, elapsed durations, persistence and HTTP contracts."""
import csv
from datetime import datetime
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import zipfile
from xml.sax.saxutils import escape
from mttr_import import import_mttr, excel_time, validate_dataset, MttrImportError
from server import Store, ReportServer, ApiError

HEADER = {'F': 'created_time', 'J': 'closed_time', 'S': 'tt_status_description', 'U': 'domain'}
def row(start='2026/10/2  6:40:38', end='2026/10/10  3:59:59', status='CLOSE', domain='Radio-OSP'):
    return {'F': start, 'J': end, 'S': status, 'U': domain}
def workbook(rows, shared=None, date1904=False, extras=None):
    result=io.BytesIO()
    with zipfile.ZipFile(result,'w',zipfile.ZIP_DEFLATED) as z:
        z.writestr('xl/workbook.xml', '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'+('<workbookPr date1904="1"/>' if date1904 else '')+'<sheets><sheet name="Ticket export" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        with z.open('xl/worksheets/sheet1.xml','w') as f:
            f.write(b'<worksheet><sheetData>')
            for n, values in enumerate(rows,1):
                cells=[]
                for col,value in values.items():
                    if isinstance(value,tuple):
                        kind,raw=value;cells.append(f'<c r="{col}{n}" t="{kind}"><v>{escape(str(raw))}</v></c>')
                    else:cells.append(f'<c r="{col}{n}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>')
                f.write(('<row>'+''.join(cells)+'</row>').encode())
            f.write(b'</sheetData></worksheet>')
        if shared is not None:z.writestr('xl/sharedStrings.xml','<sst>'+''.join('<si><r><t>'+escape(s)+'</t></r></si>' for s in shared)+'</sst>')
        for k,v in (extras or {}).items():z.writestr(k,v)
    return result.getvalue()
def as_csv(rows):
    result=io.StringIO(newline='');writer=csv.writer(result)
    for data in rows:
        values=['']*21
        for col,v in data.items():
            i=0
            for ch in col:i=i*26+ord(ch)-64
            values[i-1]=v
        writer.writerow(values)
    return result.getvalue().encode('utf-8-sig')

class ImportTests(unittest.TestCase):
    def test_filter_elapsed_times_and_rejections(self):
        rows=[HEADER,row(),row('2026/10/10 0:00:00','2026/10/10 1:00:00',' close ',' Radio-ISP '),row(status='OPEN'),row(domain='Power'),row(start='bad'),row(end='2026/10/1 0:00:00'),row('2026/10/11 0:00:00','2026/10/11 0:00:00'),{}]
        result=import_mttr(workbook(rows),'tickets.xlsx')
        self.assertEqual({k:result[k] for k in ('sourceRows','matchedRows','validRows','invalidDates','negativeDurations','excludedRows')},{'sourceRows':7,'matchedRows':5,'validRows':3,'invalidDates':1,'negativeDurations':1,'excludedRows':2})
        expected=(datetime(2026,10,10,3,59,59)-datetime(2026,10,2,6,40,38)).total_seconds()+3600
        self.assertEqual(result['days'],[{'date':'2026-10-10','count':2,'totalSeconds':expected},{'date':'2026-10-11','count':1,'totalSeconds':0}])
        self.assertEqual(result['earliestDate'],'2026-10-10');self.assertEqual(result['latestDate'],'2026-10-11')
        self.assertEqual(validate_dataset(result),result)
    def test_excel_serial_shared_strings_and_1904_calendar(self):
        values={'F':('n',46296.25),'J':('n',46297.5),'S':('s',0),'U':('s',1)}
        result=import_mttr(workbook([HEADER,values],shared=['CLOSE','Radio-ISP']),'tickets.xlsx')
        self.assertEqual(result['days'][0]['totalSeconds'],108000)
        self.assertEqual(result['days'][0]['date'],excel_time('46297.5').date().isoformat())
        other=import_mttr(workbook([values],shared=['CLOSE','Radio-ISP'],date1904=True),'tickets.xlsx')
        self.assertEqual(other['days'][0]['date'],excel_time('46297.5',True).date().isoformat())
        self.assertNotEqual(other['days'][0]['date'],result['days'][0]['date'])
    def test_invalid_time_rules(self):
        for value in ('2026/2/30 0:00:00','2026/10/1 25:00:00','2026/10/1','60','NaN','-1','1e900'):
            self.assertIsNone(excel_time(value),value)
        self.assertEqual(excel_time('2026/10/2  6:40:38'),datetime(2026,10,2,6,40,38))
        self.assertEqual(excel_time('61'),datetime(1900,3,1))
    def test_csv_equivalence_and_headerless_import(self):
        rows=[HEADER,row(),row(status='OTHER')]
        x=import_mttr(workbook(rows),'x.xlsx');c=import_mttr(as_csv(rows),'x.csv')
        for field in ('days','sourceRows','matchedRows','validRows','excludedRows'):self.assertEqual(x[field],c[field])
        self.assertEqual(import_mttr(as_csv([row()]),'x.csv')['validRows'],1)
    def test_large_sheet_many_shared_strings_no_raw_data(self):
        # Many distinct, unused strings remain on disk rather than a giant Python list.
        strings=['unique-ticket-text-'+str(i) for i in range(30000)]+['CLOSE','Radio-OSP']
        def rows():
            yield HEADER
            for i in range(30000):yield {'A':('s',i),'F':('n',46296.25),'J':('n',46297.5),'S':('s',30000),'U':('s',30001)}
        result=import_mttr(workbook(rows(),shared=strings),'large.xlsx')
        self.assertEqual(result['validRows'],30000);self.assertEqual(len(result['days']),1)
        self.assertEqual(result['days'][0]['totalSeconds'],30000*108000)
        self.assertLess(len(json.dumps(result)),1500)
    def test_malformed_and_unsupported_files_rejected(self):
        for content,name in ((b'bad','x.xlsx'),(b'bad','x.xls'),(workbook([HEADER,row(status='OPEN')]),'x.xlsx'),(workbook([{'F':1,'J':2,'S':('s',12),'U':'Radio-OSP'}],shared=[]),'x.xlsx')):
            with self.assertRaises(MttrImportError):import_mttr(content,name)
        dangerous=workbook([row()],extras={'xl/sharedStrings.xml':'<!DOCTYPE foo [<!ENTITY x "oops">]><sst></sst>'})
        with self.assertRaises(MttrImportError):import_mttr(dangerous,'x.xlsx')
    def test_restore_validation_invariants(self):
        good=import_mttr(workbook([row()]),'x.xlsx')
        for change in ({'validRows':2},{'days':[{'date':'2026-10-10','count':1,'totalSeconds':float('nan')}]},{'days':[{'date':'2026-10-10','count':1,'totalSeconds':-1}]}):
            with self.assertRaises(MttrImportError):validate_dataset({**good,**change})

class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.store=Store(Path(self.tmp.name)/'data')
    def tearDown(self):self.tmp.cleanup()
    def upload(self,content=None):return self.store.import_mttr({'file':{'filename':'tickets.xlsx','data':content or workbook([HEADER,row()])}})
    def test_replace_restart_and_failed_import_atomicity(self):
        first=self.upload();self.assertIsNone(first.get('records'));second=self.upload()
        self.assertEqual(second['validRows'],1);self.assertEqual(Store(self.store.root).get_mttr(),second)
        with self.assertRaises(ApiError):self.upload(b'bad')
        self.assertEqual(self.store.get_mttr(),second)
        self.store.delete_mttr();self.assertIsNone(self.store.get_mttr())
    def test_backup_round_trip_legacy_and_invalid_snapshot(self):
        saved=self.upload();backup=self.store.backup();target=Store(Path(self.tmp.name)/'target');target.restore(backup)
        self.assertEqual(target.get_mttr(),saved)
        dbfile=Path(self.tmp.name)/'legacy.db'
        with zipfile.ZipFile(io.BytesIO(backup)) as z:dbfile.write_bytes(z.read('report.db'))
        with sqlite3.connect(dbfile) as db:db.execute('UPDATE mttr_dataset SET data=?',(json.dumps({**saved,'validRows':100}),))
        def archive():
            out=io.BytesIO()
            with zipfile.ZipFile(out,'w') as z:z.writestr('manifest.json',json.dumps({'format':'fmemate-report-backup','version':1}));z.write(dbfile,'report.db')
            return out.getvalue()
        with self.assertRaises(ApiError):target.restore(archive())
        self.assertEqual(target.get_mttr(),saved)
        with sqlite3.connect(dbfile) as db:db.execute('DROP TABLE mttr_dataset')
        target.restore(archive());self.assertIsNone(target.get_mttr())
    def test_http_contract_and_origin(self):
        server=ReportServer(('127.0.0.1',0),self.store);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        url='http://127.0.0.1:'+str(server.server_port)
        try:
            with urlopen(url+'/api/mttr') as response:self.assertIsNone(json.load(response))
            content=workbook([HEADER,row()]);boundary='mttr-test'
            body=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="tickets.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n').encode()+content+f'\r\n--{boundary}--\r\n'.encode()
            req=Request(url+'/api/mttr/import',data=body,headers={'Content-Type':'multipart/form-data; boundary='+boundary},method='POST')
            with urlopen(req) as response:self.assertEqual(json.load(response)['validRows'],1)
            with self.assertRaises(HTTPError) as error:urlopen(Request(url+'/api/mttr',method='DELETE',headers={'Origin':'http://other.example'}))
            self.assertEqual(error.exception.code,403)
            with urlopen(Request(url+'/api/mttr',method='DELETE')) as response:self.assertEqual(json.load(response),{'ok':True})
            with urlopen(url+'/api/mttr') as response:self.assertIsNone(json.load(response))
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
