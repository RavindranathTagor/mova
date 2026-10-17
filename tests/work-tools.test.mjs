import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkTools, isPublicAddress } from '../server/work-tools.mjs';

test('web reader rejects private addresses and redirected internal services', async()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','172.16.2.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','fc00::1','::ffff:127.0.0.1'])assert.equal(isPublicAddress(ip),false,ip);
  let calls=0;
  const tools=createWorkTools({lookupImpl:async()=>[{address:'93.184.216.34',family:4}],requestImpl:async()=>{calls++;return {status:302,headers:{location:'https://127.0.0.1/private'},text:''};}});
  await assert.rejects(tools.call('read_web_page',{url:'http://example.com'}),/HTTPS/);
  await assert.rejects(tools.call('read_web_page',{url:'https://example.com'}),/public/);
  assert.equal(calls,1);
});

test('web reader returns bounded text without scripts and preserves source',async()=>{
 const tools=createWorkTools({lookupImpl:async()=>[{address:'93.184.216.34',family:4}],requestImpl:async()=>({status:200,headers:{'content-type':'text/html'},text:'<html><title>A &amp; B</title><script>steal()</script><style>hidden</style><main>Hello &#x41; &lt;world&gt;</main></html>'})});
 const result=await tools.call('read_web_page',{url:'https://example.com/article'});
 assert.equal(result.title,'A & B');assert.ok(result.text.includes('Hello A <world>'));assert.ok(!result.text.includes('steal'));assert.equal(result.source,'https://example.com/article');assert.equal(result.untrustedContent,true);
 await assert.rejects(tools.call('read_web_page',{url:'https://example.com',shell:'bad'}),/argument/);
});

