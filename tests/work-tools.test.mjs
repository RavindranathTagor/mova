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
