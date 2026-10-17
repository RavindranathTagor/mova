import { useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, type NodeProps, type Node, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './network-graph.css';
import {networkLayout} from './network-layout';
import { MapPin, Clock3, Route, Zap, ShieldCheck, GitBranch, Database, Target } from 'lucide-react';
import type { GraphNode, GraphEdge, Mission } from '../types';

const labels:Record<string,string>={Mission:'Your outcome',Constraint:'Must meet',Place:'Location',RouteOption:'Route',Observation:'New evidence',Entity:'Connection',Capability:'Dependency',Decision:'Decision',ActionReceipt:'Action result',ActionProposal:'Approval action',Mention:'Incoming report',Step:'Work step',Evidence:'Source evidence',Artifact:'Saved output'};
function GraphCard({data}:NodeProps<Node<{item:GraphNode}>>) {
  const item=data.item;
  const Icon=item.type==='Mission'?Target:item.type==='Constraint'?Clock3:item.type==='Place'?MapPin:item.type==='RouteOption'?Route:item.type==='Observation'?Zap:item.type.includes('Action')?ShieldCheck:GitBranch;
  return <div className={`network-node node-${item.status}`} data-kind={item.type}><Handle type="target" position={Position.Top}/><Icon size={18}/><div><small>{labels[item.type]||item.type}</small><strong>{item.label}</strong></div><Handle type="source" position={Position.Bottom}/></div>;
}
const nodeTypes={mission:GraphCard};
export default function Bubble({mission,selectedPlan,onInspect,expanded=false}:{mission:Mission;selectedPlan?:string;onInspect:(item:GraphNode|GraphEdge)=>void;expanded?:boolean}) {
  const [all,setAll]=useState(expanded);
  const plan=mission.plans.find(p=>p.id===(selectedPlan||mission.selectedPlanId));
  const {nodes,edges}=useMemo(()=>{
    const exactEdges=new Set(plan?.decisionPaths?.flatMap(p=>p.edgeIds)||[]);
    const focus=new Set(['mission','deadline',...(plan?.path||[]),...(plan?.decisionPaths?.flatMap(p=>p.nodeIds)||[])]);
    if(plan)focus.add(plan.id);
    const raw=all?mission.graph.nodes:mission.graph.nodes.filter(n=>focus.has(n.id)||(!plan&&['Mission','RouteOption','Observation','ActionReceipt','Evidence','Step','Artifact'].includes(n.type)));
    const ordered=[...raw].sort((a,b)=>{
      const rank=(n:GraphNode)=>n.type==='Mission'?0:n.type==='Constraint'?1:n.type==='RouteOption'?2:n.type==='Entity'?3:n.type==='Capability'?4:5;
      return rank(a)-rank(b);
    });
    const ids=new Set(ordered.map(n=>n.id));
    const positions=networkLayout(ordered.map(item=>item.id),mission.graph.edges);
    const nodes=ordered.map((item,index)=>({id:item.id,type:'mission',data:{item},position:positions.get(item.id)!,ariaLabel:`${item.label}, ${labels[item.type]||item.type}, ${item.status}`,draggable:true}));
    const edges=mission.graph.edges.filter(e=>ids.has(e.source)&&ids.has(e.target)).map(item=>({...item,type:'straight',label:item.label,style:{stroke:exactEdges.has(item.id)?'#2861b9':'#91a0b3',strokeWidth:exactEdges.has(item.id)?2.5:1.3},labelStyle:{fontSize:11,fill:'#35465f'},labelBgStyle:{fill:'#fff',fillOpacity:.96},markerEnd:{type:MarkerType.ArrowClosed,color:'#637893'},ariaLabel:item.explanation}));
    return {nodes,edges};
  },[mission.graph,plan,all]);
  return <div className="bubble-content">
    <div className="bubble-toolbar"><div role="group" aria-label="Graph detail"><button aria-pressed={!all} onClick={()=>setAll(false)}>{mission.kind==='work'?'Work dependencies':'Decision path'}</button><button aria-pressed={all} onClick={()=>setAll(true)}>All connections</button></div><span>{nodes.length} of {mission.graph.nodes.length}</span></div>
    <p className="bubble-explanation">{plan?`${plan.name}: ${plan.feasible?`${plan.slackMinutes} minutes spare after your arrival buffer.`:plan.reason}`:'Evidence connects your request to the tools and results below.'}</p>
    {nodes.length?<div className={`bubble-canvas ${expanded?'expanded':''}`}><ReactFlow key={`${mission.id}-${all}-${selectedPlan||''}`} nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{padding:.2,maxZoom:1}} minZoom={.08} maxZoom={1.5} nodesConnectable={false} onNodeClick={(_,n)=>onInspect(n.data.item)} onEdgeClick={(_,e)=>{const item=mission.graph.edges.find(v=>v.id===e.id);if(item)onInspect(item);}}><Background gap={24} size={1} color="#d9e2eb"/><Controls showInteractive={false}/></ReactFlow></div>:<div className="bubble-empty"><Database size={26}/><p>Gathering connected evidence. Nothing is filled in ahead of the agent.</p></div>}
    <details className="bubble-evidence-list"><summary>Inspect evidence without the canvas</summary><div>{nodes.map(n=><button key={n.id} onClick={()=>onInspect(n.data.item)}>{n.data.item.label}</button>)}{edges.map(e=><button key={e.id} onClick={()=>{const item=mission.graph.edges.find(v=>v.id===e.id);if(item)onInspect(item);}}>{e.label}: {e.source} → {e.target}</button>)}</div></details>
    <div className="bubble-footnote"><Database size={14}/><span>FalkorDB dependencies determine the available actions. Select a node or arrow to inspect its evidence.</span></div>
  </div>;
}

