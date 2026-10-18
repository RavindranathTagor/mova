import { ArrowUpRight, Database, GitBranch, MessageSquareText, ShieldCheck, Wrench } from 'lucide-react';
import type { GraphEdge, Mission, Trace } from '../types';
import { visibleExecutionTraces } from '../execution.mjs';
import './execution-console.css';

const eventExpressions = {
  welcome: { index: 0, label: 'Welcome' },
  curious: { index: 1, label: 'Curious' },
  thinking: { index: 2, label: 'Thinking' },
  unsure: { index: 3, label: 'Unsure' },
  working: { index: 4, label: 'Working' },
  playful: { index: 13, label: 'Playful' },
  celebrating: { index: 8, label: 'Celebrating' },
  listening: { index: 14, label: 'Listening' },
} as const;

function expressionForEvent(trace: Trace) {
  const event = `${trace.title} ${trace.detail} ${trace.kind} ${trace.tool || ''} ${trace.status || ''}`.toLowerCase();
  if (/error|blocked|failed/.test(event)) return eventExpressions.unsure;
  if (/(investigation (complete|completed)|completed investigation|mission (resolved|complete|completed)|celebrat)/.test(event)) return eventExpressions.celebrating;
  if (/waiting|awaiting|additional information|more information|user input|needs input/.test(event)) return eventExpressions.listening;
  if (/mission created|initial welcome|welcome/.test(event)) return eventExpressions.welcome;
  if (/mission understood|understood/.test(event)) return eventExpressions.curious;
  if (/completed|successful|success|tool result|action completed/.test(event)) return eventExpressions.playful;
  if (/investigat|thinking|graph query|decision/.test(event)) return eventExpressions.thinking;
  if (/read|reading|source|tool|action|execut/.test(event)) return eventExpressions.working;
  return eventExpressions.thinking;
}

function ExecutionEventAvatar({ trace }: { trace: Trace }) {
  const expression = expressionForEvent(trace);
  return <span
    className="execution-event-avatar"
    role="img"
    aria-label={`MOVA ${expression.label} expression`}
    style={{ backgroundPosition: `${(expression.index % 4) * 100 / 3}% ${Math.floor(expression.index / 4) * 100 / 3}%` }}
  />;
}

const time=(value:string)=>new Date(value).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
const nodeLabel=(mission:Mission,id:string)=>mission.graph.nodes.find(node=>node.id===id)?.label||id;
const kind=(trace:Trace)=>trace.query?'Graph query':trace.kind==='tool'?'Tool result':trace.kind==='decision'?'Decision':trace.kind==='action'?'Approved action':'Agent update';
const Icon=({trace}:{trace:Trace})=>trace.query?<Database size={16}/>:trace.kind==='tool'?<Wrench size={16}/>:trace.kind==='decision'?<GitBranch size={16}/>:<MessageSquareText size={16}/>;
const compact=(query:string)=>query.replace(/\s+/g,' ').trim().slice(0,180);

function Path({mission,edges}:{mission:Mission;edges:GraphEdge[]}){
  if(!edges.length)return <p className="execution-empty">The first investigation will create the evidence path.</p>;
  return <ol className="execution-path">{edges.slice(0,8).map(edge=><li key={edge.id}><strong>{nodeLabel(mission,edge.source)}</strong><span>{edge.label.replaceAll('_',' ').toLowerCase()}</span><strong>{nodeLabel(mission,edge.target)}</strong></li>)}</ol>;
}

function AgentRoles({mission}:{mission:Mission}){
  const steps=mission.work?.steps||[];
  const traces=visibleExecutionTraces(mission.trace);
  const graphQueries=traces.filter(trace=>trace.query).length;
  const roles=[
    {name:'Orchestrator',detail:steps.length?`${steps.length} graph-planned tool step${steps.length===1?'':'s'}`:'Interpreting the request',active:traces.some(trace=>trace.title==='Work plan created')},
    {name:'Evidence scout',detail:`${mission.work?.evidence.length||0} current source record${(mission.work?.evidence.length||0)===1?'':'s'}`,active:steps.some(step=>step.tool.startsWith('read_')||step.tool==='web_search')},
    {name:'FalkorDB graph guard',detail:`${graphQueries} dependency traversal${graphQueries===1?'':'s'}`,active:graphQueries>0},
    {name:'Response editor',detail:mission.work?.proposals?.length?`${mission.work.proposals.length} reviewable action proposal${mission.work.proposals.length===1?'':'s'}`:'Activates only when an external reply is needed',active:Boolean(mission.work?.proposals?.length)},
  ].filter(role=>role.active||steps.length>0);
  return <section className="agent-roles" aria-label="Agent roles in this mission"><header><div><h2>Mission roles</h2><p>Operational summaries from the live record</p></div></header>{roles.map(role=><article key={role.name}><span className={role.active?'role-dot active':'role-dot'}/><div><strong>{role.name}</strong><p>{role.detail}</p></div></article>)}<small>Private model reasoning is not displayed. MOVA records evidence, tool calls, dependency checks, and approved actions.</small></section>;
}

