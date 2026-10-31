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
from mttr_import import import_mttr, excel_time, validate_dataset, MttrImportError, LEGACY_FIELDS, DEFAULT_MAPPING
from server import Store, ReportServer, ApiError

HEADER = {'B':'ticket_id', 'F': 'created_time', 'J': 'closed_time', 'S': 'tt_status_description', 'U': 'domain'}
def row(start='2026/10/2  6:40:38', end='2026/10/10  3:59:59', status='CLOSE', domain='Radio-OSP', ticket='TT-1'):
    return {'B':ticket, 'F': start, 'J': end, 'S': status, 'U': domain}
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

SHIFTED_MAPPING = {'B':'B','F':'E','J':'R','S':'K','U':'D'}
def shifted_rows(unknown=False, ticket='SHIFT-1'):
    header={'B':'tt_id','D':'customer_radio_field' if unknown else 'domain',
            'E':'ticket_open_timestamp' if unknown else 'tt_create_date',
            'F':'jb_initiate_date','J':'jb_history_assign_date','K':'tt_status_description',
            'R':'ticket_finished_timestamp' if unknown else 'tt_close_date',
            'S':'jb_history_close_by','U':'jb_history_depart_by'}
    data={'B':ticket,'D':'Radio-OSP','E':'2026/10/19 0:00:00','F':'2026/10/20 9:00:00',
          'J':'2026/10/20 12:00:00','K':'CLOSE','R':'2026/10/19 10:00:00','S':'operator-x','U':'operator-y'}
    return header,data

