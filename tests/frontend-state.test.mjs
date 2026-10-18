import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeEnvelope } from '../src/envelope.mjs';
import { newDiscordMissionId } from '../src/envelope.mjs';
import { visibleExecutionTraces } from '../src/execution.mjs';
import { dispatchDecisionForStep } from '../src/falkor-comparison.mjs';
import { claimOnce, investigationStatus, restoreMissionId } from '../src/ui-state.mjs';
import { alternativeSourceInstruction, attentionEventKey, contextPayload, isInvalidWorkArgumentsError, missingIssueInputRequest, readAttentionDrafts, resumeRequest, workFailureDetail } from '../src/attention.mjs';

const envelope=(mission,missions=[{id:mission?.id,title:mission?.title,state:mission?.state}])=>({mission,missions,integrations:[],config:{}});
const mission=(overrides={})=>({id:'mission-1',title:'Review repository',goal:'Review repository',state:'EXECUTING',revision:1,summary:'Reading source',trace:[],work:{steps:[],proposals:[]},...overrides});

test('new SSE snapshots update the visible mission incrementally',()=>{
  const first=mission({trace:[{id:'1',at:'2026-01-01T00:00:01Z',title:'Read tree'}]});
  const next=mission({summary:'Read source file',trace:[...first.trace,{id:'2',at:'2026-01-01T00:00:02Z',title:'Read source'}]});
  assert.equal(mergeEnvelope(envelope(first),envelope(next),'mission-1').mission.summary,'Read source file');
});

test('a newly confirmed Discord mission auto-selects once and keeps duplicate state snapshots idempotent',()=>{
  const previous=envelope(mission({id:'existing'}),[{id:'existing',state:'RESOLVED'}]);
  const nextMission=mission({id:'discord-mission',trigger:{service:'Discord',eventId:'discord:channel:message-1'}});
  const next=envelope(nextMission,[...previous.missions,{id:nextMission.id,state:'MISSION_CREATED'}]);
  assert.equal(newDiscordMissionId(previous,next),nextMission.id);
  assert.equal(newDiscordMissionId(next,next),undefined);
  assert.equal(newDiscordMissionId(previous,envelope(mission({id:'github-mission',trigger:{service:'GitHub',eventId:'issue:1'}}))),undefined);
});

test('refresh keeps a preferred active investigation and otherwise restores the newest active mission',()=>{
  const state=envelope(mission({id:'current'}),[{id:'older-active',state:'EXECUTING'},{id:'newer-active',state:'INVESTIGATING'},{id:'saved-active',state:'EXECUTING'}]);
  assert.equal(restoreMissionId(state,'older-active'),'older-active');
  assert.equal(restoreMissionId(state,'resolved'),'saved-active');
});

test('Live execution omits the duplicate mission-created state echo',()=>{
  const traces=[
    {id:'event',kind:'event',title:'Mission created'},
    {id:'state',kind:'state',title:'MISSION CREATED'},
    {id:'next',kind:'agent',title:'Mission understood'},
  ];
  assert.deepEqual(visibleExecutionTraces(traces).map(item=>item.id),['event','next']);
  assert.equal(visibleExecutionTraces(traces.slice(1)).length,2,'do not hide the state when the creation event is absent');
});

test('Graph impact shows recorded FalkorDB release or labels local resume revalidation',()=>{
  const traces=[
    {tool:'work_graph_ready',source:'FalkorDB',detail:'FalkorDB released this step after checking 1 dependency and its evidence.',query:'MATCH (s:Step) RETURN s.stepId',result:{readyStepIds:['read-issue','analyze'],releasedStepId:'read-issue',dependencyStepIds:[]}},
    {tool:'work_graph_ready',source:'Local dependency revalidation',detail:'FalkorDB did not release the saved step; local revalidation found current verified evidence.',query:'MATCH (s:Step) RETURN s.stepId',result:{readyStepIds:[],releasedStepId:'save-artifact',dependencyStepIds:['analyze']}},
  ];
  assert.deepEqual(dispatchDecisionForStep(traces,'read-issue'),{
    source:'FalkorDB',
    detail:'FalkorDB released this step after checking 1 dependency and its evidence.',
    query:'MATCH (s:Step) RETURN s.stepId',
    readyStepIds:['read-issue','analyze'],
    dependencyStepIds:[],
  });
  assert.equal(dispatchDecisionForStep(traces,'save-artifact').source,'Local dependency revalidation');
  assert.equal(dispatchDecisionForStep(traces,'unrecorded'),undefined);
});

