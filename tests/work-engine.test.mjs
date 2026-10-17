import test from 'node:test';
import assert from 'node:assert/strict';
import {approveWorkProposal,runWorkMission,validateWorkPlan} from '../server/work-engine.mjs';
const schema=properties=>({type:'object',properties,additionalProperties:false});
const catalog=[{name:'web_search',description:'Search',inputSchema:schema({query:{type:'string'}})},{name:'save_artifact',description:'Save',effect:'write',inputSchema:schema({title:{type:'string'},content:{type:'string'},sourceIds:{type:'array'}})},{name:'list_artifacts',description:'Read artifacts',inputSchema:schema({})}];
const plan=()=>({status:'ready',summary:'Research then save',steps:[{id:'research',title:'Read sources',tool:'web_search',args:{query:'Graph databases'},dependsOn:[]},{id:'report',title:'Save report',tool:'save_artifact',args:{},dependsOn:['research']}]});
function fixture(options={}){
 const mission={id:'work-test',kind:'work',goal:'Research graph databases and save a report',revision:0,receipts:[],trace:[]};let sourceCalls=0,saveCalls=0,modelCalls=0;const artifacts=[];
 const workTools={list:()=>catalog,call:async(name,args,context)=>{if(name==='web_search'){sourceCalls++;return {source:'Search fixture',observedAt:new Date().toISOString(),results:[{title:'Graph source',url:'https://example.org/graph',snippet:'Graph databases represent connected records.'}]};}if(name==='list_artifacts')return {artifacts};if(name==='save_artifact'){saveCalls++;const artifact={id:'saved',...args,idempotencyKey:context.idempotencyKey,verifiedAt:new Date().toISOString()};artifacts.push(artifact);return artifact;}throw new Error('Unknown tool');}};
 const provider={planWork:async()=>plan(),synthesizeWork:async({evidence})=>{modelCalls++;return {answer:'Graph databases represent connected records.',title:'Research report',sourceIds:[evidence[0].id]};},draftAction:async({evidence})=>({content:'Evidence-backed reply.',sourceIds:[evidence[0].id]})};
 const workGraph={sync:async()=>{},snapshot:async()=>({nodes:[],edges:[]}),ready:async m=>({stepIds:m.work.steps.filter(s=>s.status==='pending'&&s.dependsOn.every(id=>m.work.steps.find(d=>d.id===id)?.status==='completed')).map(s=>s.id),query:'bounded test query',params:{}})};
 const callbacks={persist:async()=>{},transition:async(m,state,summary)=>Object.assign(m,{state,summary}),trace:(m,kind,title,detail,extra)=>m.trace.push({kind,title,detail,...extra})};
 return {mission,provider,workTools,workGraph,...callbacks,...options,counts:()=>({sourceCalls,saveCalls,modelCalls})};
}
test('work executes graph-ready typed MCP tools and verifies artifact readback',async()=>{
 const f=fixture();await runWorkMission(f);assert.equal(f.mission.state,'RESOLVED');assert.equal(f.mission.work.artifacts[0].content,f.mission.work.answer);assert.deepEqual(f.counts(),{sourceCalls:1,saveCalls:1,modelCalls:1});assert.ok(f.mission.work.steps.every(s=>s.status==='completed'));await runWorkMission(f);assert.deepEqual(f.counts(),{sourceCalls:1,saveCalls:1,modelCalls:1});
});
test('no graph-ready step means no tool can execute',async()=>{
 const f=fixture();f.workGraph.ready=async()=>({stepIds:[],query:'blocked dependencies',params:{}});await assert.rejects(runWorkMission(f),/graph-ready/);assert.equal(f.counts().sourceCalls,0);
});
test('workflow limits the planner catalog and rejects an unselected tool',async()=>{
 const f=fixture();f.mission.workflow={id:'research',name:'Research',connectors:['web'],tools:['web_search'],instructions:'Research only',resources:{}};
 let catalog;f.provider.planWork=async args=>{catalog=args.tools;return plan();};
 await assert.rejects(runWorkMission(f),/unavailable tool/);
 assert.deepEqual(catalog.map(t=>t.name),['web_search']);assert.equal(f.counts().sourceCalls,0);
});

