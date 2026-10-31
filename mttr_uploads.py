"""Bounded-memory, resumable disk staging for large TT + Job uploads."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import shutil
import threading
import time
import uuid

CHUNK_SIZE=4*1024*1024
DEFAULT_MAX_FILE_BYTES=1024*1024*1024
SESSION_TTL=24*60*60
MAX_SESSIONS=8
SESSION_ID=re.compile(r'^[0-9a-f]{32}$')

class MttrUploadError(Exception):
    def __init__(self,status,message):
        super().__init__(message)
        self.status,self.message=status,message

class Session:
    def __init__(self,upload_id,metadata,path):
        self.id,self.metadata,self.path=upload_id,metadata,path
        self.lock=threading.RLock()

class MttrUploads:
    def __init__(self,root,max_file_bytes=DEFAULT_MAX_FILE_BYTES,max_sessions=MAX_SESSIONS,ttl=SESSION_TTL,clock=None):
        if type(max_file_bytes) is not int or not 0<max_file_bytes<=9007199254740991:
            raise ValueError('MTTR maximum file size must be a positive safe integer.')
        self.root=Path(root).resolve();self.root.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.max_file_bytes,self.max_sessions,self.ttl=max_file_bytes,max_sessions,ttl
        self.clock=clock or time.time
        self.lock=threading.RLock();self.sessions={}
        self._load()

    def _spec(self,value):
        if not isinstance(value,dict) or set(value)!={'name','size'} or not isinstance(value['name'],str):
            raise MttrUploadError(400,'文件信息无效 / Each source requires a filename and byte size.')
        name=value['name'].replace('\\','/').rsplit('/',1)[-1]
        if not name or len(name)>255 or any(ord(c)<32 for c in name) or Path(name).suffix.lower() not in ('.xlsx','.csv'):
            raise MttrUploadError(400,'请上传 .xlsx 或 UTF-8 .csv / Use .xlsx or UTF-8 .csv; resave older .xls files first.')
        size=value['size']
        if type(size) is not int or size<=0:
            raise MttrUploadError(400,'文件不能为空 / Declared file size must be a positive integer.')
        if size>self.max_file_bytes:
            raise MttrUploadError(413,f'文件超过服务器上限 / File exceeds the server limit of {self.max_file_bytes} bytes. Adjust --mttr-max-file-mb if needed.')
        return {'name':name,'size':size}

    def _load(self):
        for path in self.root.iterdir():
            if not path.is_dir() or path.is_symlink() or not SESSION_ID.fullmatch(path.name):continue
            try:
                manifest=path/'metadata.json'
                if manifest.stat().st_size>4096:raise ValueError()
                metadata=json.loads(manifest.read_text(encoding='utf-8'))
                if set(metadata)!={'createdAt','tt','job'} or type(metadata['createdAt']) not in (int,float):raise ValueError()
                if not 0<=metadata['createdAt']<=self.clock()+60:raise ValueError()
                metadata={key:self._spec(metadata[key]) for key in ('tt','job')}|{'createdAt':metadata['createdAt']}
                session=Session(path.name,metadata,path)
                if self.clock()-metadata['createdAt']>=self.ttl:raise ValueError()
                for source in ('tt','job'):
                    file=self._file(session,source)
                    if file.is_symlink() or not file.is_file() or file.stat().st_size>metadata[source]['size']:raise ValueError()
                self.sessions[session.id]=session
            except (OSError,ValueError,KeyError,TypeError,MttrUploadError):shutil.rmtree(path,ignore_errors=True)
        self.cleanup()

    def _file(self,session,source):
        return session.path/(source+Path(session.metadata[source]['name']).suffix.lower())

    def _remove(self,session):
        # Unregister before deleting files: concurrent session creation computes
        # reserved bytes under this lock and must never stat a removed path.
        with self.lock:self.sessions.pop(session.id,None)
        shutil.rmtree(session.path,ignore_errors=True)

    def cleanup(self):
        with self.lock:
            for session in list(self.sessions.values()):
                if self.clock()-session.metadata['createdAt']<self.ttl:continue
                if session.lock.acquire(blocking=False):
                    try:self._remove(session)
                    finally:session.lock.release()

    @contextmanager
    def _session(self,upload_id,blocking=True):
        if not isinstance(upload_id,str) or not SESSION_ID.fullmatch(upload_id):
            raise MttrUploadError(404,'上传会话不存在 / Upload session not found.')
        with self.lock:session=self.sessions.get(upload_id)
        if session is None:raise MttrUploadError(404,'上传会话不存在或已清理 / Upload session is missing or was cleaned up.')
        if not session.lock.acquire(blocking=blocking):
            raise MttrUploadError(409,'文件正在处理中，请稍后重试 / Upload session is busy; retry after the current operation.')
        try:
            with self.lock:current=self.sessions.get(upload_id)
            if current is not session:raise MttrUploadError(404,'上传会话已清理 / Upload session was cleaned up.')
            if self.clock()-session.metadata['createdAt']>=self.ttl:
                self._remove(session)
                raise MttrUploadError(410,'上传会话已过期，请重新上传 / Upload session expired; upload the files again.')
            yield session
        finally:session.lock.release()

    def create(self,payload):
        if not isinstance(payload,dict) or set(payload)!={'tt','job'}:
            raise MttrUploadError(400,'请选择 TT 和 Job 两份文件 / Specify both TT and Job files.')
        specs={source:self._spec(payload[source]) for source in ('tt','job')}
        self.cleanup()
        with self.lock:
            if len(self.sessions)>=self.max_sessions:
                raise MttrUploadError(429,'暂存上传过多，请取消旧上传后重试 / Too many staged uploads; cancel an older session first.')
            remaining=sum(max(0,s.metadata[source]['size']-self._file(s,source).stat().st_size) for s in self.sessions.values() for source in ('tt','job'))
            if shutil.disk_usage(self.root).free < sum(v['size'] for v in specs.values())+remaining+16*1024*1024:
                raise MttrUploadError(507,'磁盘空间不足 / Insufficient disk space for the declared uploads.')
            upload_id=uuid.uuid4().hex;path=self.root/upload_id
            try:
                path.mkdir(mode=0o700)
                metadata={**specs,'createdAt':self.clock()}
                session=Session(upload_id,metadata,path)
                (path/'metadata.json').write_text(json.dumps(metadata,ensure_ascii=False),encoding='utf-8')
                for source in ('tt','job'):self._file(session,source).touch(mode=0o600)
                self.sessions[upload_id]=session
            except OSError as exc:
                shutil.rmtree(path,ignore_errors=True)
                raise MttrUploadError(507,'无法创建暂存文件，请检查磁盘空间 / Cannot create staged files; check disk space.') from exc
        return {'uploadId':upload_id,'chunkSize':CHUNK_SIZE,'maxFileBytes':self.max_file_bytes}

    def append(self,upload_id,source,offset,content):
        if source not in ('tt','job') or type(offset) is not int or offset<0:
            raise MttrUploadError(400,'分块来源或偏移量无效 / Invalid chunk source or offset.')
        if not isinstance(content,bytes) or not 0<len(content)<=CHUNK_SIZE:
            raise MttrUploadError(413,'每个分块须为 1 字节至 4 MiB / Each chunk must contain 1 byte to 4 MiB.')
        with self._session(upload_id) as session:
            path=self._file(session,source);size=session.metadata[source]['size'];received=path.stat().st_size
            if offset>received or offset+len(content)>size:
                raise MttrUploadError(409,f'分块偏移量不符 / Chunk offset mismatch. Received={received}, total={size}.')
            if offset<received:
                if offset+len(content)>received:
                    raise MttrUploadError(409,f'重试分块与已接收范围不一致 / Retry overlaps beyond received bytes ({received}).')
                with path.open('rb') as stream:
                    stream.seek(offset);matches=stream.read(len(content))==content
                if not matches:raise MttrUploadError(409,'重试分块内容不一致 / Retried chunk bytes do not match staged content.')
                return {'received':received,'total':size}
            try:
                with path.open('r+b') as stream:
                    stream.seek(received)
                    if stream.write(content)!=len(content):raise OSError('short write')
                    stream.flush();os.fsync(stream.fileno())
            except OSError as exc:
                try:
                    with path.open('r+b') as stream:stream.truncate(received)
                except OSError:self._remove(session)
                raise MttrUploadError(507,'写入失败，分块未保存，请检查磁盘空间 / Chunk write failed and was rolled back; check disk space.') from exc
            return {'received':received+len(content),'total':size}

    def finish(self,upload_id,payload,importer):
        if not isinstance(payload,dict) or not set(payload)<={'ttMapping','jobMapping'}:
            raise MttrUploadError(400,'导入映射字段无效 / Invalid import mapping fields.')
        with self._session(upload_id) as session:
            fields={}
            for source in ('tt','job'):
                path=self._file(session,source);received=path.stat().st_size;total=session.metadata[source]['size']
                if received!=total:
                    raise MttrUploadError(409,f'{source.upper()} 文件未上传完成 / File upload incomplete: {received}/{total} bytes.')
                fields[source+'File']={'filename':session.metadata[source]['name'],'data':path}
            for key,mapping in payload.items():fields[key]={'value':json.dumps(mapping,ensure_ascii=False)}
            # The lock keeps Paths alive until parsing AND the atomic database
            # transaction finish. Mapping/parse exceptions retain both files.
            result=importer(fields)
            self._remove(session)
            return result

    def cancel(self,upload_id):
        with self._session(upload_id,blocking=False) as session:self._remove(session)
        return {'ok':True}
