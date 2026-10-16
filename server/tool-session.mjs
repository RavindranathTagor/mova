import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const toolPolicy = Object.freeze({
  permission:'active_mission_context',timeoutMs:16000,maxRetries:0,
  externalSideEffect:false,risk:'read_only',approval:'not_required',
  verification:'Return actual adapter/query response with source and observation time.',
});

export async function createToolSession(tools,dispatch){
  const descriptors=tools.map(tool=>({...tool,annotations:{readOnlyHint:tool.effect!=='write',destructiveHint:false,idempotentHint:true,openWorldHint:!tool.name.startsWith('get_mission')},_meta:{...toolPolicy,...(tool.effect==='write'?{risk:'local_artifact_write',verification:'Read back the persisted artifact before claiming completion.'}:{})}}));
  const byName=new Map(descriptors.map(t=>[t.name,t]));
  const server=new Server({name:'mova-mission-context',version:'0.1.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:descriptors}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    try{
      const tool=byName.get(request.params.name);
      if(!tool)throw new Error('Tool is not authorized for this mission.');
      const args=request.params.arguments||{};
      const allowed=Object.keys(tool.inputSchema?.properties||{});
      if(Object.keys(args).some(k=>!allowed.includes(k)))throw new Error('Unexpected tool arguments.');
      const value=await dispatch(tool.name,args);
      return {content:[{type:'text',text:JSON.stringify(value)}]};
    }catch(error){
      const message=String(error?.message||'Mission tool failed.').replace(/(?:AIza|sk_|xoxb-|github_pat_)[A-Za-z0-9._-]{12,}/g,'[redacted]').slice(0,500);
      return {isError:true,content:[{type:'text',text:JSON.stringify({error:message})}]};
    }
  });
  const client=new Client({name:'mova-outcome-agent',version:'0.1.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  return {
    list:()=>client.listTools(),
    async call(name,args={}){const result=await client.callTool({name,arguments:args},undefined,{timeout:toolPolicy.timeoutMs});const text=result.content?.find(c=>c.type==='text')?.text;if(!text)throw new Error('Mission tool returned no result.');let value;try{value=JSON.parse(text);}catch{throw new Error('Mission tool returned an invalid response.');}if(result.isError)throw new Error(String(value?.error||'Mission tool failed.'));return value;},
    async close(){await client.close();await server.close();},
  };
}
