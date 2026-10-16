import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRemoteMcp} from '../server/remote-mcp.mjs';

test('remote MCP admits only owner-allowlisted read tools and does not expose tokens',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mova-mcp-test-'));const path=join(dir,'config.json');
 writeFileSync(path,JSON.stringify({servers:[{id:'docs',url:'https://example.com/mcp',tokenEnv:'DOCS_TOKEN',readTools:['read_document','delete_document']}]}));
 let called;
 const client={connect:async()=>{},listTools:async()=>({tools:[{name:'read_document',inputSchema:{type:'object'},annotations:{readOnlyHint:true}},{name:'delete_document',inputSchema:{type:'object'},annotations:{readOnlyHint:false}}]}),callTool:async args=>{called=args;return {content:[{type:'text',text:'Actual evidence'}]};},close:async()=>{}};
 const bridge=createRemoteMcp({env:{MOVA_MCP_CONFIG:path,DOCS_TOKEN:'private-canary'},clientFactory:()=>client,transportFactory:()=>({})});
 try{await bridge.init();assert.deepEqual(bridge.list().map(t=>t.name),['mcp_docs_read_document']);assert.ok(!JSON.stringify(bridge.list()).includes('private-canary'));const result=await bridge.call('mcp_docs_read_document',{id:'doc'});assert.equal(called.name,'read_document');assert.equal(result.text,'Actual evidence');assert.equal(result.untrusted,true);await assert.rejects(bridge.call('mcp_docs_delete_document',{}),/not explicitly allowed/);}finally{await bridge.close();rmSync(dir,{recursive:true,force:true});}
});

test('remote MCP never connects an insecure remote URL and missing setup provides no tools',async()=>{
 const empty=createRemoteMcp({env:{}});await empty.init();assert.deepEqual(empty.list(),[]);
 const dir=mkdtempSync(join(tmpdir(),'mova-mcp-test-'));const path=join(dir,'config.json');writeFileSync(path,JSON.stringify({servers:[{id:'unsafe',url:'http://example.com/mcp',readTools:['read']}]}));
 let connected=false;const bridge=createRemoteMcp({env:{MOVA_MCP_CONFIG:path},clientFactory:()=>{connected=true;return {};}});
 try{await bridge.init();assert.equal(connected,false);assert.equal(bridge.status()[0].status,'unavailable');}finally{rmSync(dir,{recursive:true,force:true});}
});