test('artifacts are verified and idempotent with scoped stable keys',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mova-artifact-'));
 try{const tools=createWorkTools({dataDir:dir});const args={title:'../Report',content:'# Real findings',sourceIds:['evidence-one']};const context={missionId:'one',idempotencyKey:'step-one'};
 const first=await tools.call('save_artifact',args,context);const second=await tools.call('save_artifact',args,context);
 assert.equal(first.id,second.id);assert.ok(first.verifiedAt);assert.equal(first.content,args.content);
 assert.equal((await tools.call('list_artifacts',{})).artifacts.length,1);
 await assert.rejects(tools.call('save_artifact',{...args,content:'changed'},context),/different content/);
 const other=await tools.call('save_artifact',args,{...context,missionId:'two'});assert.notEqual(other.id,first.id);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('search uses real structured provider results and fails visibly without them',async()=>{
 let status=200;
 const tools=createWorkTools({fetchImpl:async()=>new Response(JSON.stringify({results:[{title:'Official result',url:'https://example.com',content:'Real snippet'}]}),{status})});
 const found=await tools.call('web_search',{query:'example'});assert.equal(found.results[0].title,'Official result');assert.equal(found.source,'SearXNG');
 status=503;await assert.rejects(tools.call('web_search',{query:'example'}),/503/);
});

test('repository names cannot escape public GitHub API and calendar uses connected adapter',async()=>{
 const tools=createWorkTools({adapters:{getCalendarEvents:async()=>({events:[{id:'one'}]})}});
 await assert.rejects(tools.call('read_github_repository',{repository:'../private'}),/repository/);
 const result=await tools.call('get_calendar_events',{});assert.equal(result.events[0].id,'one');assert.ok(result.observedAt);
});

test('owned Slack and Discord channels are allowlisted before their messages can become graph evidence', async () => {
 const calls=[];
 const tools=createWorkTools({env:{MOVA_GRAPH_DATA_ATTESTATION:'public_or_owned',SLACK_BOT_TOKEN:'slack-secret',SLACK_ALLOWED_CHANNEL_IDS:'C123',DISCORD_BOT_TOKEN:'discord-secret',DISCORD_ALLOWED_CHANNEL_IDS:'D456'},fetchImpl:async(url,options)=>{
  calls.push({url:String(url),headers:options.headers});
  if(String(url).includes('slack.com'))return new Response(JSON.stringify({ok:true,messages:[{ts:'1.2',text:'Public release is blocked by dependency X'}]}));
  return new Response(JSON.stringify([{id:'42',content:'Dependency X has a fix',timestamp:'2026-10-14T00:00:00.000Z'}]));
 }});
 const slack=await tools.call('read_slack_channel',{channelId:'C123'});
 const discord=await tools.call('read_discord_channel',{channelId:'D456'});
 assert.equal(slack.results[0].id,'1.2');assert.match(slack.results[0].summary,/dependency X/i);
 assert.equal(discord.results[0].id,'42');assert.match(discord.results[0].summary,/fix/i);
 assert.equal(calls.length,2);assert.equal(calls[0].headers.authorization,'Bearer slack-secret');assert.equal(calls[1].headers.authorization,'Bot discord-secret');
 await assert.rejects(tools.call('read_slack_channel',{channelId:'C999'}),/allowlisted/);
 await assert.rejects(tools.call('read_discord_channel',{channelId:'D999'}),/allowlisted/);
});

test('chat-source reads require an explicit public-or-owned graph attestation', async () => {
 const tools=createWorkTools({env:{SLACK_BOT_TOKEN:'slack-secret',SLACK_ALLOWED_CHANNEL_IDS:'C123'},fetchImpl:async()=>new Response(JSON.stringify({ok:true,messages:[]}))});
 await assert.rejects(tools.call('read_slack_channel',{channelId:'C123'}),/public or owned/i);
});

test('external write tools only create proposals until the engine explicitly executes an approved proposal', async () => {
 const calls=[];
 const tools=createWorkTools({env:{MOVA_GRAPH_DATA_ATTESTATION:'public_or_owned',SLACK_BOT_TOKEN:'slack-secret',SLACK_ALLOWED_CHANNEL_IDS:'C123',DISCORD_BOT_TOKEN:'discord-secret',DISCORD_ALLOWED_CHANNEL_IDS:'D456',GITHUB_TOKEN:'github-secret',GITHUB_ALLOWED_REPOSITORIES:'mova/demo'},fetchImpl:async(url,options)=>{
  calls.push({url:String(url),method:options.method||'GET',headers:options.headers,body:options.body});
  return new Response(JSON.stringify(String(url).includes('github.com')?{id:7,html_url:'https://github.com/mova/demo/pull/3#issuecomment-7'}:String(url).includes('slack.com')?{ok:true,ts:'1.3'}:{id:'99',timestamp:'2026-10-14T00:00:00.000Z'}),{status:200});
 }});
 const proposal=await tools.call('propose_github_pr_comment',{repository:'mova/demo',pullNumber:3,body:'This duplicates issue #12.'});
 assert.equal(proposal.proposal.service,'github');assert.equal(calls.length,0);
 const executed=await tools.executeProposal(proposal.proposal);
 assert.equal(executed.status,'VERIFIED');assert.equal(calls[0].method,'POST');assert.match(calls[0].url,/issues\/3\/comments/);assert.equal(calls[0].headers.authorization,'Bearer github-secret');
 const slack=await tools.call('propose_slack_message',{channelId:'C123',text:'A decision needs review.'});
 await tools.executeProposal(slack.proposal);
 assert.match(calls[1].url,/chat\.postMessage/);assert.equal(calls[1].method,'POST');
 const discord=await tools.call('propose_discord_message',{channelId:'D456',text:'A decision needs review.'});
 await tools.executeProposal(discord.proposal);
 assert.match(calls[2].url,/channels\/D456\/messages/);assert.equal(calls[2].method,'POST');
});

test('GitHub issues are created only from an approved issue proposal', async () => {
 const calls=[];
 const tools=createWorkTools({env:{GITHUB_TOKEN:'github-secret',GITHUB_ALLOWED_REPOSITORIES:'mova/demo'},fetchImpl:async(url,options)=>{
  calls.push({url:String(url),method:options.method,body:options.body});
  return new Response(JSON.stringify({id:71,number:19,html_url:'https://github.com/mova/demo/issues/19'}),{status:201});
 }});
 const draft=await tools.call('propose_github_issue',{repository:'mova/demo',title:'PDF export fails with video',body:'Customer report from Discord.',labels:['customer-report']});
 assert.equal(calls.length,0);assert.equal(draft.proposal.operation,'create_issue');
 const receipt=await tools.executeProposal(draft.proposal);
 assert.equal(receipt.status,'VERIFIED');assert.equal(receipt.remoteId,'19');assert.equal(receipt.url,'https://github.com/mova/demo/issues/19');
 assert.equal(calls[0].url,'https://api.github.com/repos/mova/demo/issues');
 assert.deepEqual(JSON.parse(calls[0].body),{title:'PDF export fails with video',body:'Customer report from Discord.',labels:['customer-report']});
});

test('GitHub source code is read only from an allowlisted repository and is bounded evidence', async () => {
 const tools=createWorkTools({env:{GITHUB_TOKEN:'github-secret',GITHUB_ALLOWED_REPOSITORIES:'mova/demo'},fetchImpl:async(url)=>{
  assert.equal(String(url),'https://api.github.com/repos/mova/demo/contents/src/index.js?ref=main');
  return new Response(JSON.stringify({type:'file',encoding:'base64',content:Buffer.from('export const answer = 42;').toString('base64'),html_url:'https://github.com/mova/demo/blob/main/src/index.js'}),{status:200});
 }});
 const result=await tools.call('read_github_code',{repository:'mova/demo',path:'src/index.js',ref:'main'});
 assert.equal(result.results[0].summary,'export const answer = 42;');
 assert.equal(result.results[0].url,'https://github.com/mova/demo/blob/main/src/index.js');
 assert.equal(result.untrustedContent,true);
 await assert.rejects(tools.call('read_github_code',{repository:'mova/demo',path:'../.env'}),/path/);
});

test('GitHub repository snapshot recursively reads every text file within the explicit safety budget', async () => {
 const calls=[];
 const encode=value=>Buffer.from(value,'utf8').toString('base64');
 const tools=createWorkTools({env:{GITHUB_TOKEN:'github-secret',GITHUB_ALLOWED_REPOSITORIES:'mova/demo'},fetchImpl:async(url)=>{
  const target=String(url);calls.push(target);
  if(target==='https://api.github.com/repos/mova/demo')return new Response(JSON.stringify({default_branch:'main'}));
  if(target.endsWith('/git/ref/heads/main'))return new Response(JSON.stringify({object:{sha:'a1b2c3d4'}}));
  if(target.endsWith('/git/commits/a1b2c3d4'))return new Response(JSON.stringify({tree:{sha:'e1f2a3b4'}}));
  if(target.endsWith('/git/trees/e1f2a3b4?recursive=1'))return new Response(JSON.stringify({truncated:false,tree:[
   {path:'README.md',type:'blob',sha:'c0ffee01',size:12},
   {path:'src/index.js',type:'blob',sha:'c0ffee02',size:24},
   {path:'assets/logo.png',type:'blob',sha:'c0ffee03',size:99},
  ]}));
  if(target.endsWith('/git/blobs/c0ffee01'))return new Response(JSON.stringify({encoding:'base64',content:encode('# MOVA demo')}));
  if(target.endsWith('/git/blobs/c0ffee02'))return new Response(JSON.stringify({encoding:'base64',content:encode('export const graph = true;')}));
  throw new Error(`Unexpected request ${target}`);
 }});
 const result=await tools.call('read_github_repository_snapshot',{repository:'mova/demo'});
 assert.equal(result.complete,true);assert.equal(result.scannedFiles,2);assert.equal(result.skippedBinaryFiles,1);
 assert.deepEqual(result.results.map(file=>file.title),['README.md','src/index.js']);
 assert.match(result.results[1].summary,/graph = true/);assert.equal(calls.filter(url=>url.includes('/git/blobs/')).length,2);
});

test('repository tree refuses a response it cannot return completely',async()=>{
 const files=Array.from({length:3001},(_,index)=>({path:`src/file-${index}.ts`,type:'blob',sha:`${index.toString(16).padStart(8,'0')}`,size:1}));
 const tools=createWorkTools({env:{GITHUB_TOKEN:'github-secret',GITHUB_ALLOWED_REPOSITORIES:'mova/demo'},fetchImpl:async url=>{
  const target=String(url);
  if(target==='https://api.github.com/repos/mova/demo')return new Response(JSON.stringify({default_branch:'main'}));
  if(target.endsWith('/git/ref/heads/main'))return new Response(JSON.stringify({object:{sha:'a1b2c3d4'}}));
  if(target.endsWith('/git/commits/a1b2c3d4'))return new Response(JSON.stringify({tree:{sha:'e1f2a3b4'}}));
  if(target.endsWith('/git/trees/e1f2a3b4?recursive=1'))return new Response(JSON.stringify({truncated:false,tree:files}));
  throw new Error(`Unexpected request ${target}`);
 }});
 await assert.rejects(tools.call('read_github_repository_tree',{repository:'mova/demo'}),/cannot return completely/);
});

test('repository snapshots index source imports and expose a FalkorDB blast-radius query',async()=>{
 const indexed=[];
 const operationsGraph={indexRepositorySnapshot:async snapshot=>{indexed.push(snapshot);return {indexedFiles:snapshot.files.length};},repositoryBlastRadius:async target=>({complete:true,source:'FalkorDB repository dependency blast-radius query',observedAt:'2026-10-17T00:00:00.000Z',evidenceKind:'calculated_estimate',query:'MATCH (affected)-[:IMPORTS*]->(changed)',params:target,results:[{id:'mova/demo:src/app.ts',title:'src/app.ts',path:'src/app.ts',hopCount:1,pathCount:1,summary:'src/app.ts depends on src/core.ts.'}]})};
 const tools=createWorkTools({operationsGraph,env:{GITHUB_TOKEN:'github-secret',GITHUB_ALLOWED_REPOSITORIES:'mova/demo'},fetchImpl:async url=>{
  const target=String(url),encode=value=>Buffer.from(value,'utf8').toString('base64');
  if(target==='https://api.github.com/repos/mova/demo')return new Response(JSON.stringify({default_branch:'main'}));
  if(target.endsWith('/git/ref/heads/main'))return new Response(JSON.stringify({object:{sha:'a1b2c3d4'}}));
  if(target.endsWith('/git/commits/a1b2c3d4'))return new Response(JSON.stringify({tree:{sha:'e1f2a3b4'}}));
  if(target.endsWith('/git/trees/e1f2a3b4?recursive=1'))return new Response(JSON.stringify({truncated:false,tree:[{path:'src/app.ts',type:'blob',sha:'c0ffee01',size:12}]}));
  if(target.endsWith('/git/blobs/c0ffee01'))return new Response(JSON.stringify({encoding:'base64',content:encode("import './core';")}));
  throw new Error(`Unexpected request ${target}`);
 }});
 await tools.call('read_github_repository_snapshot',{repository:'mova/demo'});
 assert.equal(indexed.length,1);assert.equal(indexed[0].commitSha,'a1b2c3d4');assert.equal(indexed[0].files[0].path,'src/app.ts');
 const impact=await tools.call('analyze_github_blast_radius',{repository:'mova/demo',path:'src/core.ts'});
 assert.equal(impact.results[0].path,'src/app.ts');assert.match(impact.query,/IMPORTS/);
});

test('GitHub commits are proposed first and execute as one approved atomic ref update', async () => {
 const calls=[];
 const tools=createWorkTools({env:{GITHUB_TOKEN:'github-secret',GITHUB_ALLOWED_REPOSITORIES:'mova/demo'},fetchImpl:async(url,options={})=>{
  calls.push({url:String(url),method:options.method||'GET',body:options.body});
  if(String(url).endsWith('/git/ref/heads/demo%2Ffix'))return new Response(JSON.stringify({object:{sha:'head-sha'}}));
  if(String(url).endsWith('/git/commits/head-sha'))return new Response(JSON.stringify({tree:{sha:'base-tree'}}));
  if(String(url).endsWith('/git/blobs'))return new Response(JSON.stringify({sha:'blob-sha'}),{status:201});
  if(String(url).endsWith('/git/trees'))return new Response(JSON.stringify({sha:'new-tree'}),{status:201});
  if(String(url).endsWith('/git/commits'))return new Response(JSON.stringify({sha:'new-commit',html_url:'https://github.com/mova/demo/commit/new-commit'}),{status:201});
  if(String(url).endsWith('/git/refs/heads/demo%2Ffix'))return new Response(JSON.stringify({object:{sha:'new-commit'}}));
  throw new Error(`Unexpected GitHub request ${url}`);
 }});
 const draft=await tools.call('propose_github_commit',{repository:'mova/demo',branch:'demo/fix',message:'Fix duplicate incident triage',files:[{path:'src/index.js',content:'export const fixed = true;'}]});
 assert.equal(draft.proposal.operation,'create_commit');
 assert.equal(calls.length,0);
 const receipt=await tools.executeProposal(draft.proposal);
 assert.equal(receipt.status,'VERIFIED');
 assert.equal(receipt.remoteId,'new-commit');
 assert.equal(receipt.url,'https://github.com/mova/demo/commit/new-commit');
 assert.equal(calls.at(-1).method,'PATCH');
 assert.deepEqual(JSON.parse(calls.at(-1).body),{sha:'new-commit',force:false});
});