function LiveGraph({mission}:{mission:Mission}){
  const nodes=mission.graph.nodes;
  const edges=mission.graph.edges;
  return <section className="live-graph" id="live-falkordb-graph" tabIndex={-1} aria-label="Live FalkorDB mission graph"><header><div><Database size={17}/><div><h2>Live FalkorDB graph</h2><p>All nodes and relationships materialized from this mission.</p></div></div><span>{nodes.length} nodes · {edges.length} edges</span></header>{nodes.length?<><ul className="live-graph-nodes">{nodes.map(node=><li className={`live-graph-node type-${node.type.toLowerCase()}`} key={node.id}><small>{node.type}</small><strong>{node.label}</strong></li>)}</ul>{edges.length?<ol className="live-graph-edges">{edges.map(edge=><li key={edge.id}><strong>{nodeLabel(mission,edge.source)}</strong><span>{edge.label.replaceAll('_',' ').toLowerCase()}</span><strong>{nodeLabel(mission,edge.target)}</strong></li>)}</ol>:<p className="execution-empty">No relationships have been recorded yet.</p>}</>:<p className="execution-empty">FalkorDB will materialize this mission graph as MOVA gathers evidence.</p>}</section>;
}

const activeMissionStates=['DETECTED','MISSION_CREATED','BUILDING_CONTEXT','INVESTIGATING','PLANNING','REPLANNING','EXECUTING','VERIFYING'];
function eventStatus(trace:Trace,index:number,count:number,mission:Mission){
  const status=(trace.status||'').toLowerCase();
  if(/failed|blocked|error/.test(status)||/blocked|failed|unavailable/i.test(trace.title))return 'blocked';
  if(/verified|completed|success/.test(status))return 'complete';
  if(/pending/.test(status))return 'pending';
  if(index===count-1&&['BLOCKED','FAILED_RETRYABLE','UNKNOWN'].includes(mission.state))return 'blocked';
  const runningStep=mission.work?.steps.find(step=>['running','executing'].includes(step.status.toLowerCase()));
  if(index===count-1&&activeMissionStates.includes(mission.state)&&(!runningStep||runningStep.tool===trace.tool))return 'active';
  if(index===count-1&&mission.state==='RESOLVED'&&/resolved|complete|verified/i.test(trace.title))return 'complete';
  return 'recorded';
}

