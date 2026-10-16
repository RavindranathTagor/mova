import { readFileSync, existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Only the owner-edited backend configuration can add a server or grant a tool.
export function createRemoteMcp({env=process.env,clientFactory=()=>new Client({name:'mova-connected-tools',version:'0.1.0'}),transportFactory=(url,options)=>new StreamableHTTPClientTransport(url,options)}={}){
  const clients=new Map(),catalog=new Map(),states=[];
  let initialized=false;
  async function init(){
    if(initialized)return;initialized=true;
    const path=env.MOVA_MCP_CONFIG;
    if(!path||!existsSync(path))return;
    const file=readFileSync(path,'utf8');if(file.length>32000)throw new Error('MCP configuration is too large.');
    const config=JSON.parse(file);
    if(!Array.isArray(config.servers)||config.servers.length>8)throw new Error('Configure at most eight MCP servers.');
    for(const server of config.servers){
      const state={id:String(server.id||''),status:'unavailable',toolCount:0,detail:'Connection not checked.'};states.push(state);
      let client;
      try{
        if(!/^[a-z][a-z0-9_]{0,20}$/.test(server.id))throw new Error('Invalid server identifier.');
        const url=new URL(server.url);
        if(url.username||url.password||url.hash||url.search)throw new Error('MCP URLs must not contain credentials or query parameters.');
        if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('MCP requires HTTPS or an explicitly configured loopback server.');
        if(!Array.isArray(server.readTools)||!server.readTools.length||server.readTools.length>12)throw new Error('Explicitly allowlist one to twelve read-only tools.');
        const token=server.tokenEnv?env[server.tokenEnv]:undefined;
        if(server.tokenEnv&&!token)throw new Error('The configured credential is missing.');
        client=clientFactory();
        const transport=transportFactory(url,{requestInit:{headers:token?{Authorization:`Bearer ${token}`}:{},redirect:'error'},fetch:(input,options)=>fetch(input,{...options,redirect:'error',signal:AbortSignal.any([...(options?.signal?[options.signal]:[]),AbortSignal.timeout(10000)])}),reconnectionOptions:{maxRetries:0}});
        await client.connect(transport,{timeout:10000});
        const listed=await client.listTools({}, {timeout:10000});
        for(const name of server.readTools){
          const tool=listed.tools.find(item=>item.name===name);
          if(!tool||tool.annotations?.readOnlyHint!==true||tool.annotations?.destructiveHint===true)continue;
          const alias=`mcp_${server.id}_${name}`;
          if(!/^[a-zA-Z0-9_-]{1,100}$/.test(alias)||JSON.stringify(tool.inputSchema).length>5000)continue;
          catalog.set(alias,{name:alias,description:`Read from ${server.id}: ${String(tool.description||name).slice(0,240)}`,inputSchema:tool.inputSchema,effect:'read',serverId:server.id,remoteName:name});
          state.toolCount++;
        }
        clients.set(server.id,client);state.status=state.toolCount?'connected':'unavailable';state.detail=state.toolCount?`${state.toolCount} explicitly allowed read tools available.`:'No allowed tools advertised read-only access.';
      }catch{await client?.close().catch(()=>{});state.detail='Could not connect allowed read tools. Review the server URL, credentials and readTools list.';}
    }
  }
  return {init,list:()=>[...catalog.values()].map(({serverId,remoteName,...tool})=>tool),status:()=>states.map(row=>({...row})),
    async call(name,args){const tool=catalog.get(name);if(!tool)throw new Error('Remote tool is not explicitly allowed.');if(JSON.stringify(args).length>8000)throw new Error('Remote tool arguments are too large.');
      const response=await clients.get(tool.serverId).callTool({name:tool.remoteName,arguments:args},undefined,{timeout:12000});
      if(response.isError)throw new Error('The connected MCP tool reported failure.');
      const text=(response.content||[]).filter(item=>item.type==='text').map(item=>item.text).join('\n').slice(0,16000);
      if(!text)throw new Error('The remote tool returned no supported text evidence.');
      return {source:`MCP ${tool.serverId}/${tool.remoteName}`,observedAt:new Date().toISOString(),evidenceKind:'observed',text,untrusted:true};
    },async close(){await Promise.allSettled([...clients.values()].map(client=>client.close()));}};
}
