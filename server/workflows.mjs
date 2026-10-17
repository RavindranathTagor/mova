import {randomUUID} from 'node:crypto';
import {createStore} from './store.mjs';

const defaults=[
 {id:'release-review',name:'Release review',description:'Review recent changes, open issues and team discussion before a release.',instructions:'Review the selected repositories and community discussion for release risks. Cite the supporting sources, distinguish facts from uncertainty, and summarize next steps. Do not create issues or post messages.',connectors:['github','discord'],tools:['read_github_repository','read_github_commits','read_github_issues','read_discord_channel'],resources:{}},
 {id:'decision-research',name:'Decision research',description:'Investigate a question and produce a source-linked decision brief.',instructions:'Research the requested question using primary sources and relevant previous decisions. Explain the evidence and uncertainty, compare options, and save a concise decision brief.',connectors:['web','artifacts'],tools:['web_search','read_web_page','save_artifact','list_artifacts'],resources:{}},
 {id:'team-update',name:'Draft a team update',description:'Turn repository activity and team context into a reviewable update.',instructions:'Read the selected repository and community sources. Draft a concise update for the selected channel, supported by evidence. Prepare a proposal for approval; do not claim it has been sent.',connectors:['github','discord'],tools:['read_github_commits','read_github_issues','read_discord_channel','propose_discord_message'],resources:{}},
 {id:'issue-triage',name:'Issue triage',description:'Turn connected reports and repository evidence into a reviewable GitHub issue.',instructions:'Read the selected repository and discussion sources, check for duplicates, then prepare a concise GitHub issue only when the evidence supports it. Never create the issue or notify a channel until the user approves each action.',connectors:['github','discord'],tools:['read_github_issues','read_github_commits','read_discord_channel','propose_github_issue','propose_discord_message'],resources:{}},
 {id:'code-change-review',name:'Code change review',description:'Inspect connected repository source code, calculate the FalkorDB dependency impact, then prepare a reviewable commit.',instructions:'Read a complete repository snapshot when it fits the safety budget, calculate code blast radius from the FalkorDB import graph, then read related source and repository context. If the user explicitly asks for a code change, prepare one bounded commit proposal for a named branch; never commit without approval.',connectors:['github'],tools:['read_github_repository','read_github_repository_tree','read_github_repository_snapshot','analyze_github_blast_radius','read_github_code','read_github_commits','read_github_issues','propose_github_commit'],resources:{}},
 {id:'blast-radius-demo',name:'FalkorDB blast radius demo',description:'Trace a connected customer signal through repository imports, reports, decisions and reviewable actions.',instructions:'Use the selected Discord channel and GitHub repositories automatically. Read the full repository snapshot when it fits the configured safety budget, persist RepositoryFile and IMPORTS relationships in FalkorDB, and run the repository blast-radius query for a changed source file. Connect customer evidence, commits and issues, then use FalkorDB impact ranking before presenting a source-linked brief. Prepare an issue, update or commit only when the user explicitly asks; every external action must remain pending approval.',connectors:['github','discord'],tools:['read_github_repository_tree','read_github_repository_snapshot','analyze_github_blast_radius','read_github_code','read_github_commits','read_github_issues','read_discord_channel','propose_github_issue','propose_github_commit','propose_discord_message'],resources:{}},
];
const services=new Set(['github','discord','slack','web','artifacts','calendar','mcp']);
export const toolService=name=>name.startsWith('mcp_')?'mcp':name.includes('github')?'github':name.includes('discord')?'discord':name.includes('slack')?'slack':name.includes('artifact')?'artifacts':name.includes('calendar')?'calendar':'web';
export function createWorkflows({path='.data/workflows.json',getTools=()=>[]}={}){
 const store=createStore({path});let items=structuredClone(defaults),queue=Promise.resolve();
 const list=()=>structuredClone(items);
 return {
  async init(){const data=await store.load();if(Array.isArray(data.workflows)){const saved=data.workflows;items=[...defaults.map(workflow=>saved.find(item=>item.id===workflow.id)||workflow),...saved.filter(item=>!defaults.some(workflow=>workflow.id===item.id))];}},
  list,
  get(id){const item=items.find(w=>w.id===id);if(!item)throw Object.assign(new Error('Workflow not found.'),{status:404});return structuredClone(item);},
  save(input){const task=queue.then(async()=>{
   const fail=message=>{throw Object.assign(new Error(message),{status:400});};
   if(!input||typeof input!=='object')fail('Provide a workflow.');
   for(const [key,max] of [['name',80],['description',300],['instructions',3000]])if(typeof input[key]!=='string'||!input[key].trim()||input[key].length>max)fail(`Invalid workflow ${key}.`);
   if(!Array.isArray(input.connectors)||!input.connectors.length||input.connectors.some(id=>!services.has(id)))fail('Select supported connectors.');
   const known=new Set(getTools().map(t=>t.name));
   if(!Array.isArray(input.tools)||!input.tools.length||input.tools.length>30||input.tools.some(name=>!known.has(name)||!input.connectors.includes(toolService(name))))fail('Select available tools from the selected connectors.');
   if(input.tools.includes('save_artifact')&&!input.tools.includes('list_artifacts'))fail('Select list artifacts as well, so saved output can be verified.');
   const resources=input.resources||{};
   if(typeof resources!=='object'||Array.isArray(resources))fail('Invalid workflow resources.');
   for(const [service,ids] of Object.entries(resources))if(!['github','discord','slack'].includes(service)||!input.connectors.includes(service)||!Array.isArray(ids)||ids.length>30||ids.some(id=>typeof id!=='string'||!id.trim()||id.length>200))fail('Invalid selected resources.');
   if(input.id&&!items.some(w=>w.id===input.id))fail('Unknown workflow ID.');
   if(!input.id&&items.length>=50)fail('Workflow limit reached (50).');
   const workflow={id:input.id||randomUUID(),name:input.name.trim(),description:input.description.trim(),instructions:input.instructions.trim(),connectors:[...new Set(input.connectors)],tools:[...new Set(input.tools)],resources:structuredClone(resources)};
   const next=input.id?items.map(w=>w.id===input.id?workflow:w):[...items,workflow];await store.save({version:1,workflows:next});items=next;return workflow;
  });queue=task.catch(()=>{});return task;},
 };
}
