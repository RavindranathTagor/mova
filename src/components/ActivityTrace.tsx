import { useState } from 'react';
import { Check, Circle, Database, Wrench, GitBranch, ArrowUpRight } from 'lucide-react';
import type { Mission, Trace } from '../types';
const friendly=(t:Trace)=>t.kind==='agent'?'MOVA’s decision':t.title==='Connected plans evaluated'?'Compared connected alternatives':t.title;
export default function ActivityTrace({mission}:{mission:Mission}) {
  const [technical,setTechnical]=useState(false);
  const entries=mission.trace.filter(t=>technical||t.kind!=='state');
  const compact=entries.filter((t,i)=>technical||i===entries.length-1||t.title!==entries[i+1]?.title).slice(-20).reverse();
  return <section className="activity-panel" aria-labelledby="activity-title"><div className="section-heading"><div><h2 id="activity-title">What MOVA has done</h2><p>Decisions, tool responses, and evidence — as they happen.</p></div><label className="trace-toggle"><input type="checkbox" checked={technical} onChange={e=>setTechnical(e.target.checked)}/>Technical events</label></div>
    {!compact.length?<p className="empty-copy">The first source response will appear here.</p>:<ol className="activity-list">{compact.map((t,i)=>{const Icon=t.query?Database:t.kind==='tool'?Wrench:t.kind==='agent'?GitBranch:t.kind==='action'?Check:Circle;return <li key={t.id}><span className={`activity-icon ${i===0?'latest':''}`}><Icon size={16}/></span><details open={i===0}><summary><div><strong>{friendly(t)}</strong><span>{t.source||t.tool?.replaceAll('_',' ')||'Mission controller'}</span></div><time dateTime={t.at}>{new Date(t.at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time><ArrowUpRight size={14}/></summary><p>{t.detail}</p>{t.evidenceIds?.length?<small>Evidence: {t.evidenceIds.join(', ')}</small>:null}{t.query&&<details className="query-detail"><summary>Inspect exact graph query</summary><pre>{t.query}</pre></details>}</details></li>;})}</ol>}
  </section>;
}
