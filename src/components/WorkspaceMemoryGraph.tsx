import {useState} from 'react';
import Bubble from './Bubble';
import type {Mission,GraphNode,GraphEdge} from '../types';
export default function WorkspaceMemoryGraph({mission}:{mission:Mission}){
  const [graph,setGraph]=useState<Mission['graph']|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState<GraphNode|GraphEdge|null>(null);
  async function load(){setBusy(true);setError('');try{const response=await fetch('/api/memory/graph');if(!response.ok)throw Error('Workspace memory could not be loaded.');setGraph(await response.json());}catch(e){setError(e instanceof Error?e.message:'Memory unavailable.');}finally{setBusy(false);}}
  return <section style={{marginTop:20}} aria-label="Persistent workspace memory"><h2>Workspace memory</h2><p>Previous tasks, resource scopes, evidence and incident receipts stored in FalkorDB. Shows up to 120 nodes.</p><button className="secondary" disabled={busy} onClick={()=>void load()}>{busy?'Loading memory…':graph?'Refresh memory graph':'Explore persistent memory'}</button>{error&&<p role="alert">{error}</p>}{graph&&<>{graph.nodes.length?<Bubble mission={{...mission,plans:[],selectedPlanId:undefined,graph}} expanded onInspect={setSelected}/>:<p>No workspace memory has been recorded yet. Complete a connected-data task to populate it.</p>}{selected&&<details open><summary>{selected.label}</summary><pre style={{overflow:'auto',maxHeight:280}}>{JSON.stringify(selected,null,2)}</pre></details>}</>}</section>;
}