export default function ExecutionConsole({mission}:{mission:Mission}){
  const traces=visibleExecutionTraces(mission.trace);
  const latest=traces.at(-1);
  const graphTraces=traces.filter(trace=>trace.query);
  const toolCalls=mission.work?.steps||[];
  return <section className="execution-console" aria-labelledby="execution-console-title">
    <header className="execution-console-header"><div><p className="console-kicker">LIVE EXECUTION</p><h1 id="execution-console-title">MOVA’s investigation</h1><p>Backend events, evidence and tool calls as they happen.</p></div><div className="console-header-actions"><div className="console-metrics"><span>{mission.graph.nodes.length} nodes</span><span>{mission.graph.edges.length} relationships</span><span>{graphTraces.length} Cypher queries</span></div><a className="open-live-graph" href="#live-falkordb-graph">Open Live FalkorDB Graph<ArrowUpRight size={15}/></a></div></header>
    <div className="execution-console-grid">
      <section className="execution-thread" aria-label="Agent conversation" aria-live="polite">
        <article className="console-message user-message"><span>You asked</span><p>{mission.goal}</p></article>
        <h2 className="flow-section-title">Execution timeline</h2>
        {traces.length?<ol className="execution-flow" aria-label="Backend execution events">{traces.map((trace,index)=>{const status=eventStatus(trace,index,traces.length,mission);const statusLabel=status==='active'?'In progress':status==='complete'?'Complete':status==='blocked'?'Needs attention':status==='pending'?'Pending':'Recorded';return <li className={`flow-event is-${status}`} key={trace.id} aria-current={status==='active'?'step':undefined} aria-label={`${trace.title}: ${statusLabel}`}><span className="flow-marker" aria-hidden="true">{status==='complete'?'✓':status==='blocked'?'!':status==='active'?<span/>:'·'}</span><article className="console-message agent-message"><ExecutionEventAvatar trace={trace}/><div><header><strong>MOVA</strong><span>{kind(trace)} · {time(trace.at)}</span><span className="flow-status-label">{statusLabel}</span></header><h3><Icon trace={trace}/>{trace.title}</h3><p>{trace.detail}</p>{trace.source&&<small>Source: {trace.source}</small>}{trace.query&&<><span className="cypher-chip" title={compact(trace.query)}>Cypher gate · hover for condensed query</span><details><summary>Inspect this FalkorDB decision</summary><p>This traversal evaluated the graph at this point in the mission. Its result changes as completed evidence changes.</p>{trace.result?<pre>{JSON.stringify(trace.result,null,2)}</pre>:null}<summary>Inspect the executed Cypher</summary><pre>{trace.query}</pre></details></>}</div></article></li>})}</ol>:<p className="execution-empty">MOVA is waiting for the first backend event.</p>}
        {toolCalls.length>0&&<section className="planned-flow" aria-label="Backend work plan"><h2>Work plan</h2><p>Steps appear here when the backend creates the plan.</p><ol className="execution-flow">{toolCalls.map(step=>{const status=['completed','verified','success'].includes(step.status.toLowerCase())?'complete':['running','executing'].includes(step.status.toLowerCase())?'active':['failed','blocked'].includes(step.status.toLowerCase())?'blocked':'pending';return <li key={step.id} className={`flow-event is-${status}`} aria-current={status==='active'?'step':undefined}><span className="flow-marker" aria-hidden="true">{status==='complete'?'✓':status==='blocked'?'!':status==='active'?<span/>:'·'}</span><article className="console-message agent-message"><ExecutionEventAvatar trace={{id:step.id,at:latest?.at||mission.createdAt,kind:'tool',title:step.title,detail:step.summary||step.title,tool:step.tool,status:step.status}}/><div><header><strong>{step.tool}</strong><span className={`tool-call-status is-${step.status}`}>{step.status}</span></header><h3>{step.title}</h3><p>{step.summary||step.title}</p>{step.dependsOn.length>0&&<small>Dependencies: {step.dependsOn.join(', ')}</small>}</div></article></li>})}</ol></section>}
      </section>
      <aside className="execution-explain" aria-label="Graph explanation">
        <LiveGraph mission={mission}/>
        <AgentRoles mission={mission}/>
        <section><div className="explain-heading"><h2>Multi-hop evidence</h2></div><p>Each relationship below is persisted in the active FalkorDB mission graph.</p><Path mission={mission} edges={mission.graph.edges}/></section>
        <section><div className="explain-heading"><GitBranch size={17}/><h2>What changed</h2></div><p>{latest?`${latest.title}: ${latest.detail}`:'No decision has changed yet.'}</p></section>
        <section><div className="explain-heading"><Wrench size={17}/><h2>Tool calling</h2></div>{toolCalls.length?<ol className="execution-tools">{toolCalls.map(step=><li key={step.id}><strong>{step.tool}</strong><span className={`tool-call-status is-${step.status}`}>{step.status}</span><p>{step.summary||step.title}</p>{step.dependsOn.length>0&&<small>Graph dependencies: {step.dependsOn.join(', ')}</small>}<details><summary>Inputs</summary><pre>{JSON.stringify(step.args||{},null,2)}</pre></details></li>)}</ol>:<p>Tool calls appear here once MOVA has a graph-ready step.</p>}</section>
        <section><div className="explain-heading"><ShieldCheck size={17}/><h2>FalkorDB decision gate</h2></div><p>{graphTraces.length?`${graphTraces.length} persisted graph traversal${graphTraces.length===1?'':'s'} recorded for this mission. A pending tool is released only when its graph dependencies have completed with evidence.`:'The next investigation will create a FalkorDB dependency traversal and tool gate.'}</p>{graphTraces.slice(-4).map(trace=><details className="cypher-card" key={trace.id}><summary title={compact(trace.query||'')}>{trace.title}</summary><pre>{trace.query}</pre></details>)}</section>
      </aside>
    </div>
  </section>;
}
