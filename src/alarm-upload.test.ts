import test from 'node:test';
import assert from 'node:assert/strict';
import {createAlarmUploader} from './alarm-upload.ts';

test('one alarm file transfers in bounded slices; a rejected import can be retried without resending or counting any more bytes',async()=>{
  const file=new File(['0123456789'], 'example.csv');
  const uploaded:string[]=[];let sessions=0,attempts=0;const base='/api/mttr/alarms/uploads';
  const api=async(url:string,options?:RequestInit)=>{
    if(url===base){sessions++;assert.deepEqual(JSON.parse(options!.body as string),{alarm:{name:'example.csv',size:10}});return {uploadId:'id',chunkSize:4}}
    if(url===base+'/id/import'){
      const config=JSON.parse(options!.body as string);
      if(++attempts===1){assert.deepEqual(config,{allowlist:'bad'});throw new Error('Import rejected')}
      assert.deepEqual(config,{allowlist:'26540,26564'});return {formatVersion:4,source:'alarms',totalAlarms:5};
    }
    const offset=Number(new URL('https://local'+url).searchParams.get('offset'));assert.equal(offset,uploaded.join('').length);
    const bytes=await (options!.body as Blob).text();assert.ok(bytes.length<=4);uploaded.push(bytes);return {received:offset+bytes.length,total:10};
  };
  const u=createAlarmUploader(api),signal=new AbortController().signal,phases:string[]=[];
  await assert.rejects(u.upload(file,'bad',()=>{},signal),/rejected/);
  assert.equal((await u.upload(file,'26540,26564',p=>phases.push(p.phase),signal)).totalAlarms,5);
  assert.equal(sessions,1);assert.deepEqual(uploaded,['0123','4567','89']);assert.deepEqual(phases,['upload','parse']);
});