class ImportTests(unittest.TestCase):
    def test_filter_elapsed_times_and_rejections(self):
        rows=[HEADER,row(),row('2026/10/10 0:00:00','2026/10/10 1:00:00',' close ',' Radio-ISP ',ticket='TT-2'),row(status='OPEN'),row(domain='Power'),row(start='bad'),row(end='2026/10/1 0:00:00'),row('2026/10/11 0:00:00','2026/10/11 0:00:00',ticket='TT-3'),{}]
        result=import_mttr(workbook(rows),'tickets.xlsx')
        self.assertEqual({k:result[k] for k in ('sourceRows','matchedRows','validRows','invalidDates','negativeDurations','excludedRows')},{'sourceRows':7,'matchedRows':5,'validRows':3,'invalidDates':1,'negativeDurations':1,'excludedRows':2})
        expected=(datetime(2026,10,10,3,59,59)-datetime(2026,10,2,6,40,38)).total_seconds()+3600
        self.assertEqual(result['days'],[{'date':'2026-10-10','count':2,'totalSeconds':expected},{'date':'2026-10-11','count':1,'totalSeconds':0}])
        self.assertEqual(result['earliestDate'],'2026-10-10');self.assertEqual(result['latestDate'],'2026-10-11')
        self.assertEqual(validate_dataset(result),result)
    def test_excel_serial_shared_strings_and_1904_calendar(self):
        values={'B':'TT-1','F':('n',46296.25),'J':('n',46297.5),'S':('s',0),'U':('s',1)}
        result=import_mttr(workbook([HEADER,values],shared=['CLOSE','Radio-ISP']),'tickets.xlsx')
        self.assertEqual(result['days'][0]['totalSeconds'],108000)
        self.assertEqual(result['days'][0]['date'],excel_time('46297.5').date().isoformat())
        other=import_mttr(workbook([HEADER,values],shared=['CLOSE','Radio-ISP'],date1904=True),'tickets.xlsx')
        self.assertEqual(other['days'][0]['date'],excel_time('46297.5',True).date().isoformat())
        self.assertNotEqual(other['days'][0]['date'],result['days'][0]['date'])
    def test_invalid_time_rules(self):
        for value in ('2026/2/30 0:00:00','2026/10/1 25:00:00','2026/10/1','60','NaN','-1','1e900'):
            self.assertIsNone(excel_time(value),value)
        self.assertEqual(excel_time('2026/10/2  6:40:38'),datetime(2026,10,2,6,40,38))
        self.assertEqual(excel_time('61'),datetime(1900,3,1))
    def test_csv_equivalence_and_first_row_is_always_header(self):
        rows=[HEADER,row(),row(status='OTHER')]
        x=import_mttr(workbook(rows),'x.xlsx');c=import_mttr(as_csv(rows),'x.csv')
        for field in ('days','sourceRows','matchedRows','validRows','excludedRows'):self.assertEqual(x[field],c[field])
        with self.assertRaises(MttrImportError):import_mttr(as_csv([row()]),'x.csv')
        self.assertEqual(import_mttr(as_csv([row(ticket='IGNORED'),row()]),'x.csv',DEFAULT_MAPPING)['validRows'],1)
    def test_large_sheet_many_shared_strings_no_raw_data(self):
        # Many distinct, unused strings remain on disk rather than a giant Python list.
        strings=['unique-ticket-text-'+str(i) for i in range(30000)]+['CLOSE','Radio-OSP']
        def rows():
            yield HEADER
            for i in range(30000):yield {'B':('s',i),'F':('n',46296.25),'J':('n',46297.5),'S':('s',30000),'U':('s',30001)}
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
        good=import_mttr(workbook([HEADER,row()]),'x.xlsx')
        for change in ({'validRows':2},{'days':[{'date':'2026-10-10','count':1,'totalSeconds':float('nan')}]},{'days':[{'date':'2026-10-10','count':1,'totalSeconds':-1}]}):
            with self.assertRaises(MttrImportError):validate_dataset({**good,**change})

    def test_ticket_id_within_file_first_valid_wins(self):
        records=[HEADER,row(status='OPEN',ticket='A'),row(start='bad',ticket='A'),row(ticket=' A '),row(end='2026/10/10 9:00:00',ticket='A'),row(ticket='a'),row(ticket='  ')]
        data=import_mttr(workbook(records),'x.xlsx')
        self.assertEqual(data['sourceRows'],6);self.assertEqual(data['validRows'],3);self.assertEqual(data['addedRows'],2);self.assertEqual(data['duplicateRows'],1)
        self.assertEqual(data['totalTickets'],2);self.assertEqual(data['missingIds'],1);self.assertEqual(data['invalidDates'],1)
        expected=(datetime(2026,10,10,3,59,59)-datetime(2026,10,2,6,40,38)).total_seconds()*2
        self.assertEqual(data['days'][0]['totalSeconds'],expected)
        validate_dataset(data)
    def test_physical_row_two_blank_header_and_empty_rows(self):
        content=workbook([{},row()])
        self.assertEqual(import_mttr(content,'x.xlsx')['sourceRows'],1)
        # Sparse rows with explicit coordinates must use physical row, not encounter index.
        raw=io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(workbook([row(ticket='NO'),row(ticket='YES')]))) as src,zipfile.ZipFile(raw,'w') as out:
            for name in src.namelist():
                body=src.read(name)
                if name.endswith('sheet1.xml'):body=body.replace(b'<row>',b'<row r="1">',1).replace(b'</row><row>',b'</row><row r="2">',1)
                out.writestr(name,body)
        self.assertEqual(import_mttr(raw.getvalue(),'x.xlsx',DEFAULT_MAPPING)['totalTickets'],1)
        sparse=io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(workbook([row()]))) as src,zipfile.ZipFile(sparse,'w') as out:
            for name in src.namelist():
                body=src.read(name)
                if name.endswith('sheet1.xml'):body=body.replace(b'<row>',b'<row r="2">',1)
                out.writestr(name,body)
        self.assertEqual(import_mttr(sparse.getvalue(),'x.xlsx')['totalTickets'],1)
    def test_tolerant_category_dates_and_detailed_failure(self):
        good=row('2026/10/2\u00a0 6:40','2026/10/2 7:40',domain=' Radio\u2011 ISP\u00a0')
        self.assertEqual(import_mttr(workbook([HEADER,good]),'x.xlsx')['days'][0]['totalSeconds'],3600)
        bad=[HEADER,row(status='CLOSED'),row(start='not-a-time'),row(ticket='')]
        with self.assertRaises(MttrImportError) as error:import_mttr(workbook(bad),'x.xlsx')
        details=error.exception.details
        self.assertEqual(details['sourceRows'],3);self.assertEqual(details['matchedRows'],2)
        self.assertEqual(details['invalidDates'],1);self.assertEqual(details['missingIds'],1)
        self.assertEqual(details['diagnostics'],{'categoryMatches':3,'statusMatches':2})
        self.assertEqual(details['headerColumns']['B'],'ticket_id')
        self.assertIn('Existing data unchanged',str(error.exception));self.assertNotIn('TT-1',str(error.exception))

    def test_shifted_columns_auto_detect_csv_and_xlsx(self):
        data=shifted_rows()
        for content,name in ((as_csv(data),'shift.csv'),(workbook(data),'shift.xlsx')):
            result=import_mttr(content,name)
            self.assertEqual(result['columnMapping'],SHIFTED_MAPPING)
            self.assertEqual(result['headerColumns']['F'],'tt_create_date')
            self.assertEqual(result['headerColumns']['J'],'tt_close_date')
            self.assertEqual(result['days'],[{'date':'2026-10-19','count':1,'totalSeconds':36000}])
            validate_dataset(result)
            validate_dataset({k:v for k,v in result.items() if k!='columnMapping'})
    def test_unknown_headers_preview_and_manual_retry(self):
        data=shifted_rows(unknown=True)
        with self.assertRaises(MttrImportError) as error:import_mttr(as_csv(data),'shift.csv')
        detail=error.exception.details
        self.assertTrue(detail['requiresMapping']);self.assertEqual(detail['previewRows'],1)
        self.assertEqual(detail['suggestedMapping'],{'B':'B','S':'K','U':'D'})
        columns={c['column']:c for c in detail['availableColumns']}
        self.assertEqual(columns['J']['header'],'jb_history_assign_date')
        self.assertEqual(columns['B']['samples'],[]);self.assertEqual(columns['E']['samples'],['2026/10/19 0:00:00'])
        self.assertNotIn('SHIFT-1',str(detail))
        result=import_mttr(as_csv(data),'shift.csv',SHIFTED_MAPPING)
        self.assertEqual(result['days'][0]['totalSeconds'],36000)
    def test_ambiguous_headers_and_unknown_outside_fixed_columns_require_mapping(self):
        header,data=shifted_rows();header['F']='created_time'
        with self.assertRaises(MttrImportError) as error:import_mttr(workbook([header,data]),'x.xlsx')
        self.assertTrue(error.exception.details['requiresMapping']);self.assertNotIn('F',error.exception.details['suggestedMapping'])
        # One unrelated nonblank header outside old B/F/J/S/U means this is not a
        # blank-header legacy file. Never silently apply positional defaults.
        with self.assertRaises(MttrImportError) as error:import_mttr(workbook([{'A':'unknown export'},row()]),'x.xlsx')
        self.assertTrue(error.exception.details['requiresMapping'])
    def test_manual_mapping_rejects_missing_duplicate_or_nonexistent_columns(self):
        content=as_csv(shifted_rows(True))
        for bad in ({'B':'B'}, {**SHIFTED_MAPPING,'F':'R'}, {**SHIFTED_MAPPING,'J':'ZZ'}, {**SHIFTED_MAPPING,'J':'XFE'}, {**SHIFTED_MAPPING,'F':'e'}):
            with self.assertRaises(MttrImportError) as error:import_mttr(content,'x.csv',bad)
            self.assertTrue(error.exception.details['requiresMapping'])
    def test_mapping_failure_preview_is_bounded(self):
        header,data=shifted_rows(True)
        content=workbook([header]+[{**data,'B':'PRIVATE-'+str(i),'F':'date-'+str(i)} for i in range(100)])
        with self.assertRaises(MttrImportError) as error:import_mttr(content,'x.xlsx')
        details=error.exception.details
        self.assertEqual(details['previewRows'],20)
        self.assertTrue(all(len(c['samples'])<=3 for c in details['availableColumns']))
        self.assertNotIn('PRIVATE-',str(details))

