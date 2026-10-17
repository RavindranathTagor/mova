import {createWorkTools} from '../server/work-tools.mjs';
import {createResourceRegistry} from '../server/resource-registry.mjs';
import {createProvider} from '../server/provider.mjs';
const registry=createResourceRegistry();await registry.init();
const resources=registry.list(),tools=createWorkTools();
for(const channelId of resources.discord){const result=await tools.call('read_discord_channel',{channelId});console.log(JSON.stringify({service:'discord',channelId,read:true,messages:result.results.length}));}
for(const repository of resources.github){await tools.call('read_github_repository',{repository});console.log(JSON.stringify({service:'github',repository,read:true}));}
if(process.argv.includes('--planner')){
 const provider=createProvider({env:process.env});
 const result=await provider.planWork({text:'Read the connected Discord discussion and summarize the recent activity in the connected GitHub repositories. Do not create issues or send messages.',tools:tools.list(),connectedResources:resources,previousContext:[]});
 console.log(JSON.stringify({planner:result.status,tools:result.steps?.map(s=>s.tool),asksForInput:result.status==='blocked'}));
 if(result.status!=='ready'||result.steps?.some(s=>s.tool.startsWith('propose_')))process.exitCode=1;
}
