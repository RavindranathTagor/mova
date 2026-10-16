import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rename,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../server/store.mjs';

test('checkpoint retries a transient Windows share lock without losing serialized updates',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'mova-store-'));t.after(()=>rm(folder,{recursive:true,force:true}));let attempts=0;const waits=[];
  const store=createStore({path:join(folder,'state.json'),wait:async ms=>waits.push(ms),renameFile:async(a,b)=>{if(++attempts<=2)throw Object.assign(new Error('Share lock'),{code:'EPERM'});return rename(a,b);}});
  await Promise.all([store.save({version:1,sequence:1}),store.save({version:1,sequence:2})]);
  assert.equal((await store.load()).sequence,2);assert.deepEqual(waits,[25,50]);assert.deepEqual(await readdir(folder),['state.json']);
});
test('persistent lock leaves the last checkpoint intact and removes only the new temporary file',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'mova-store-'));t.after(()=>rm(folder,{recursive:true,force:true}));const path=join(folder,'state.json');await createStore({path}).save({sequence:1});let attempts=0;
  const locked=createStore({path,wait:async()=>{},renameFile:async()=>{attempts++;throw Object.assign(new Error('Still locked'),{code:'EACCES'});}});
  await assert.rejects(locked.save({sequence:2}),/Still locked/);assert.equal(attempts,6);assert.equal((await locked.load()).sequence,1);assert.deepEqual(await readdir(folder),['state.json']);
});