test('Live execution keeps the full event timeline in page flow and shows the graph below it',()=>{
  const css=readFileSync(new URL('../src/components/execution-console.css',import.meta.url),'utf8');
  assert.match(css,/\.execution-console-grid\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(css,/\.execution-thread\{width:100%;min-width:0;max-height:none;overflow:visible/);
  assert.match(css,/\.live-graph-nodes\{display:grid;grid-template-columns:repeat\(auto-fit/);
  assert.match(css,/\.console-message p,[^{]*\{[^}]*overflow-wrap:anywhere/);
  assert.match(css,/\.jump-latest\{display:none\}/);
  assert.match(css,/@media\(max-width:620px\)[\s\S]*?\.user-message\{width:100%\}/);
});

test('late snapshots from another mission cannot replace the selection',()=>{
  const selected=mission({id:'mission-2',title:'Selected'});
  const late=mission({id:'mission-1',title:'Late response'});
  assert.equal(mergeEnvelope(envelope(selected),envelope(late),'mission-2').mission.id,'mission-2');
});

test('older snapshots cannot roll back a newer revision or trace',()=>{
  const current=mission({revision:3,trace:[{id:'new',at:'2026-02-01T00:00:02Z',title:'Current'}]});
  const late=mission({revision:2,trace:[{id:'old-1',at:'2026-02-01T00:00:01Z',title:'Earlier'},{id:'old-2',at:'2026-02-01T00:00:01Z',title:'Earlier detail'}]});
  assert.equal(mergeEnvelope(envelope(current),envelope(late),'mission-1').mission.revision,3);
  const sameRevisionLate=mission({trace:[{id:'late-a',at:'2026-02-01T00:00:01Z',title:'Late'},{id:'late-b',at:'2026-02-01T00:00:01Z',title:'Late detail'}]});
  assert.equal(mergeEnvelope(envelope(current),envelope(sameRevisionLate),'mission-1').mission.trace[0].id,'new');
});

test('thinking status reflects real execution, approval, and completion states',()=>{
  assert.deepEqual(investigationStatus(mission({work:{steps:[{status:'running',title:'Read repository tree'}]}})),{label:'Waiting for Read repository tree',active:true});
  assert.deepEqual(investigationStatus(mission({state:'VERIFYING',work:{proposals:[{status:'PENDING_APPROVAL'}]}})),{label:'Waiting for your approval',active:false});
  assert.deepEqual(investigationStatus(mission({state:'RESOLVED'})),{label:'Investigation complete',active:false});
});

test('refresh restores the selected investigation unless the user explicitly chose a new request',()=>{
  const state=envelope(mission({id:'current'}),[{id:'current',state:'RESOLVED'},{id:'active',state:'INVESTIGATING'},{id:'saved',state:'RESOLVED'}]);
  assert.equal(restoreMissionId(state,'saved'), 'active');
  assert.equal(restoreMissionId(state,'missing'), 'active');
  assert.equal(restoreMissionId(state), 'active');
  assert.equal(restoreMissionId(state,'saved',true), undefined);
});

test('clarification and approval popups claim each stable key once',()=>{
  const values=new Map();
  const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  const shown=new Set();
  assert.equal(claimOnce('clarification:mission-1:rev-2',shown,storage),true);
  assert.equal(claimOnce('clarification:mission-1:rev-2',shown,storage),false);
  assert.equal(claimOnce('proposal:proposal-7',shown,storage),true);
});

test('the same blocked step remains one attention event across mission revisions',()=>{
  const first=mission({state:'BLOCKED',revision:4,summary:'Invalid arguments.content',work:{steps:[{id:'s7_save_investigation',status:'failed'}]}});
  const next={...first,revision:5,summary:'Invalid arguments.content for work step s7_save_investigation'};
  assert.equal(attentionEventKey(first),attentionEventKey(next));
  const question={...first,inputRequest:{question:'Which repository?'}};
  assert.equal(attentionEventKey(question,'clarification'),attentionEventKey({...question,revision:6},'clarification'));
  assert.notEqual(attentionEventKey(question,'clarification'),attentionEventKey({...question,inputRequest:{question:'Which branch?'}},'clarification'));
});

test('dismissed attention stays dismissed after a page reload',()=>{
  const values=new Map();
  const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  const event=`mova:blocked:${attentionEventKey(mission({state:'BLOCKED',summary:'Needs attention'}))}`;
  assert.equal(claimOnce(event,new Set(),storage),true);
  assert.equal(claimOnce(event,new Set(),storage),false);
});

test('context submissions reject blank content and trim valid text for the existing text API',()=>{
  assert.equal(contextPayload('  \n '),null);
  assert.deepEqual(contextPayload('  use the connected repository  '),{text:'use the connected repository'});
});

test('resume targets the existing mission ID and does not construct a new mission request',()=>{
  assert.deepEqual(resumeRequest('mission-7'),{path:'/api/missions/mission-7/resume',body:{}});
  assert.equal(resumeRequest(''),null);
});

test('blocked recovery surfaces the failed tool detail instead of only the generic mission summary',()=>{
  const blocked=mission({state:'BLOCKED',summary:'A verified partial result is available.',work:{
    steps:[{id:'official-docs',title:'Read official documentation',tool:'read_web_page',args:{url:'https://example.org/source'},status:'failed',summary:'Skipped because the tool did not return verified evidence.'}],
    lookupNotes:['Skipped Read official documentation: the connected tool failed (Public website request failed (404)). No evidence or successful outcome was recorded.'],
  }});
  assert.match(workFailureDetail(blocked),/Public website request failed \(404\)/);
  const instruction=alternativeSourceInstruction(blocked);
  assert.match(instruction,/Do not repeat failed step "Read official documentation"/);
  assert.match(instruction,/https:\/\/example\.org\/source/);
  assert.match(instruction,/clearly state the evidence gap/);
});

test('blocked issue comparisons ask for issue URLs or corrected repository details',()=>{
  const blocked=mission({kind:'work',state:'BLOCKED',clarificationCount:0,work:{steps:[
    {id:'compare-issues',title:'Compare open issues',tool:'propose_github_issue',status:'blocked',summary:'No matching GitHub issue evidence was retrieved, so MOVA cannot compare issues, recommend a priority, or draft a derived issue.'},
    {id:'discord-reply',title:'Prepare Discord reply',tool:'propose_discord_message',status:'blocked',summary:'Skipped because a required step did not produce verified evidence.'},
  ]}});
  const prompt=missingIssueInputRequest(blocked);
  assert.equal(prompt.question,'Which open GitHub issues should MOVA compare?');
  assert.deepEqual(prompt.options,['Provide the two issue URLs or numbers.','Correct the repository owner/name and provide the issue URLs or numbers.']);
  assert.match(prompt.reason,/No matching GitHub issue evidence/);
  assert.equal(missingIssueInputRequest({...blocked,clarificationCount:1}),null);
  assert.equal(missingIssueInputRequest({...blocked,kind:'travel'}),null);
});

test('clarification drafts restore safely after refresh and remain bounded',()=>{
  assert.deepEqual(readAttentionDrafts({'clarification:one':'keep this','clarification:bad':4,'clarification:large':'x'.repeat(2200)}),{
    'clarification:one':'keep this','clarification:large':'x'.repeat(2000)
  });
});

test('generated empty work-step arguments are recognized as unsafe to retry unchanged',()=>{
  assert.equal(isInvalidWorkArgumentsError('Invalid arguments.content for work step s7_save_analysis: must contain at least 1 characters.'),true);
  assert.equal(isInvalidWorkArgumentsError('The synthesized answer content is missing.'),true);
  assert.equal(isInvalidWorkArgumentsError('The synthesized answer content is empty or contains only whitespace.'),true);
  assert.equal(isInvalidWorkArgumentsError('The repository is temporarily unavailable.'),false);
});
