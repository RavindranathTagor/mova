import { CheckCircle2, Database, GitBranch, ShieldCheck } from 'lucide-react';
import type { Mission } from '../types';
import './falkor-comparison.css';

const readable=(value:string)=>value.replaceAll('_',' ').replace(/\b\w/g,letter=>letter.toUpperCase());

export default function FalkorComparison({mission}:{mission:Mission}){
  const steps=mission.work?.steps||[];
  const evidence=mission.work?.evidence||[];
  const dependencies=mission.graph.edges.filter(edge=>edge.label==='DEPENDS_ON');
  const evidenceLinks=mission.graph.edges.filter(edge=>edge.label==='SUPPORTED_BY');
  const gates=mission.graph.edges.filter(edge=>edge.label==='GATES');
  const graphQueries=mission.trace.filter(trace=>Boolean(trace.query));
  const completed=steps.filter(step=>step.status==='completed').length;
  const nameFor=(id:string)=>steps.find(step=>`step:${step.id}`===id)?.title||id.replace(/^step:/,'');
  const nodeCounts=mission.graph.nodes.reduce<Record<string,number>>((counts,node)=>({...counts,[node.type]:(counts[node.type]||0)+1}),{});
  const impact=mission.work?.evidence.filter(item=>item.source==='FalkorDB multi-hop impact ranking').sort((a,b)=>(b.pathCount||0)-(a.pathCount||0))||[];
  const action=mission.work?.proposals?.at(-1);
  return <section className="falkor-comparison" aria-labelledby="graph-impact-title">
    <header className="comparison-header"><div><p className="comparison-kicker">Live mission comparison</p><h1 id="graph-impact-title">The current task, with and without FalkorDB</h1><p>This view updates from the active mission graph. The linear column is a counterfactual and does not replay reads or external actions.</p></div><span className="comparison-live"><span/>Live graph</span></header>
    <section className="comparison-scoreboard" aria-label="Live FalkorDB mission metrics">
      <Metric value={mission.graph.nodes.length} label="stored graph nodes"/>
      <Metric value={mission.graph.edges.length} label="stored relationships"/>
      <Metric value={graphQueries.length} label="Cypher traversals"/>
      <Metric value={`${completed}/${steps.length||0}`} label="completed tool steps"/>
    </section>
    <section className="comparison-columns">
      <article className="comparison-column with-graph"><header><Database size={20}/><div><h2>With FalkorDB</h2><p>Evidence-Constrained Dispatch</p></div></header><ul>
        <li><CheckCircle2 size={16}/><span>{gates.length} active graph gate{gates.length===1?'':'s'} release only dependency-ready tools.</span></li>
        <li><CheckCircle2 size={16}/><span>{evidenceLinks.length} evidence relationship{evidenceLinks.length===1?'':'s'} preserve which records support each step.</span></li>
        <li><CheckCircle2 size={16}/><span>{dependencies.length} dependency relationship{dependencies.length===1?'':'s'} preserve the real execution order.</span></li>
        <li><ShieldCheck size={16}/><span>External replies remain proposals until a person approves them.</span></li>
      </ul></article>
      <article className="comparison-column without-graph"><header><GitBranch size={20}/><div><h2>Without FalkorDB</h2><p>Sequential counterfactual</p></div></header><ul>
        <li><span className="comparison-zero">0</span><span>persisted mission relationships to inspect after the run.</span></li>
        <li><span className="comparison-zero">0</span><span>Cypher dependency gates. Eligibility would be inferred only from application state.</span></li>
        <li><span className="comparison-zero">0</span><span>stored evidence paths from a decision to its source records.</span></li>
        <li><ShieldCheck size={16}/><span>Approval still applies, but its evidence provenance is not graph-queryable.</span></li>
      </ul></article>
    </section>
    <section className="graph-topology"><header><Database size={19}/><div><h2>Live graph topology</h2><p>Materialized from this mission, not a demo fixture.</p></div></header><div className="topology-nodes">{Object.entries(nodeCounts).map(([type,count])=><span key={type}><b>{count}</b>{type}</span>)}</div><div className="topology-path"><strong>{mission.trigger?'Mention':'Mission'}</strong><i>→</i><strong>Evidence</strong><i>→</i><strong>FalkorDB dispatch gate</strong><i>→</i><strong>Decision</strong><i>→</i><strong>{action?'Approval proposal':'Outcome'}</strong></div><p>{action?`The current action is ${action.status.toLowerCase().replaceAll('_',' ')} and remains graph-linked to the step that produced it.`:'No external action is currently proposed for this mission.'}</p></section>
    <section className="comparison-steps"><header><h2>How this mission is being released</h2><p>Every row is derived from the active plan and FalkorDB graph now.</p></header>{steps.length?<ol>{steps.map((step,index)=>{const needs=step.dependsOn.map(id=>steps.find(candidate=>candidate.id===id)?.title||id);const supporting=evidence.filter(item=>item.stepId===step.id).length;return <li key={step.id}><span className={`comparison-step-status is-${step.status}`}>{step.status==='completed'?<CheckCircle2 size={16}/>:index+1}</span><div><strong>{step.title}</strong><small>{readable(step.tool)} · {readable(step.status)}</small></div><p><b>FalkorDB:</b> {needs.length?`released after ${needs.join(', ')} gained supporting evidence.`:`released as a graph-ready root step.`} {supporting?`${supporting} source record${supporting===1?'':'s'} attached.`:''}</p><p><b>Linear:</b> would follow its planned position without a queryable proof of these dependencies.</p></li>;})}</ol>:<p className="comparison-empty">MOVA will populate this comparison after the model creates the mission plan.</p>}</section>
    {graphQueries.length?<details className="comparison-cypher"><summary>Inspect the latest live FalkorDB query</summary><pre>{graphQueries.at(-1)?.query}</pre></details>:null}
    <section className="impact-ranking"><header><GitBranch size={19}/><div><h2>Multi-hop impact ranking</h2><p>Evidence-Constrained Dispatch uses path count, local relationship degree, and distance from the mission.</p></div></header>{impact.length?<ol>{impact.slice(0,5).map((item,index)=><li key={item.id}><b>#{index+1}</b><div><strong>{item.nodeType||'Work item'} · {item.title}</strong><small>{item.summary}</small></div></li>)}</ol>:<p>The next connected-data mission will run the live impact ranking after it retrieves source evidence.</p>}</section>
  </section>;
}

function Metric({value,label}:{value:number|string;label:string}){return <div><strong>{value}</strong><span>{label}</span></div>;}