class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.store=Store(Path(self.tmp.name)/'data')
    def tearDown(self):self.tmp.cleanup()
    def upload(self,content=None):return self.store.import_mttr({'file':{'filename':'tickets.xlsx','data':content or workbook([HEADER,row()])}})
    def test_replace_restart_and_failed_import_atomicity(self):
        first=self.upload();self.assertIsNone(first.get('records'));second=self.upload()
        self.assertEqual(second['validRows'],1);self.assertEqual(second['addedRows'],0);self.assertEqual(second['duplicateRows'],1);self.assertEqual(second['totalTickets'],1);self.assertEqual(Store(self.store.root).get_mttr(),second)
        with self.assertRaises(ApiError):self.upload(b'bad')
        self.assertEqual(self.store.get_mttr(),second)
        corrupt=io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(workbook([HEADER,row(ticket='NEW')]))) as src,zipfile.ZipFile(corrupt,'w') as out:
            for name in src.namelist():
                body=src.read(name)
                if name.endswith('sheet1.xml'):body=body[:-20]
                out.writestr(name,body)
        with self.assertRaises(ApiError):self.upload(corrupt.getvalue())
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
        with sqlite3.connect(dbfile) as db:
            db.execute('DROP TABLE mttr_dataset');db.execute('DROP TABLE mttr_tickets')
        target.restore(archive());self.assertIsNone(target.get_mttr())
    def test_incremental_across_files_backup_restart_and_clear(self):
        first=self.upload(workbook([HEADER,row(ticket='A'),row(ticket='A')]))
        self.assertEqual((first['totalTickets'],first['addedRows'],first['duplicateRows']),(1,1,1))
        second=self.upload(workbook([HEADER,row(ticket='A',end='2026/10/12 0:00:00'),row(ticket='B')]))
        self.assertEqual((second['totalTickets'],second['addedRows'],second['duplicateRows']),(2,1,1))
        self.assertEqual(second['days'][0]['date'],'2026-10-10')
        target=Store(Path(self.tmp.name)/'copy');target.restore(self.store.backup())
        same=target.import_mttr({'file':{'filename':'again.xlsx','data':workbook([HEADER,row(ticket='A'),row(ticket='B')])}})
        self.assertEqual((same['totalTickets'],same['addedRows'],same['duplicateRows']),(2,0,2))
        target.delete_mttr()
        new=target.import_mttr({'file':{'filename':'new.xlsx','data':workbook([HEADER,row(ticket='A')])}})
        self.assertEqual((new['totalTickets'],new['addedRows']),(1,1))
    def test_legacy_migration_failure_keeps_previous_then_rebuilds(self):
        previous=self.upload();legacy={k:previous[k] for k in LEGACY_FIELDS}
        with self.store.connect() as db:
            db.execute('UPDATE mttr_dataset SET data=?',(json.dumps(legacy),));db.execute('DELETE FROM mttr_tickets')
        target=Store(Path(self.tmp.name)/'legacycopy');target.restore(self.store.backup());self.assertEqual(target.get_mttr(),legacy)
        with self.assertRaises(ApiError):target.import_mttr({'file':{'filename':'bad.xlsx','data':workbook([HEADER,row(ticket='')])}})
        self.assertEqual(target.get_mttr(),legacy)
        migrated=target.import_mttr({'file':{'filename':'new.xlsx','data':workbook([HEADER,row(ticket='NEW')])}})
        self.assertEqual(migrated['formatVersion'],2);self.assertEqual(migrated['totalTickets'],1)
    def test_corrupt_ledger_restore_rejected_atomically(self):
        before=self.upload();backup=self.store.backup();dbfile=Path(self.tmp.name)/'bad-ledger.db'
        with zipfile.ZipFile(io.BytesIO(backup)) as src:dbfile.write_bytes(src.read('report.db'))
        with sqlite3.connect(dbfile) as db:db.execute('DELETE FROM mttr_tickets')
        out=io.BytesIO()
        with zipfile.ZipFile(out,'w') as z:z.writestr('manifest.json',json.dumps({'format':'fmemate-report-backup','version':1}));z.write(dbfile,'report.db')
        with self.assertRaises(ApiError):self.store.restore(out.getvalue())
        self.assertEqual(self.store.get_mttr(),before)
    def test_shifted_mapping_failure_preserves_ledger_then_merges_and_restores(self):
        before=self.upload();content=as_csv(shifted_rows(True))
        with self.assertRaises(ApiError) as error:self.store.import_mttr({'file':{'filename':'x.csv','data':content}})
        self.assertTrue(error.exception.details['requiresMapping']);self.assertEqual(self.store.get_mttr(),before)
        def fields(mapping):return {'file':{'filename':'x.csv','data':content},'mapping':{'value':json.dumps(mapping)}}
        with self.assertRaises(ApiError):self.store.import_mttr(fields({**SHIFTED_MAPPING,'F':'R'}))
        self.assertEqual(self.store.get_mttr(),before)
        after=self.store.import_mttr(fields(SHIFTED_MAPPING))
        self.assertEqual((after['totalTickets'],after['addedRows']),(2,1))
        target=Store(Path(self.tmp.name)/'mapped');target.restore(self.store.backup())
        self.assertEqual(target.get_mttr(),after)
        repeat=target.import_mttr(fields(SHIFTED_MAPPING))
        self.assertEqual((repeat['totalTickets'],repeat['addedRows'],repeat['duplicateRows']),(2,0,1))
    def test_http_contract_and_origin(self):
        server=ReportServer(('127.0.0.1',0),self.store);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        url='http://127.0.0.1:'+str(server.server_port)
        try:
            with urlopen(url+'/api/mttr') as response:self.assertIsNone(json.load(response))
            content=workbook([HEADER,row()]);boundary='mttr-test'
            body=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="tickets.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n').encode()+content+f'\r\n--{boundary}--\r\n'.encode()
            req=Request(url+'/api/mttr/import',data=body,headers={'Content-Type':'multipart/form-data; boundary='+boundary},method='POST')
            with urlopen(req) as response:self.assertEqual(json.load(response)['validRows'],1)
            bad=workbook([HEADER,row(status='CLOSED')])
            bad_body=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="bad.xlsx"\r\n\r\n').encode()+bad+f'\r\n--{boundary}--\r\n'.encode()
            with self.assertRaises(HTTPError) as error:urlopen(Request(url+'/api/mttr/import',data=bad_body,headers={'Content-Type':'multipart/form-data; boundary='+boundary},method='POST'))
            self.assertEqual(error.exception.code,400);payload=json.load(error.exception)
            self.assertEqual(payload['details']['diagnostics'],{'categoryMatches':1,'statusMatches':0})
            self.assertIn('Start row 2',payload['error'])
            shifted=as_csv(shifted_rows(True));mapping_json=json.dumps(SHIFTED_MAPPING).encode()
            shifted_body=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="shift.csv"\r\n\r\n').encode()+shifted+f'\r\n--{boundary}--\r\n'.encode()
            with self.assertRaises(HTTPError) as error:urlopen(Request(url+'/api/mttr/import',data=shifted_body,headers={'Content-Type':'multipart/form-data; boundary='+boundary},method='POST'))
            self.assertTrue(json.load(error.exception)['details']['requiresMapping'])
            mapped_body=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="shift.csv"\r\n\r\n').encode()+shifted+(f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="mapping"\r\n\r\n').encode()+mapping_json+f'\r\n--{boundary}--\r\n'.encode()
            with urlopen(Request(url+'/api/mttr/import',data=mapped_body,headers={'Content-Type':'multipart/form-data; boundary='+boundary},method='POST')) as response:
                mapped=json.load(response);self.assertEqual(mapped['columnMapping'],SHIFTED_MAPPING);self.assertEqual(mapped['totalTickets'],2)


            with self.assertRaises(HTTPError) as error:urlopen(Request(url+'/api/mttr',method='DELETE',headers={'Origin':'http://other.example'}))
            self.assertEqual(error.exception.code,403)
            with urlopen(Request(url+'/api/mttr',method='DELETE')) as response:self.assertEqual(json.load(response),{'ok':True})
            with urlopen(url+'/api/mttr') as response:self.assertIsNone(json.load(response))
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