test('workflow refuses repository reads outside its selected resources',async()=>{
 const f=fixture();f.mission.workflow={id:'issues',name:'Issues',connectors:['github'],tools:['read_github_issues'],resources:{github:['owner/allowed']}};f.mission.connectedResources={github:['owner/allowed']};
 f.workTools.list=()=>[{name:'read_github_issues',description:'Read',inputSchema:schema({repository:{type:'string'}})}];
 f.provider.planWork=async()=>({status:'ready',steps:[{id:'read',title:'Read issues',tool:'read_github_issues',args:{repository:'owner/outside'},dependsOn:[]}]});
 await assert.rejects(runWorkMission(f),/outside the selected workflow/);assert.equal(f.counts().sourceCalls,0);
});

test('general planner receives connected resources and prior context without forcing an incident plan',async()=>{
 const f=fixture();f.mission.goal='Summarize GitHub activity';
 f.mission.connectedResources={github:['owner/repo'],discord:['1559991811965984890']};
 f.mission.previousContext=[{id:'previous',goal:'Remember the release decision'}];
 f.mission.operationalContext={channelId:'1559991811965984890',repository:'owner/repo'};
 let input;f.provider.planWork=async args=>{input=args;return plan();};
 await runWorkMission(f);assert.deepEqual(input.connectedResources,f.mission.connectedResources);assert.equal(input.previousContext[0].id,'previous');assert.equal(f.mission.work.proposals.length,0);
});
test('invented synthesis citations prevent artifact writes',async()=>{
 const f=fixture();f.provider.synthesizeWork=async()=>({answer:'Invented',title:'Bad',sourceIds:['nonexistent']});await assert.rejects(runWorkMission(f),/evidence references/);assert.equal(f.counts().saveCalls,0);
});
test('artifact resume reconciles a prior completed write instead of repeating it',async()=>{
 const f=fixture();await runWorkMission(f);const step=f.mission.work.steps.find(s=>s.tool==='save_artifact');step.status='running';f.mission.work.artifacts=[];await runWorkMission(f);assert.equal(f.counts().saveCalls,1);assert.equal(f.mission.work.artifacts.length,1);
});
test('external actions remain pending proposals after graph-ready evidence is gathered',async()=>{
 const f=fixture();
 f.workTools.list=()=>[...catalog,{name:'propose_github_pr_comment',description:'Prepare comment',effect:'propose',inputSchema:schema({repository:{type:'string'},pullNumber:{type:'integer'},body:{type:'string'}})}];
 f.provider.planWork=async()=>({status:'ready',summary:'Research then propose',steps:[{id:'research',title:'Read source',tool:'web_search',args:{query:'duplicate pull request'},dependsOn:[]},{id:'comment',title:'Prepare PR comment',tool:'propose_github_pr_comment',args:{repository:'mova/demo',pullNumber:3,body:'This duplicates issue #12.'},dependsOn:['research']}]});
 const originalCall=f.workTools.call;let proposals=0;
 f.workTools.call=async(name,args,context)=>name==='propose_github_pr_comment'?(proposals++,{proposal:{id:'proposal-1',service:'github',operation:'comment_on_pull_request',status:'PENDING_APPROVAL',createdAt:new Date().toISOString(),...args}}):originalCall(name,args,context);
 await runWorkMission(f);
 assert.equal(proposals,1);assert.equal(f.mission.work.proposals[0].status,'PENDING_APPROVAL');assert.equal(f.mission.work.proposals[0].id,'proposal-1');
});
test('chat proposals draft their message from retrieved evidence instead of planner placeholders',async()=>{
 const f=fixture();let proposalArgs;
 f.workTools.list=()=>[...catalog,{name:'propose_slack_message',description:'Prepare Slack reply',effect:'propose',inputSchema:schema({channelId:{type:'string'},text:{type:'string'}})}];
 f.provider.planWork=async()=>({status:'ready',summary:'Read then reply',steps:[{id:'read',title:'Read channel',tool:'web_search',args:{query:'rejection history'},dependsOn:[]},{id:'reply',title:'Prepare Slack reply',tool:'propose_slack_message',args:{channelId:'C123',text:''},dependsOn:['read']}]});
 f.provider.draftAction=async({evidence,target})=>{assert.equal(target.channelId,'C123');assert.equal(evidence.length,1);return {content:'The earlier decision rejected this because the priority was zero.',sourceIds:[evidence[0].id]};};
 const original=f.workTools.call;
 f.workTools.call=async(name,args,context)=>name==='propose_slack_message'?(proposalArgs=args,{proposal:{id:'slack-proposal',service:'slack',operation:'post_channel_message',channelId:args.channelId,text:args.text,status:'PENDING_APPROVAL',createdAt:new Date().toISOString()}}):original(name,args,context);
 await runWorkMission(f);
 assert.equal(proposalArgs.text,'The earlier decision rejected this because the priority was zero.');
 assert.equal(f.mission.work.proposals[0].text,proposalArgs.text);
});
test('commit proposals derive reviewed file contents from retrieved evidence',async()=>{
 const f=fixture();let proposalArgs;
 f.workTools.list=()=>[...catalog,{name:'propose_github_commit',description:'Prepare commit',effect:'propose',inputSchema:schema({repository:{type:'string'},branch:{type:'string'},message:{type:'string'},files:{type:'array'}})}];
 f.provider.planWork=async()=>({status:'ready',summary:'Read then prepare a commit',steps:[{id:'read',title:'Read implementation',tool:'web_search',args:{query:'implementation'},dependsOn:[]},{id:'commit',title:'Prepare safe commit',tool:'propose_github_commit',args:{repository:'mova/demo',branch:'mova/fix'},dependsOn:['read']}]});
 f.provider.draftCodeChange=async({target,evidence})=>{assert.deepEqual(target,{repository:'mova/demo',branch:'mova/fix'});assert.equal(evidence.length,1);return {message:'Fix implementation',files:[{path:'src/index.js',content:'export const fixed = true;'}],sourceIds:[evidence[0].id]};};
 const original=f.workTools.call;
 f.workTools.call=async(name,args,context)=>name==='propose_github_commit'?(proposalArgs=args,{proposal:{id:'commit-proposal',service:'github',operation:'create_commit',status:'PENDING_APPROVAL',createdAt:new Date().toISOString(),...args}}):original(name,args,context);
 await runWorkMission(f);
 assert.equal(proposalArgs.message,'Fix implementation');
 assert.deepEqual(proposalArgs.files,[{path:'src/index.js',content:'export const fixed = true;'}]);
 assert.deepEqual(f.mission.work.proposals[0].files,proposalArgs.files);
});
test('approved proposals execute exactly once and rejected proposals never execute',async()=>{
 const mission={revision:2,work:{proposals:[{id:'approve-me',status:'PENDING_APPROVAL',revision:2},{id:'reject-me',status:'PENDING_APPROVAL',revision:2}]},receipts:[]};let calls=0;
 const result=await approveWorkProposal({mission,proposalId:'approve-me',revision:2,execute:async()=>{calls++;return {status:'VERIFIED',source:'GitHub'};}});
 assert.equal(calls,1);assert.equal(result.status,'VERIFIED');assert.equal(mission.work.proposals[0].status,'VERIFIED');
 const rejected=await approveWorkProposal({mission,proposalId:'reject-me',revision:2,reject:true,execute:async()=>{calls++;return {status:'VERIFIED'};}});
 assert.equal(rejected.status,'REJECTED');assert.equal(calls,1);assert.equal(mission.work.proposals[1].status,'REJECTED');
 await assert.rejects(approveWorkProposal({mission,proposalId:'approve-me',revision:2,execute:async()=>({status:'VERIFIED'})}),/pending/);
});
test('unavailable capabilities and cyclic plans fail before tool execution',()=>{
 assert.throws(()=>validateWorkPlan({status:'blocked',summary:'Purchasing is unavailable',steps:[]},catalog),/Purchasing/);const p=plan();p.steps[0].dependsOn=['report'];assert.throws(()=>validateWorkPlan(p,catalog),/cycle/);p.steps[0].dependsOn=[];p.steps[0].tool='shell';assert.throws(()=>validateWorkPlan(p,catalog),/unavailable/);
});
test('code reads and commit proposals are valid graph-planned work tools',()=>{
 const tools=['read_github_code','propose_github_commit','analyze_falkordb_impact'].map(name=>({name}));
 const plan={status:'ready',steps:[
  {id:'read_code',title:'Read implementation',tool:'read_github_code',args:{repository:'mova/demo',path:'src/index.js'},dependsOn:[]},
  {id:'commit',title:'Prepare safe commit',tool:'propose_github_commit',args:{repository:'mova/demo',branch:'mova/fix',message:'Fix implementation',files:[{path:'src/index.js',content:'export const ok = true;'}]},dependsOn:['read_code']},
  {id:'graph',title:'Rank impact',tool:'analyze_falkordb_impact',args:{},dependsOn:['read_code']},
 ]};
 assert.equal(validateWorkPlan(plan,tools).length,3);
});
