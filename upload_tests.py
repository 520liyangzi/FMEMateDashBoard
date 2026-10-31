"""Large TT/Job uploads: resumable chunks, disk staging, and atomic imports."""
import http.client
import io
import json
import shutil
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request,urlopen
import zipfile
import server as server_module
from server import Store,ReportServer,ApiError
from mttr_uploads import MttrUploads,MttrUploadError,CHUNK_SIZE
from job_mttr_tests import TT_HEADER,JOB_HEADER,tt,job,csv_bytes

class UploadManagerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)/'sessions'
        self.manager=MttrUploads(self.root,max_file_bytes=1024*1024)
    def tearDown(self):self.tmp.cleanup()
    def create(self,tt_size=6,job_size=4):
        return self.manager.create({'tt':{'name':'tt.csv','size':tt_size},'job':{'name':'job.xlsx','size':job_size}})['uploadId']
    def test_append_retry_content_offset_and_partial_integrity(self):
        sid=self.create()
        self.assertEqual(self.manager.append(sid,'tt',0,b'abc'),{'received':3,'total':6})
        self.assertEqual(self.manager.append(sid,'tt',0,b'abc'),{'received':3,'total':6})
        for offset,data in ((0,b'BAD'),(2,b'cde'),(4,b'e'),(3,b'defg')):
            with self.assertRaises(MttrUploadError) as error:self.manager.append(sid,'tt',offset,data)
            self.assertEqual(error.exception.status,409)
        self.assertEqual(self.manager.append(sid,'tt',3,b'def'),{'received':6,'total':6})
        with self.assertRaises(MttrUploadError) as error:self.manager.append(sid,'job',0,b'x'*(CHUNK_SIZE+1))
        self.assertEqual(error.exception.status,413)
    def test_paths_not_bytes_mapping_retry_retains_then_success_removes(self):
        sid=self.create();self.manager.append(sid,'tt',0,b'abcdef');self.manager.append(sid,'job',0,b'1234')
        paths=[]
        def needs_mapping(fields):
            self.assertIsInstance(fields['ttFile']['data'],Path);paths.append(fields['ttFile']['data'])
            raise ApiError(400,'Map columns',{'requiresMapping':True})
        with self.assertRaises(ApiError):self.manager.finish(sid,{},needs_mapping)
        self.assertTrue(paths[0].is_file())
        def success(fields):
            self.assertEqual(json.loads(fields['ttMapping']['value']),{'ttId':'B','category':'U'})
            self.assertIsInstance(fields['jobFile']['data'],Path)
            return {'ok':True}
        self.assertEqual(self.manager.finish(sid,{'ttMapping':{'ttId':'B','category':'U'}},success),{'ok':True})
        self.assertFalse(paths[0].exists());self.assertNotIn(sid,self.manager.sessions)
    def test_partial_import_and_cancel_do_not_call_importer(self):
        sid=self.create();called=[]
        with self.assertRaises(MttrUploadError) as error:self.manager.finish(sid,{},lambda f:called.append(f))
        self.assertEqual(error.exception.status,409);self.assertEqual(called,[])
        self.assertEqual(self.manager.cancel(sid),{'ok':True});self.assertFalse((self.root/sid).exists())
        for invalid in ('../escape','x'*32,'a'*32):
            with self.assertRaises(MttrUploadError):self.manager.cancel(invalid)
    def test_expiry_startup_cleanup_session_cap_and_limits(self):
        now=[1000]
        self.manager=MttrUploads(self.root,max_file_bytes=10,max_sessions=2,ttl=10,clock=lambda:now[0])
        first=self.create();second=self.create()
        with self.assertRaises(MttrUploadError) as error:self.create()
        self.assertEqual(error.exception.status,429)
        with self.assertRaises(MttrUploadError) as error:self.create(tt_size=11)
        self.assertEqual(error.exception.status,413)
        self.manager.cancel(second);self.create()
        # A restart resumes prior staged offsets without keeping files in RAM.
        self.manager.append(first,'tt',0,b'abc')
        resumed=MttrUploads(self.root,max_file_bytes=10,ttl=10,clock=lambda:now[0])
        self.assertEqual(resumed.append(first,'tt',0,b'abc')['received'],3)
        now[0]=1011
        with self.assertRaises(MttrUploadError) as error:resumed.append(first,'tt',3,b'd')
        self.assertEqual(error.exception.status,410)
        fresh=MttrUploads(self.root,max_file_bytes=10,ttl=10,clock=lambda:now[0]);self.assertEqual(fresh.sessions,{})
    def test_disk_write_failure_rolls_back_chunk_and_low_space_blocks_create(self):
        sid=self.create()
        with patch('mttr_uploads.os.fsync',side_effect=OSError('disk full')):
            with self.assertRaises(MttrUploadError) as error:self.manager.append(sid,'tt',0,b'abc')
        self.assertEqual(error.exception.status,507)
        self.assertEqual(self.manager.append(sid,'tt',0,b'abc')['received'],3)
        with patch('mttr_uploads.shutil.disk_usage',return_value=type('Usage',(),{'free':0})()):
            with self.assertRaises(MttrUploadError) as error:self.create()
        self.assertEqual(error.exception.status,507)
    def test_new_session_during_completed_file_cleanup_has_no_stat_race(self):
        sid=self.create();removed=threading.Event();release=threading.Event();errors=[]
        original=shutil.rmtree
        def pause_after_remove(path,*args,**kwargs):
            result=original(path,*args,**kwargs)
            if Path(path)==self.root/sid:removed.set();release.wait(3)
            return result
        def cancel():
            try:self.manager.cancel(sid)
            except Exception as exc:errors.append(exc)
        with patch('mttr_uploads.shutil.rmtree',side_effect=pause_after_remove):
            thread=threading.Thread(target=cancel);thread.start();self.assertTrue(removed.wait(1))
            try:self.assertNotEqual(self.create(),sid)
            finally:release.set();thread.join()
        self.assertEqual(errors,[])
    def test_cancel_during_import_is_rejected_then_success_cleans(self):
        sid=self.create();self.manager.append(sid,'tt',0,b'abcdef');self.manager.append(sid,'job',0,b'1234')
        entered=threading.Event();release=threading.Event();results=[]
        def importing(fields):entered.set();release.wait(3);return {'ok':True}
        thread=threading.Thread(target=lambda:results.append(self.manager.finish(sid,{},importing)));thread.start();self.assertTrue(entered.wait(1))
        try:
            with self.assertRaises(MttrUploadError) as error:self.manager.cancel(sid)
            self.assertEqual(error.exception.status,409)
        finally:release.set();thread.join()
        self.assertEqual(results,[{'ok':True}]);self.assertFalse((self.root/sid).exists())

class ChunkHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.store=Store(Path(self.tmp.name)/'data')
        self.server=ReportServer(('127.0.0.1',0),self.store);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.url='http://127.0.0.1:'+str(self.server.server_port)
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
    def request(self,path,data=None,method='POST',ctype='application/json',headers=None):
        if ctype=='application/json' and data is not None:data=json.dumps(data).encode()
        request=Request(self.url+path,data=data,method=method,headers={'Content-Type':ctype,**(headers or {})})
        with urlopen(request) as response:return json.load(response)
    def create(self,ttdata,jobdata):
        return self.request('/api/mttr/uploads',{'tt':{'name':'tt.csv','size':len(ttdata)},'job':{'name':'job.csv','size':len(jobdata)}})['uploadId']
    def upload(self,sid,source,data,step=80):
        for offset in range(0,len(data),step):
            result=self.request(f'/api/mttr/uploads/{sid}/{source}?offset={offset}',data[offset:offset+step],ctype='application/octet-stream')
            self.assertEqual(result['received'],min(offset+step,len(data)))
    def test_combined_legacy_limit_rejected_but_chunks_import_same_files(self):
        ttdata=csv_bytes([TT_HEADER,tt()]);jobdata=csv_bytes([JOB_HEADER,job()])
        # A deliberately small legacy request cap proves the same logical upload
        # can exceed it while each bounded chunk still uses the unchanged cap.
        boundary='large-logical-pair'
        multipart=(f'--{boundary}\r\nContent-Disposition: form-data; name="ttFile"; filename="tt.csv"\r\n\r\n').encode()+ttdata+(f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="jobFile"; filename="job.csv"\r\n\r\n').encode()+jobdata+f'\r\n--{boundary}--\r\n'.encode()
        with patch.object(server_module,'MAX_BODY',200):
            self.assertGreater(len(ttdata)+len(jobdata),200)
            with self.assertRaises(HTTPError) as error:self.request('/api/mttr/import-pair',multipart,ctype='multipart/form-data; boundary='+boundary)
            self.assertEqual(error.exception.code,413)
            sid=self.create(ttdata,jobdata)
            self.upload(sid,'tt',ttdata);self.upload(sid,'job',jobdata)
            result=self.request(f'/api/mttr/uploads/{sid}/import',{})
        self.assertEqual(result['totalJobs'],1);self.assertEqual(result['days'][0]['totalSeconds'],36000)
        self.assertFalse((self.store.root/'.mttr-uploads'/sid).exists())
        with zipfile.ZipFile(io.BytesIO(self.store.backup())) as z:self.assertFalse(any('mttr-uploads' in name for name in z.namelist()))
    def test_mapping_required_retains_session_retry_no_reupload_and_cancel(self):
        th={'B':'ticket_reference','U':'radio_kind'};jh={'A':'work_reference','B':'parent_reference','G':'started','I':'finished','AG':'engineer','AR':'state'}
        ttdata=csv_bytes([th,tt()]);jobdata=csv_bytes([jh,job()]);sid=self.create(ttdata,jobdata)
        self.upload(sid,'tt',ttdata);self.upload(sid,'job',jobdata)
        with self.assertRaises(HTTPError) as error:self.request(f'/api/mttr/uploads/{sid}/import',{})
        self.assertTrue(json.load(error.exception)['details']['requiresMapping']);self.assertIsNone(self.store.get_mttr())
        tm={'ttId':'B','category':'U'};jm={'jobId':'A','ttId':'B','created':'G','finished':'I','assignee':'AG','status':'AR'}
        result=self.request(f'/api/mttr/uploads/{sid}/import',{'ttMapping':tm,'jobMapping':jm})
        self.assertEqual(result['totalJobs'],1)
        sid2=self.create(ttdata,jobdata);self.upload(sid2,'tt',ttdata)
        with self.assertRaises(HTTPError) as error:self.request(f'/api/mttr/uploads/{sid2}/import',{})
        self.assertEqual(error.exception.code,409)
        self.assertEqual(self.request('/api/mttr/uploads/'+sid2,method='DELETE'),{'ok':True})
        self.assertEqual(self.store.get_mttr(),result)
    def test_origin_put_preflight_and_invalid_offsets(self):
        sid=self.create(b'1234',b'1234')
        for method,path,data,ctype in (('POST','/api/mttr/uploads',{'tt':{'name':'a.csv','size':4},'job':{'name':'b.csv','size':4}},'application/json'),('PUT',f'/api/mttr/uploads/{sid}/tt?offset=0',b'ab','application/octet-stream'),('DELETE','/api/mttr/uploads/'+sid,None,'application/json')):
            with self.assertRaises(HTTPError) as error:self.request(path,data,method,ctype,{'Origin':'http://other.example'})
            self.assertEqual(error.exception.code,403)
        self.assertEqual(self.request(f'/api/mttr/uploads/{sid}/tt?offset=0',b'ab',method='PUT',ctype='application/octet-stream')['received'],2)
        for query in ('offset=-1','offset=1&offset=2','offset=bad','offset=4'):
            with self.assertRaises(HTTPError):self.request(f'/api/mttr/uploads/{sid}/job?{query}',b'a',ctype='application/octet-stream')
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_port)
        connection.putrequest('POST',f'/api/mttr/uploads/{sid}/job?offset=0');connection.putheader('Content-Type','application/octet-stream');connection.putheader('Content-Length',str(CHUNK_SIZE+1));connection.endheaders()
        self.assertEqual(connection.getresponse().status,413);connection.close()

if __name__=='__main__':unittest.main()
