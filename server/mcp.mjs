import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// App-owned tools call the single running controller; no second writer or arbitrary Cypher.
const server=new McpServer({name:'mova-mission-tools',version:'0.1.0'});
const base=`http://127.0.0.1:${process.env.PORT||3001}`;
const call=async(path,body)=>{const res=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-mova-client':'mcp'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(180000)});const result=await res.json();if(!res.ok)throw new Error(result.error);return result;};
const content=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
server.registerTool('get_mission_state',{description:'Read current persisted mission state and connector availability.',inputSchema:{},annotations:{readOnlyHint:true}},async()=>content(await call('/api/state')));
server.registerTool('get_mission_graph',{description:'Read bounded mission graph with provenance. No free-form Cypher.',inputSchema:{},annotations:{readOnlyHint:true}},async()=>content((await call('/api/state')).mission?.graph||{nodes:[],edges:[]}));
server.registerTool('create_mission',{description:'Create a live connected-data, location, weather, or calendar mission. FalkorDB governs graph-backed tool execution. Does not authorize external action.',inputSchema:{text:z.string().min(1).max(2000),deadlineMinutes:z.number().positive().max(1440).optional()},annotations:{readOnlyHint:false,destructiveHint:false}},async(args)=>content(await call('/api/missions',args)));
server.registerTool('explain_decision_path',{description:'Read the selected candidate path, evaluated constraints and exact graph query trace.',inputSchema:{},annotations:{readOnlyHint:true}},async()=>{const {mission}=await call('/api/state');return content({plan:mission?.plans.find(p=>p.id===mission.selectedPlanId),queries:mission?.trace.filter(t=>t.query),receipts:mission?.receipts});});
await server.connect(new StdioServerTransport());
