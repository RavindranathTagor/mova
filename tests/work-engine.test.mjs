import test from 'node:test';
import assert from 'node:assert/strict';
import {approveWorkProposal,runWorkMission,validateWorkPlan} from '../server/work-engine.mjs';
const schema=properties=>({type:'object',properties,additionalProperties:false});
const catalog=[{name:'web_search',description:'Search',inputSchema:schema({query:{type:'string'}})},{name:'save_artifact',description:'Save',effect:'write',inputSchema:{...schema({title:{type:'string',minLength:1,maxLength:200},content:{type:'string',minLength:1,maxLength:100000},sourceIds:{type:'array',maxItems:100}}),required:['title','content','sourceIds']}},{name:'list_artifacts',description:'Read artifacts',inputSchema:schema({})}];
const plan=()=>({status:'ready',summary:'Research then save',steps:[{id:'research',title:'Read sources',tool:'web_search',args:{query:'Graph databases'},dependsOn:[]},{id:'report',title:'Save report',tool:'save_artifact',args:{title:'Research report',sourceIds:[]},dependsOn:['research']}]});
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
test('artifact plans defer missing, empty, and whitespace content to evidence-backed synthesis',async()=>{
 for(const plannerContent of [undefined,'',' \n ','Unverified planner text']){
  const f=fixture();f.provider.planWork=async()=>{const next=plan();if(plannerContent!==undefined)next.steps[1].args.content=plannerContent;return next;};
  await runWorkMission(f);
  assert.equal(f.mission.state,'RESOLVED');
  assert.equal(f.mission.work.artifacts[0].content,'Graph databases represent connected records.');
  assert.deepEqual(f.mission.work.artifacts[0].sourceIds,[f.mission.work.evidence[0].id]);
  assert.equal(f.counts().saveCalls,1);
 }
});
test('missing, empty, and whitespace-only synthesized content fail before artifact execution',async()=>{
 for(const content of [undefined,'',' \n\t']){
  const f=fixture();let planCalls=0;
  f.provider.planWork=async()=>{planCalls++;return plan();};
  f.provider.synthesizeWork=async({evidence})=>({...(content===undefined?{}:{answer:content}),title:'Research report',sourceIds:[evidence[0].id]});
  await assert.rejects(runWorkMission(f),/synthesized answer content/i);
  assert.equal(planCalls,1,'an invalid plan is not automatically requested again');
  assert.equal(f.counts().sourceCalls,1);
  assert.equal(f.counts().saveCalls,0);
  assert.equal(f.mission.work.steps.find(step=>step.id==='report').status,'failed');
  assert.match(f.mission.work.steps.find(step=>step.id==='report').summary,/synthesized answer content/i);
 }
});
test('resuming a failed artifact step preserves completed work, evidence, and mission history',async()=>{
 const f=fixture();const evidence={id:'existing-evidence',stepId:'research',title:'Existing source',source:'Search fixture',observedAt:new Date().toISOString(),summary:'Previously verified finding.',stale:false};
 f.mission.work={steps:[
  {id:'research',title:'Read sources',tool:'web_search',args:{query:'Graph databases'},dependsOn:[],status:'completed',summary:'Retrieved 1 source record.'},
  {id:'report',title:'Save report',tool:'save_artifact',args:{title:'Research report',sourceIds:[]},dependsOn:['research'],status:'failed',summary:'Prior invalid generated content.'},
 ],evidence:[evidence],artifacts:[],proposals:[]};
 f.mission.work.planRevision=f.mission.revision;f.mission.trace.push({title:'Existing investigation history'});f.mission.receipts.push({id:'existing-receipt'});
 const priorEvidence=structuredClone(f.mission.work.evidence),priorRevision=f.mission.revision,priorMissionId=f.mission.id;
 await runWorkMission(f);
 assert.equal(f.mission.id,priorMissionId);assert.equal(f.mission.revision,priorRevision);
 assert.equal(f.mission.work.steps.find(step=>step.id==='research').status,'completed');
 assert.deepEqual(f.mission.work.evidence.filter(item=>item.id==='existing-evidence'),priorEvidence);
 assert.ok(f.mission.trace.some(item=>item.title==='Existing investigation history'));
 assert.ok(f.mission.receipts.some(item=>item.id==='existing-receipt'));
 assert.equal(f.counts().sourceCalls,0);
 assert.equal(f.counts().saveCalls,1);
});
test('citation failure records a source-limited result once and preserves resumed work',async()=>{
 const f=fixture();const observedAt=new Date().toISOString();f.mission.goal='Compare GitHub issues and recommend the highest-priority improvement.';
 const evidence=[
  {id:'empty-search-1',stepId:'read-1',title:'GitHub issue search returned no matches',url:'https://github.com/owner/demo/issues?q=first',source:'GitHub issues',observedAt,summary:'No issue records matched the first search.',stale:false},
  {id:'empty-search-2',stepId:'read-2',title:'GitHub issue search returned no matches',url:'https://github.com/owner/demo/issues?q=second',source:'GitHub issues',observedAt,summary:'No issue records matched the second search.',stale:false},
 ];
 f.mission.work={steps:[
  {id:'read-1',title:'Search first issue',tool:'read_github_issues',args:{repository:'owner/demo'},dependsOn:[],status:'completed',summary:'No issue records matched.'},
  {id:'read-2',title:'Search second issue',tool:'read_github_issues',args:{repository:'owner/demo'},dependsOn:[],status:'completed',summary:'No issue records matched.'},
 ],evidence,artifacts:[],proposals:[]};
 f.mission.work.planRevision=f.mission.revision;
 f.mission.trace.push({title:'Existing investigation history'});f.mission.receipts.push({id:'existing-receipt'});
 let synthesisCalls=0;f.provider.synthesizeWork=async()=>{synthesisCalls++;return {answer:'GitHub issue #6 is the highest priority.',title:'Unsupported result',sourceIds:['not-current']};};
 const priorEvidence=structuredClone(evidence);
 await runWorkMission(f);
 assert.equal(f.mission.id,'work-test');assert.equal(f.mission.state,'BLOCKED');
 assert.equal(synthesisCalls,2,'the model receives only one constrained retry');
 assert.match(f.mission.work.answer,/could not verify a source-backed conclusion/i);
 assert.match(f.mission.work.answer,/No repository or issue findings are asserted/i);
 assert.deepEqual(f.mission.work.sourceIds,['empty-search-1','empty-search-2']);
 assert.deepEqual(f.mission.work.evidence,priorEvidence);
 assert.ok(f.mission.trace.some(item=>item.title==='Existing investigation history'));
 assert.ok(f.mission.receipts.some(item=>item.id==='existing-receipt'));
 assert.ok(f.mission.summary.includes('source-limited result'));
 assert.equal(f.counts().sourceCalls,0);
 await runWorkMission(f);
 assert.equal(synthesisCalls,2,'resuming reuses the persisted limitation rather than retrying');
 assert.equal(f.counts().sourceCalls,0);
});
test('no graph-ready step means no tool can execute',async()=>{
 const f=fixture();f.workGraph.ready=async()=>({stepIds:[],query:'blocked dependencies',params:{}});await assert.rejects(runWorkMission(f),/graph-ready/);assert.equal(f.counts().sourceCalls,0);
});
test('resume locally rechecks saved dependencies when FalkorDB releases no previously blocked step',async()=>{
 const f=fixture();let analysisCalls=0;
 const evidence={id:'read-evidence',stepId:'read',title:'Verified source',source:'GitHub',observedAt:new Date().toISOString(),summary:'The repository dependency is React.',evidenceKind:'observed',stale:false};
 f.mission.work={steps:[
  {id:'read',title:'Read dependency manifest',tool:'read_github_code',args:{repository:'owner/demo',path:'package.json'},dependsOn:[],status:'completed',summary:'Retrieved 1 source record.'},
  {id:'impact',title:'Analyze dependency impact',tool:'analyze_falkordb_impact',args:{},dependsOn:['read'],status:'blocked',summary:'Skipped because a required step did not produce verified evidence.'},
  {id:'report',title:'Save dependency report',tool:'save_artifact',args:{title:'Dependency report',sourceIds:[]},dependsOn:['impact'],status:'blocked',summary:'Skipped because a required step did not produce verified evidence.'},
 ],evidence:[evidence],artifacts:[],proposals:[]};
 f.workGraph.ready=async()=>({stepIds:[],query:'empty result despite saved evidence',params:{}});
 f.workGraph.analyzeImpact=async()=>{analysisCalls++;return {source:'FalkorDB',observedAt:new Date().toISOString(),evidenceKind:'calculated_estimate',results:[{id:'impact-evidence',title:'Dependency impact path',summary:'The graph connects the dependency evidence to the investigation.'}]}};
 f.provider.synthesizeWork=async({evidence:items})=>({answer:'The graph-linked dependency evidence is available.',title:'Verified result',sourceIds:[items[0].id]});
 await runWorkMission(f);
 assert.equal(analysisCalls,1);
 assert.equal(f.mission.work.steps.find(step=>step.id==='read').status,'completed');
 assert.equal(f.mission.work.steps.find(step=>step.id==='impact').status,'completed');
 assert.equal(f.mission.work.steps.find(step=>step.id==='report').status,'completed');
 assert.ok(f.mission.work.evidence.some(item=>item.id==='read-evidence'&&!item.stale));
 assert.ok(f.mission.trace.some(item=>item.title==='Revalidating saved dependency before resume'));
 assert.ok(f.mission.work.artifacts.length);
 assert.equal(f.mission.state,'RESOLVED');
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
test('proposal-only Discord GitHub plans get real repository reads before any action draft',async()=>{
 const f=fixture();f.mission.goal='Use agents-playground to create feature issues and report back in Discord';f.mission.connectedResources={github:['RavindranathTagor/Agents-Playground','RavindranathTagor/slate-pad'],discord:['1559991811965984890']};
 const readSchema=schema({repository:{type:'string'},query:{type:'string'}});
 f.workGraph.analyzeImpact=async()=>({source:'FalkorDB impact query',observedAt:new Date().toISOString(),results:[{title:'Connected evidence rank',summary:'FalkorDB ranked the retrieved repository evidence.',pathCount:2}],evidenceKind:'calculated_estimate'});
 f.workTools.list=()=>[...catalog,{name:'read_github_issues',description:'Search repository issues',effect:'read',inputSchema:readSchema},{name:'read_github_repository',description:'Read repository',effect:'read',inputSchema:schema({repository:{type:'string'}})},{name:'propose_github_issue',description:'Prepare issue proposal',effect:'propose',inputSchema:schema({repository:{type:'string'},title:{type:'string'},body:{type:'string'}})},{name:'propose_discord_message',description:'Prepare Discord message',effect:'propose',inputSchema:schema({channelId:{type:'string'},text:{type:'string'}})}];
 f.provider.planWork=async()=>({status:'ready',summary:'Prepare two issues and a Discord update',steps:[{id:'issue_one',title:'Prepare architecture issue',tool:'propose_github_issue',args:{repository:'RavindranathTagor/Agents-Playground',title:'System architecture',body:'Planner placeholder'},dependsOn:[]},{id:'issue_two',title:'Prepare small game issue',tool:'propose_github_issue',args:{repository:'RavindranathTagor/Agents-Playground',title:'Small game',body:'Planner placeholder'},dependsOn:[]},{id:'discord_reply',title:'Prepare Discord update',tool:'propose_discord_message',args:{channelId:'1559991811965984890',text:'Planner placeholder'},dependsOn:[]}]});
 const calls=[];f.workTools.call=async(name,args)=>{calls.push([name,args.repository]);if(name==='read_github_issues')return {source:'GitHub issues',observedAt:new Date().toISOString(),results:[{title:'Feature issue search',summary:'No matching issues were returned.',repository:args.repository}]};if(name==='read_github_repository')return {source:'https://api.github.com/repos/RavindranathTagor/Agents-Playground',observedAt:new Date().toISOString(),results:[{title:'Repository overview',summary:'The public repository contains agent playground examples.'}]};if(name==='propose_github_issue')return {proposal:{id:`proposal-${calls.filter(([tool])=>tool==='propose_github_issue').length}`,service:'github',operation:'create_issue',status:'PENDING_APPROVAL',createdAt:new Date().toISOString(),...args}};if(name==='propose_discord_message')return {proposal:{id:'discord-proposal',service:'discord',operation:'post_channel_message',channelId:args.channelId,text:args.text,status:'PENDING_APPROVAL',createdAt:new Date().toISOString()}};throw new Error(`Unexpected tool ${name}`);};
 f.provider.draftAction=async({action,evidence})=>{assert.ok(evidence.some(item=>item.source==='GitHub issues'||item.source.includes('api.github.com')));return {content:`Evidence-backed ${action} draft.`,sourceIds:[evidence[0].id]};};
 await runWorkMission(f);assert.ok(calls.findIndex(([tool])=>tool==='read_github_issues')<calls.findIndex(([tool])=>tool==='propose_github_issue'));assert.equal(f.mission.work.proposals.length,3);assert.ok(f.mission.work.proposals.every(proposal=>proposal.status==='PENDING_APPROVAL'));assert.equal(f.mission.state,'BLOCKED');assert.ok(f.mission.work.answer);
});
test('failed external proposal drafting skips that optional step and returns the verified research result',async()=>{
 const f=fixture();f.workTools.list=()=>[...catalog,{name:'propose_discord_message',description:'Draft a Discord reply',effect:'propose',inputSchema:schema({channelId:{type:'string'},text:{type:'string'}})}];
 f.provider.planWork=async()=>({status:'ready',steps:[{id:'research',title:'Read connected source',tool:'web_search',args:{query:'team feedback'},dependsOn:[]},{id:'reply',title:'Prepare Discord reply',tool:'propose_discord_message',args:{channelId:'123456789012345678'},dependsOn:['research']}]});
 f.provider.draftAction=async()=>{throw new Error('The work-cycle time budget is exhausted. Resume to continue.');};
 f.provider.synthesizeWork=async({evidence,notes})=>({answer:`Verified source: ${evidence[0].summary} ${notes.join(' ')}`,title:'Verified research with draft limitation',sourceIds:[evidence[0].id]});
 await runWorkMission(f);assert.equal(f.mission.state,'BLOCKED');assert.ok(f.mission.work.answer.includes('Verified source:'));assert.equal(f.mission.work.proposals.length,0);assert.equal(f.mission.work.steps.find(step=>step.id==='reply').status,'failed');assert.equal(f.mission.inputRequest,undefined);assert.ok(f.mission.trace.some(item=>item.title==='Action draft unavailable'));
});
test('missing GitHub issue number searches connected repositories and resolves a confident evidence match',async()=>{
 const f=fixture();f.mission.goal='Reply to the issue about tool results disappearing';f.mission.connectedResources={github:['owner/one','owner/two']};
 f.workTools.list=()=>[...catalog,
  {name:'read_github_issues',description:'Search GitHub issues',inputSchema:schema({repository:{type:'string'},query:{type:'string'}})},
  {name:'propose_github_issue_comment',description:'Prepare an issue comment',inputSchema:schema({repository:{type:'string'},issueNumber:{type:'integer'},body:{type:'string'}})}];
 f.provider.planWork=async()=>({status:'ready',steps:[{id:'comment',title:'Prepare issue reply',tool:'propose_github_issue_comment',args:{repository:'owner/two'},dependsOn:[]}]});
 const searches=[];let proposalArgs;
 f.workTools.call=async(name,args)=>{
  if(name==='read_github_issues'){searches.push(args);const issueNumber=args.repository==='owner/two'?42:11;return {source:`https://github.com/${args.repository}/issues`,observedAt:new Date().toISOString(),results:[{title:'GitHub issue: Tool results disappear',summary:'Tool results disappear after the next step.',issueNumber,repository:args.repository,url:`https://github.com/${args.repository}/issues/${issueNumber}`}]};}
  if(name==='propose_github_issue_comment'){proposalArgs=args;return {proposal:{id:'issue-comment-proposal',service:'github',operation:'comment_on_issue',status:'PENDING_APPROVAL',createdAt:new Date().toISOString(),...args}};}
  throw new Error(`Unexpected tool ${name}`);
 };
 f.provider.resolveGithubIssue=async({evidence})=>{assert.equal(evidence.length,1);assert.equal(evidence[0].repository,'owner/two');return {evidenceId:evidence[0].id};};
 await runWorkMission(f);
 assert.deepEqual(searches.map(search=>search.repository),['owner/one','owner/two']);assert.ok(searches.every(search=>search.query===f.mission.goal));
 assert.equal(proposalArgs.issueNumber,42);assert.equal(proposalArgs.repository,'owner/two');assert.equal(f.mission.work.proposals[0].status,'PENDING_APPROVAL');
});
test('no confident GitHub issue match completes with a limitation and alternative instead of asking again',async()=>{
 const f=fixture();f.mission.goal='Reply to the missing issue about release behavior';f.mission.connectedResources={github:['owner/demo']};let proposed=0,notes;
 f.workTools.list=()=>[...catalog,
  {name:'read_github_issues',description:'Search GitHub issues',inputSchema:schema({repository:{type:'string'},query:{type:'string'}})},
  {name:'propose_github_issue_comment',description:'Prepare an issue comment',inputSchema:schema({repository:{type:'string'},issueNumber:{type:'integer'},body:{type:'string'}})}];
 f.provider.planWork=async()=>({status:'ready',steps:[{id:'comment',title:'Prepare issue reply',tool:'propose_github_issue_comment',args:{repository:'owner/demo'},dependsOn:[]}]});
 f.provider.resolveGithubIssue=async()=>({evidenceId:''});
 f.provider.synthesizeWork=async({evidence,notes:processNotes})=>{notes=processNotes;return {answer:'No exact target was verified. The closest issue is available for manual review.',title:'Issue search results',sourceIds:[evidence[0].id]};};
 f.workTools.call=async(name,args)=>{
  if(name==='read_github_issues')return {source:'https://github.com/owner/demo/issues',observedAt:new Date().toISOString(),results:[{title:'GitHub issue #9: Nearby report',summary:'A related but different report.',issueNumber:9,repository:'owner/demo',url:'https://github.com/owner/demo/issues/9'}]};
  if(name==='propose_github_issue_comment'){proposed++;throw new Error('Should not propose a comment without a confident target.');}
  throw new Error(`Unexpected tool ${name}`);
 };
 await runWorkMission(f);
 assert.equal(f.mission.state,'RESOLVED');assert.equal(proposed,0);assert.equal(f.mission.inputRequest,undefined);
 assert.match(notes[0],/No exact GitHub issue match/);assert.match(notes[0],/Best alternative/);assert.match(f.mission.work.answer,/manual review/);
});
test('a work mission asks no more than one essential clarification',async()=>{
 const f=fixture();f.provider.planWork=async()=>({status:'blocked',summary:'One required decision is missing.',requiresUserInput:true,question:'Which repository should I use?'});
 await runWorkMission(f);assert.equal(f.mission.inputRequest.question,'Which repository should I use?');assert.equal(f.mission.clarificationCount,1);
 await runWorkMission(f);assert.equal(f.mission.inputRequest,undefined);assert.equal(f.mission.clarificationCount,1);
 assert.ok(f.mission.trace.some(item=>item.title==='Investigation limitation'));
});
test('replanning after user context discards stale and duplicate evidence instead of blocking the mission',async()=>{
 const f=fixture();f.mission.revision=4;f.mission.work={steps:[],evidence:[
  {id:'old-result',stepId:'old_plan_step',title:'Old result',source:'Prior search',observedAt:new Date().toISOString(),summary:'Stale evidence from the prior plan.',stale:true},
  {id:'duplicate-result',stepId:'new_read',title:'Earlier result',source:'Search fixture',observedAt:new Date().toISOString(),summary:'Previously recorded result.',stale:false},
  {id:'duplicate-result',stepId:'new_read',title:'Earlier result duplicate',source:'Search fixture',observedAt:new Date().toISOString(),summary:'A retry wrote the same stable evidence ID.',stale:false},
 ],artifacts:[],proposals:[]};
 f.provider.planWork=async()=>({status:'ready',steps:[{id:'new_read',title:'Read current repository evidence',tool:'web_search',args:{query:'current evidence'},dependsOn:[]}]});
 f.workGraph.sync=async mission=>{
  const stepIds=new Set(mission.work.steps.map(step=>step.id));
  const live=mission.work.evidence.filter(item=>!item.stale);
  assert.equal(new Set(live.map(item=>item.id)).size,live.length,'active graph evidence IDs must be unique');
  assert.ok(live.every(item=>stepIds.has(item.stepId)),'active evidence must reference a step in the current plan');
 };
 await runWorkMission(f);
 assert.equal(f.mission.state,'RESOLVED');assert.equal(f.mission.inputRequest,undefined);
 assert.equal(f.mission.work.evidence.filter(item=>!item.stale&&item.id==='duplicate-result').length,1);
 assert.ok(f.mission.work.evidence.some(item=>!item.stale&&item.stepId==='new_read'));
});
test('a failed read is retried once, then skipped while independent verified evidence continues',async()=>{
 const f=fixture();f.mission.goal='Research graph databases using https://example.org/source and save a report.';let failedCalls=0,notes,evidenceSeen;
 const readTools=[
  {name:'web_search',description:'Search',effect:'read',inputSchema:schema({query:{type:'string'}})},
  {name:'read_web_page',description:'Read page',effect:'read',inputSchema:schema({url:{type:'string'}})},
 ];
 f.workTools.list=()=>readTools;
 f.provider.planWork=async()=>({status:'ready',steps:[
  {id:'unavailable_read',title:'Read unavailable source',tool:'web_search',args:{query:'unavailable'},dependsOn:[]},
  {id:'available_read',title:'Read available source',tool:'read_web_page',args:{url:'https://example.org/source'},dependsOn:[]},
 ]});
 f.workTools.call=async name=>{
  if(name==='web_search'){failedCalls++;throw new Error('temporary upstream error');}
  return {source:'Verified page source',observedAt:new Date().toISOString(),results:[{title:'Available evidence',summary:'The page confirms the relevant behavior.'}]};
 };
 f.provider.synthesizeWork=async args=>{notes=args.notes;evidenceSeen=args.evidence;return {answer:'The verified page confirms the relevant behavior; another source was unavailable.',title:'Evidence-backed result',sourceIds:[args.evidence[0].id]};};
 await runWorkMission(f);
 assert.equal(failedCalls,2,'read retries once, then stops');assert.equal(f.mission.state,'BLOCKED');
 assert.equal(f.mission.inputRequest,undefined);assert.equal(f.mission.work.steps.find(step=>step.id==='unavailable_read').status,'failed');
 assert.equal(f.mission.work.steps.find(step=>step.id==='available_read').status,'completed');
 assert.equal(evidenceSeen.length,1);assert.ok(notes.some(note=>note.includes('temporary upstream error')));
 assert.match(f.mission.summary,/partial result/i);assert.ok(f.mission.work.answer,'verified partial answer remains available');
});
test('dependency searches use the exact package name and declared version from repository evidence',async()=>{
 const f=fixture();f.mission.goal='Research the latest release of a real dependency in the connected repository.';
 let searchQuery='',synthesisNotes=[];
 f.provider.synthesizeWork=async({evidence,notes})=>{synthesisNotes=notes;return {answer:'The available evidence supports only this limitation.',title:'Dependency research limitation',sourceIds:[evidence[0].id]};};
 f.workTools.list=()=>[...catalog,{name:'read_github_code',description:'Read source',effect:'read',inputSchema:schema({repository:{type:'string'},path:{type:'string'}})}];
 f.provider.planWork=async()=>({status:'ready',steps:[
  {id:'manifest',title:'Read package manifest',tool:'read_github_code',args:{repository:'owner/demo',path:'package.json'},dependsOn:[]},
  {id:'search',title:'Search latest dependency release',tool:'web_search',args:{query:'latest release known issues 2026'},dependsOn:['manifest']},
 ]});
 const original=f.workTools.call;
 f.workTools.call=async(name,args,context)=>{
  if(name==='read_github_code')return {source:'GitHub code',observedAt:new Date().toISOString(),results:[{title:'owner/demo/package.json',summary:JSON.stringify({name:'slate.me',private:true,dependencies:{react:'^18.3.1'}})}]};
  if(name==='web_search'){searchQuery=args.query;return {source:'SearXNG',observedAt:new Date().toISOString(),results:[{title:'React blog',url:'https://react.dev/blog',summary:'React release information.'}]};}
  return original(name,args,context);
 };
 await runWorkMission(f);
 assert.equal(searchQuery,'react ^18.3.1 latest release official documentation release notes known issues');
 assert.ok(synthesisNotes.some(note=>note.includes('react at declared range ^18.3.1')));
 assert.ok(synthesisNotes.some(note=>note.includes('package.json.private as repository privacy')));
 assert.equal(f.mission.state,'RESOLVED');
 assert.ok(f.mission.trace.some(item=>item.title==='Search grounded in the repository manifest'));
});
test('an unverified planned page URL is replaced with a package-grounded search without losing completed evidence',async()=>{
 const f=fixture();f.mission.goal='Research latest release of a real dependency in this repository and save a report.';
 let pageCalls=0,searchCalls=0;
 f.workTools.list=()=>[...catalog,{name:'read_github_code',description:'Read source',effect:'read',inputSchema:schema({repository:{type:'string'},path:{type:'string'}})},{name:'read_web_page',description:'Read page',effect:'read',inputSchema:schema({url:{type:'string'}})}];
 f.provider.planWork=async()=>({status:'ready',steps:[
  {id:'manifest',title:'Read package manifest',tool:'read_github_code',args:{repository:'owner/demo',path:'package.json'},dependsOn:[]},
  {id:'official',title:'Read official release notes',tool:'read_web_page',args:{url:'https://github.com/releases'},dependsOn:['manifest']},
  {id:'report',title:'Save report',tool:'save_artifact',args:{title:'Dependency report',sourceIds:[]},dependsOn:['official']},
 ]});
 const original=f.workTools.call;
 f.workTools.call=async(name,args,context)=>{
  if(name==='read_github_code')return {source:'GitHub code',observedAt:new Date().toISOString(),results:[{title:'owner/demo/package.json',summary:JSON.stringify({dependencies:{react:'^18.3.1'}})}]};
  if(name==='read_web_page'){pageCalls++;throw new Error('Public website request failed (404)');}
  if(name==='web_search'){searchCalls++;assert.match(args.query,/react \^18\.3\.1/);return {source:'SearXNG',observedAt:new Date().toISOString(),results:[{title:'React blog',url:'https://react.dev/blog',summary:'Release notes for React.'}]};}
  return original(name,args,context);
 };
 await runWorkMission(f);
 assert.equal(pageCalls,0,'an unverified URL is never fetched');
 assert.equal(searchCalls,1);
 assert.equal(f.mission.state,'RESOLVED');
 assert.equal(f.mission.work.steps.find(step=>step.id==='manifest').status,'completed');
 assert.ok(f.mission.work.evidence.some(item=>item.stepId==='manifest'&&!item.stale));
 assert.ok(f.mission.work.artifacts.length,'the report is completed from the available evidence');
 assert.ok(f.mission.trace.some(item=>item.title==='Unverified page URL replaced with a source search'));
});
test('an oversized snapshot falls back to the complete repository tree and continues',async()=>{
 const f=fixture();f.mission.goal='Review the repository';let snapshotCalls=0,treeCalls=0;
 f.workTools.list=()=>[...catalog,{name:'read_github_repository_snapshot',effect:'read',inputSchema:schema({repository:{type:'string'}})},{name:'read_github_repository_tree',effect:'read',inputSchema:schema({repository:{type:'string'}})}];
 f.provider.planWork=async()=>({status:'ready',steps:[{id:'repository',title:'Read repository evidence',tool:'read_github_repository_snapshot',args:{repository:'owner/demo'},dependsOn:[]}]});
 f.workTools.call=async name=>{if(name==='read_github_repository_snapshot'){snapshotCalls++;throw new Error('Repository snapshot has 3130131 textual bytes, above the configured 1000000-byte safety limit.');}if(name==='read_github_repository_tree'){treeCalls++;return {source:'GitHub repository tree',observedAt:new Date().toISOString(),results:[{title:'Repository tree',summary:'src/index.ts\nREADME.md'}]};}throw new Error(`Unexpected tool ${name}`);};
 await runWorkMission(f);assert.equal(snapshotCalls,2);assert.equal(treeCalls,1);assert.equal(f.mission.state,'RESOLVED');assert.equal(f.mission.work.steps[0].tool,'read_github_repository_tree');assert.ok(f.mission.work.evidence.some(item=>item.summary.includes('src/index.ts')));
});
test('active evidence with an unknown step fails explicitly instead of becoming stale silently',async()=>{
 const f=fixture();f.mission.work={steps:[{id:'valid',title:'Read source',tool:'web_search',args:{query:'source'},dependsOn:[],status:'pending'}],evidence:[{id:'invalid',stepId:'missing',title:'Unlinked evidence',source:'Fixture',observedAt:new Date().toISOString(),summary:'Unverified attachment',stale:false}],artifacts:[],proposals:[]};
 await assert.rejects(runWorkMission(f),/Active evidence invalid references unknown work step missing/);
});
test('a saved answer based only on chat is regenerated when primary GitHub evidence is available',async()=>{
 const f=fixture();const observedAt=new Date().toISOString();f.mission.work={steps:[{id:'repo_read',title:'Read repository',tool:'read_github_repository',args:{repository:'owner/demo'},dependsOn:[],status:'completed'}],evidence:[{id:'discord-report',stepId:'repo_read',title:'Team report',source:'Discord channel 1',observedAt,summary:'A teammate says issue #99 exists.',stale:false},{id:'github-read',stepId:'repo_read',title:'Repository read',source:'https://api.github.com/repos/owner/demo',observedAt,summary:'Repository metadata confirmed by GitHub.',stale:false}],synthesis:{answer:'Issue #99 is confirmed.',title:'Old answer',sourceIds:['discord-report']},answer:'Issue #99 is confirmed.',sourceIds:['discord-report'],artifacts:[],proposals:[]};
 let used;f.provider.synthesizeWork=async({evidence})=>{used=evidence.map(item=>item.id);return {answer:'GitHub confirmed the repository metadata. Discord contains an unverified report about issue #99.',title:'Primary-source result',sourceIds:['github-read']};};
 await runWorkMission(f);assert.ok(used.includes('github-read'));assert.equal(f.mission.work.answer,'GitHub confirmed the repository metadata. Discord contains an unverified report about issue #99.');assert.deepEqual(f.mission.work.sourceIds,['github-read']);assert.ok(f.mission.work.supersededSyntheses[0].answer.includes('Issue #99'));assert.ok(f.mission.trace.some(item=>item.title==='Rechecking chat-reported claims'));
});
test('repository claims cited only to Discord are regenerated from primary GitHub evidence',async()=>{
 const f=fixture();const observedAt=new Date().toISOString();f.mission.work={steps:[{id:'read',title:'Read current evidence',tool:'read_github_repository',args:{repository:'owner/demo'},dependsOn:[],status:'completed'}],evidence:[{id:'chat',stepId:'read',title:'Discord report',source:'Discord channel 1',observedAt,summary:'Someone says GitHub issue #99 is open.',stale:false},{id:'github',stepId:'read',title:'GitHub search',source:'https://github.com/owner/demo/issues',observedAt,summary:'No matching issue was returned by the actual GitHub search.',stale:false}],artifacts:[],proposals:[]};
 let calls=0,secondEvidence;f.provider.synthesizeWork=async({evidence})=>{calls++;if(calls===1)return {answer:'GitHub issue #99 is open.',title:'Unsupported draft',sourceIds:['chat']};secondEvidence=evidence;return {answer:'The configured GitHub search returned no matching issue. A Discord message reports #99, but that claim is not verified.',title:'Evidence-limited result',sourceIds:['github']};};
 await runWorkMission(f);assert.equal(calls,2);assert.deepEqual(secondEvidence.map(item=>item.id),['github']);assert.equal(f.mission.work.answer,'The configured GitHub search returned no matching issue. A Discord message reports #99, but that claim is not verified.');assert.deepEqual(f.mission.work.sourceIds,['github']);
});
test('a blocked rejected-feature plan falls back to real GitHub and repository evidence',async()=>{
 const f=fixture();f.mission.goal='Investigate this rejected feature request';f.mission.connectedResources={github:['owner/demo']};let notes,readTools=[];
 const properties={repository:{type:'string'},query:{type:'string'}};
 f.workTools.list=()=>[...catalog,
  {name:'read_github_issues',description:'Search issues',inputSchema:schema(properties)},
  {name:'read_github_repository',description:'Read repository',inputSchema:schema({repository:{type:'string'}})},
  {name:'read_github_commits',description:'Read commits',inputSchema:schema({repository:{type:'string'}})}];
 f.provider.planWork=async()=>({status:'blocked',summary:'Need to know which rejected feature request.'});
 f.provider.synthesizeWork=async({evidence,notes:processNotes})=>{notes=processNotes;return {answer:'No matching issue was found; repository and commit evidence are available as the best supported alternative.',title:'Repository evidence',sourceIds:[evidence.at(-1).id]};};
 f.workTools.call=async(name,args)=>{
  readTools.push(name);
  if(name==='read_github_issues')return {source:'GitHub issues search',observedAt:new Date().toISOString(),results:[{id:'empty-issues',title:'GitHub issue search returned no matches',summary:'No issues matched the repository-scoped search terms.'}]};
  if(name==='read_github_repository')return {source:'GitHub repository',observedAt:new Date().toISOString(),results:[{title:'Repository description',summary:'A repository for connected agent workflows.'}]};
  if(name==='read_github_commits')return {source:'GitHub commits',observedAt:new Date().toISOString(),results:[{title:'Recent commit',summary:'Improved connected issue triage.'}]};
  throw new Error(`Unexpected tool ${name}`);
 };
 await runWorkMission(f);
 assert.equal(f.mission.state,'RESOLVED');assert.deepEqual(readTools,['read_github_issues','read_github_repository','read_github_commits']);
 assert.match(notes[0],/No matching issues were returned/);assert.match(f.mission.work.answer,/best supported alternative/);
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
test('issue-derived proposal is blocked when GitHub issue searches returned no issue records',async()=>{
 const f=fixture();f.mission.goal='Compare both GitHub issues, recommend which to prioritize, and draft an issue for the highest-priority improvement.';
 let writes=0,draftCalls=0;
 const issueTool={name:'propose_github_issue',description:'Prepare GitHub issue',effect:'propose',inputSchema:schema({repository:{type:'string'},title:{type:'string'},body:{type:'string'}})};
 f.workTools.list=()=>[...catalog,issueTool];
 f.provider.planWork=async()=>({status:'ready',summary:'Search issues and propose an improvement',steps:[
  {id:'search',title:'Search for the referenced issues',tool:'web_search',args:{query:'the complete user request'},dependsOn:[]},
  {id:'proposal',title:'Draft the highest-priority improvement',tool:issueTool.name,args:{repository:'owner/demo',title:'',body:''},dependsOn:['search']},
 ]});
 const original=f.workTools.call;
 f.workTools.call=async(name,args,context)=>{
  if(name===issueTool.name){writes++;return {proposal:{id:'unexpected',status:'PENDING_APPROVAL'}};}
  if(name==='web_search')return {source:'GitHub issues',observedAt:new Date().toISOString(),results:[{title:'GitHub issue search returned no matches',url:'https://github.com/owner/demo/issues',summary:'No issue records matched the search.'}]};
  return original(name,args,context);
 };
 f.provider.draftAction=async()=>{draftCalls++;return {status:'ready',content:'An unsupported issue draft.',sourceIds:[f.mission.work.evidence[0].id]};};
 f.provider.synthesizeWork=async({evidence})=>({answer:'No issue records were returned, so the requested comparison and derived issue cannot be completed.',title:'Issue search limitation',sourceIds:[evidence[0].id]});
 await runWorkMission(f);
 assert.equal(f.mission.state,'BLOCKED');assert.equal(draftCalls,0);assert.equal(writes,0);
 assert.equal(f.mission.work.steps.find(step=>step.id==='proposal').status,'blocked');
 assert.equal(f.mission.work.steps.find(step=>step.id==='proposal').retryable,false);
 assert.equal(f.mission.clarificationCount,1);
 assert.equal(f.mission.inputRequest.question,'Which open GitHub issues should MOVA compare?');
 assert.deepEqual(f.mission.inputRequest.options,['Provide the two issue URLs or numbers.','Correct the repository owner/name and provide the issue URLs or numbers.']);
 assert.match(f.mission.work.answer,/No issue records were returned/);
 assert.ok(f.mission.trace.some(item=>item.title==='Issue proposal withheld'));
 await runWorkMission(f);
 assert.equal(draftCalls,0,'resuming does not retry a proposal with unchanged evidence');
 assert.equal(writes,0);
});
test('provider-blocked proposals do not repeat on resume',async()=>{
 const f=fixture();let draftCalls=0,proposalWrites=0;
 const tool={name:'propose_discord_message',description:'Prepare Discord message',effect:'propose',inputSchema:schema({channelId:{type:'string'},text:{type:'string'}})};
 f.workTools.list=()=>[...catalog,tool];
 f.provider.planWork=async()=>({status:'ready',steps:[
  {id:'read',title:'Read evidence',tool:'web_search',args:{query:'supporting source'},dependsOn:[]},
  {id:'reply',title:'Prepare Discord reply',tool:tool.name,args:{channelId:'channel-1',text:''},dependsOn:['read']},
 ]});
 f.provider.draftAction=async({evidence})=>{draftCalls++;return {status:'blocked',content:'The sources do not support a useful reply.',sourceIds:[evidence[0].id]};};
 const original=f.workTools.call;f.workTools.call=async(name,args,context)=>{if(name===tool.name)proposalWrites++;return original(name,args,context);};
 await runWorkMission(f);
 assert.equal(f.mission.state,'BLOCKED');assert.equal(draftCalls,1);assert.equal(proposalWrites,0);
 assert.equal(f.mission.work.steps.find(step=>step.id==='reply').retryable,false);
 await runWorkMission(f);
 assert.equal(draftCalls,1);assert.equal(proposalWrites,0);
});
test('GitHub comment plans defer missing or empty body until evidence-backed drafting',async()=>{
 for(const plannedBody of [undefined,'']){
  const f=fixture();let proposalArgs;
  const tool={name:'propose_github_issue_comment',description:'Prepare GitHub issue reply',effect:'propose',inputSchema:{...schema({repository:{type:'string',minLength:1},issueNumber:{type:'integer',minimum:1},body:{type:'string',minLength:1,maxLength:5000}}),required:['repository','issueNumber','body']}};
  f.workTools.list=()=>[...catalog,tool];
  f.provider.planWork=async()=>({status:'ready',summary:'Read evidence and prepare reply',steps:[
   {id:'read',title:'Read supporting evidence',tool:'web_search',args:{query:'verified issue context'},dependsOn:[]},
   {id:'draft_comment',title:'Prepare issue comment',tool:tool.name,args:{repository:'owner/repo',issueNumber:42,...(plannedBody===undefined?{}:{body:plannedBody})},dependsOn:['read']},
  ]});
  f.provider.draftAction=async({evidence})=>({content:'A source-backed reply.',sourceIds:[evidence[0].id]});
  const original=f.workTools.call;
  f.workTools.call=async(name,args,context)=>name===tool.name?(proposalArgs=args,{proposal:{id:'comment-proposal',service:'github',operation:'comment_on_issue',status:'PENDING_APPROVAL',createdAt:new Date().toISOString(),...args}}):original(name,args,context);
  await runWorkMission(f);
  assert.equal(proposalArgs.body,'A source-backed reply.');
  assert.equal(f.mission.work.proposals[0].body,proposalArgs.body);
  assert.equal(f.mission.state,'BLOCKED','the proposal remains approval-gated');
 }
});
test('invalid generated GitHub comment content is rejected before proposal execution',async()=>{
 const f=fixture();let proposalCalls=0,draftCalls=0;
 const tool={name:'propose_github_issue_comment',description:'Prepare GitHub issue reply',effect:'propose',inputSchema:{...schema({repository:{type:'string',minLength:1},issueNumber:{type:'integer',minimum:1},body:{type:'string',minLength:1,maxLength:5000}}),required:['repository','issueNumber','body']}};
 f.workTools.list=()=>[...catalog,tool];
 f.provider.planWork=async()=>({status:'ready',steps:[
  {id:'read',title:'Read supporting evidence',tool:'web_search',args:{query:'verified issue context'},dependsOn:[]},
  {id:'draft_comment',title:'Prepare issue comment',tool:tool.name,args:{repository:'owner/repo',issueNumber:42,body:''},dependsOn:['read']},
 ]});
 f.provider.draftAction=async({evidence})=>{draftCalls++;return {content:'  \n ',sourceIds:[evidence[0].id]};};
 const original=f.workTools.call;
 f.workTools.call=async(name,args,context)=>name===tool.name?(proposalCalls++,{proposal:{id:'invalid-comment',service:'github',operation:'comment_on_issue',status:'PENDING_APPROVAL',createdAt:new Date().toISOString(),...args}}):original(name,args,context);
 await runWorkMission(f);
 assert.equal(draftCalls,1,'invalid generated content is not retried automatically');
 assert.equal(proposalCalls,0);
 assert.equal(f.mission.work.steps.find(step=>step.id==='draft_comment').status,'failed');
 assert.match(f.mission.work.lookupNotes[0],/empty or whitespace-only evidence-backed action content/);
 assert.equal(f.mission.work.proposals.length,0);
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
test('work plan rejects arguments that do not match the selected tool schema before execution',()=>{
 const tools=[{name:'read_github_issues',inputSchema:schema({repository:{type:'string'},state:{type:'string',enum:['open','closed','all']},limit:{type:'integer'}})}];
 const make=args=>({status:'ready',steps:[{id:'search',title:'Search issues',tool:'read_github_issues',args,dependsOn:[]}]});
 tools[0].inputSchema.required=['repository'];
 assert.throws(()=>validateWorkPlan(make({state:'open'}),tools),/Missing required argument repository/);
 assert.throws(()=>validateWorkPlan(make({repository:42}),tools),/Invalid argument type for repository/);
 assert.throws(()=>validateWorkPlan(make({repository:'owner/repo',state:'merged'}),tools),/Invalid argument value for state/);
 assert.throws(()=>validateWorkPlan(make({repository:'owner/repo',unexpected:true}),tools),/Unexpected argument/);
 assert.equal(validateWorkPlan(make({repository:'owner/repo',state:'open',limit:5}),tools)[0].status,'pending');
});
test('work plan validates declared string, numeric, array-item, and nested-object constraints',()=>{
 const tools=[{name:'propose_github_commit',inputSchema:schema({
  repository:{type:'string',minLength:1,maxLength:200},
  files:{type:'array',minItems:1,maxItems:2,items:{type:'object',properties:{path:{type:'string',minLength:1,maxLength:500},content:{type:'string',maxLength:20}},required:['path','content'],additionalProperties:false}},
  limit:{type:'integer',minimum:1,maximum:10},
 })}];
 const make=args=>({status:'ready',steps:[{id:'commit',title:'Prepare commit',tool:'propose_github_commit',args,dependsOn:[]}]});
 const valid={repository:'owner/repo',files:[{path:'src/app.js',content:'ok'}],limit:2};
 assert.equal(validateWorkPlan(make(valid),tools)[0].status,'pending');
 assert.throws(()=>validateWorkPlan(make({...valid,repository:''}),tools),/at least 1 characters/);
 assert.throws(()=>validateWorkPlan(make({...valid,limit:11}),tools),/at most 10/);
 assert.throws(()=>validateWorkPlan(make({...valid,files:[]}),tools),/at least 1 items/);
 assert.throws(()=>validateWorkPlan(make({...valid,files:[{path:4,content:'ok'}]}),tools),/Invalid argument type.*files\[0\]\.path/);
 assert.throws(()=>validateWorkPlan(make({...valid,files:[{path:'a',content:'ok',unexpected:true}]}),tools),/property is not allowed/);
 assert.throws(()=>validateWorkPlan(make({...valid,files:[{path:'a'}]}),tools),/required property is missing/);
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
