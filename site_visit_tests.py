"""Visit records, image ownership, optimistic edits and backup round trips."""
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
from server import Store, ReportServer, ApiError

PNG = b'\x89PNG\r\n\x1a\nvisit-test'

class SiteVisitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / 'data')
    def tearDown(self):
        self.tmp.cleanup()
    def fields(self, **changes):
        data = {'date':'2026-10-31','site':'BPL Zone','description':'Customer demonstration\nNext: follow up.','expectedUpdatedAt':None,'keepPhotos':[]}
        data.update(changes)
        return {'metadata':{'value':json.dumps(data)}, 'photo_0':{'data':PNG}}
    def save(self, **changes):
        return self.store.save_visit(self.fields(**changes))['visit']
    def test_multiple_same_day_backfill_and_restart(self):
        first=self.save(); second=self.save(site='CWT'); early=self.save(date='2026-10-21')
        records=Store(self.store.root).state()['siteVisits']
        self.assertEqual(len(records),3)
        self.assertEqual(records[-1]['id'],early['id'])
        self.assertNotEqual(first['id'],second['id'])
        self.assertEqual((self.store.uploads/first['photos'][0][9:]).read_bytes(),PNG)
    def test_edit_conflict_photo_ownership_and_delete(self):
        first=self.save(); other=self.save()
        fields=self.fields(id=first['id'],expectedUpdatedAt=first['updatedAt'],keepPhotos=first['photos'],description='Edited',date='2026-10-20')
        edited=self.store.save_visit(fields)['visit']
        self.assertEqual(len(edited['photos']),2)
        self.assertEqual(edited['createdAt'],first['createdAt'])
        with self.assertRaises(ApiError) as error:self.store.save_visit(fields)
        self.assertEqual(error.exception.status,409)
        with self.assertRaises(ApiError):self.store.save_visit(self.fields(id=edited['id'],expectedUpdatedAt=edited['updatedAt'],keepPhotos=other['photos']))
        with self.assertRaises(ApiError):self.store.delete_visit(edited['id'],first['updatedAt'])
        self.store.delete_visit(edited['id'],edited['updatedAt'])
        self.assertEqual([v['id'] for v in self.store.state()['siteVisits']],[other['id']])
        self.assertTrue((self.store.uploads/other['photos'][0][9:]).exists())
        self.assertFalse((self.store.uploads/first['photos'][0][9:]).exists())
    def test_atomic_validation_and_photo_removal(self):
        saved=self.save(); before=list(self.store.uploads.iterdir())
        for changes in ({'date':'2026-02-30'},{'site':'x'*201},{'description':'x'*20001},{'keepPhotos':['/uploads/../../file']},{'expectedUpdatedAt':'bad'}):
            with self.assertRaises(ApiError):self.save(**changes)
        bad=self.fields();bad['photo_1']={'data':b'<svg>bad</svg>'}
        with self.assertRaises(ApiError):self.store.save_visit(bad)
        self.assertEqual(list(self.store.uploads.iterdir()),before)
        too_many=self.fields();too_many.update({f'photo_{i}':{'data':PNG} for i in range(11)})
        with self.assertRaises(ApiError):self.store.save_visit(too_many)
        fields=self.fields(id=saved['id'],expectedUpdatedAt=saved['updatedAt']);del fields['photo_0']
        result=self.store.save_visit(fields)['visit'];self.assertEqual(result['photos'],[])
        self.assertFalse((self.store.uploads/saved['photos'][0][9:]).exists())
        empty=self.fields(description='  ');del empty['photo_0']
        with self.assertRaises(ApiError):self.store.save_visit(empty)
    def test_backup_restore_photos_legacy_and_missing_image_atomicity(self):
        saved=self.save(); backup=self.store.backup(); target=Store(Path(self.tmp.name)/'target');target.restore(backup)
        self.assertEqual(target.state()['siteVisits'],[saved])
        self.assertEqual((target.uploads/saved['photos'][0][9:]).read_bytes(),PNG)
        corrupt=io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(backup)) as src,zipfile.ZipFile(corrupt,'w') as out:
            for n in src.namelist():
                if not n.startswith('uploads/'):out.writestr(n,src.read(n))
        with self.assertRaises(ApiError):target.restore(corrupt.getvalue())
        self.assertEqual(target.state()['siteVisits'],[saved])
        dbfile=Path(self.tmp.name)/'legacy.db'
        with zipfile.ZipFile(io.BytesIO(backup)) as z:dbfile.write_bytes(z.read('report.db'))
        with sqlite3.connect(dbfile) as db:db.execute('DROP TABLE site_visits')
        legacy=io.BytesIO()
        with zipfile.ZipFile(legacy,'w') as z:
            z.writestr('manifest.json',json.dumps({'format':'fmemate-report-backup','version':1}));z.write(dbfile,'report.db')
        target.restore(legacy.getvalue());self.assertEqual(target.state()['siteVisits'],[])
    def test_http_multipart_origin_and_log_reset(self):
        server=ReportServer(('127.0.0.1',0),self.store);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f'http://127.0.0.1:{server.server_port}'
        metadata=json.dumps({'date':'2026-10-31','site':'HTTP Test','description':'Saved through multipart','expectedUpdatedAt':None})
        body=(f'--VISIT\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{metadata}\r\n--VISIT\r\nContent-Disposition: form-data; name="photo_0"; filename="field.png"\r\nContent-Type: image/png\r\n\r\n').encode()+PNG+b'\r\n--VISIT--\r\n'
        try:
            req=Request(base+'/api/site-visits',data=body,headers={'Content-Type':'multipart/form-data; boundary=VISIT','Origin':base})
            with urlopen(req) as res:self.assertEqual(res.status,200);saved=json.load(res)['visit']
            req=Request(base+'/api/site-visits',data=body,headers={'Content-Type':'multipart/form-data; boundary=VISIT','Origin':'https://example.com'})
            with self.assertRaises(HTTPError) as error:urlopen(req)
            self.assertEqual(error.exception.code,403)
            req=Request(base+'/api/reset',data=json.dumps({'confirm':'DELETE ALL DATA'}).encode(),headers={'Content-Type':'application/json'})
            with urlopen(req) as res:self.assertEqual(res.status,200)
            self.assertEqual(self.store.state()['siteVisits'],[saved])
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
