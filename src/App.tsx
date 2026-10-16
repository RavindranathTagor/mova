import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Check, CheckCircle2, ChevronRight, CircleAlert, Clock3, Compass, Database, GitBranch, History, LoaderCircle, LocateFixed, MapPin, Maximize2, Mic, Navigation, PawPrint, Plug, Plus, RefreshCw, ShieldCheck, Volume2, X } from 'lucide-react';
import Avatar from './components/Avatar';
import Bubble from './components/Bubble';
import MissionMap from './components/MissionMap';
import WorkWorkspace from './components/WorkWorkspace';
import ActivityTrace from './components/ActivityTrace';
import ExecutionConsole from './components/ExecutionConsole';
import FalkorComparison from './components/FalkorComparison';
import { Connections } from './components/Connections';
import type { Envelope, GraphNode, GraphEdge, Mission } from './types';

const empty:Envelope={mission:null,integrations:[],config:{},missions:[]};
const readable=(value:string)=>value.toLowerCase().replaceAll('_',' ');
const at=(value:string)=>new Date(value).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});
const activeStates=['DETECTED','MISSION_CREATED','BUILDING_CONTEXT','INVESTIGATING','PLANNING','POLICY_CHECK','EXECUTING','REPLANNING'];
type Location={latitude:number;longitude:number;accuracy:number;timestamp:number};
type Page='mission'|'connections'|'activity'|'comparison'|'history';
export default function App(){
  const [data,setData]=useState<Envelope>(empty);
  const [page,setPage]=useState<Page>('mission');
  const [connected,setConnected]=useState(false);
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [compose,setCompose]=useState(false);
  const [text,setText]=useState('');
  const [deadline,setDeadline]=useState('');
  const [location,setLocation]=useState<Location>();
  const [selected,setSelected]=useState<string>();
  const [inspected,setInspected]=useState<GraphNode|GraphEdge|null>(null);
  const [expanded,setExpanded]=useState(false);
  const [voice,setVoice]=useState(false);
  const [monitoring,setMonitoring]=useState(true);
  const [needsInput,setNeedsInput]=useState(false);
  const [inputText,setInputText]=useState('');
  const dialog=useRef<HTMLDialogElement>(null);
  const inputDialog=useRef<HTMLDialogElement>(null);
  const mission=data.mission?.mode==='live'?data.mission:null;
  const travel=mission?.kind==='travel';
  const work=mission?.kind==='work';
  const inputPrompt=mission?.inputRequest||{question:mission?.summary||'What should MOVA use to continue?',options:[] as string[]};
  const position=data.tracking?.enabled&&!data.tracking?.error?data.tracking?.position:null;
  useEffect(()=>{
    fetch('/api/state').then(r=>{if(!r.ok)throw new Error('The agent server is unavailable. Start the backend and reconnect.');return r.json();}).then(setData).catch(e=>setError(e.message));
    const events=new EventSource('/api/events');
    events.addEventListener('state',event=>{setData(JSON.parse((event as MessageEvent).data));setConnected(true);});
    events.onerror=()=>setConnected(false);
    return()=>events.close();
  },[]);
  useEffect(()=>{setSelected(mission?.selectedPlanId);setInspected(null);},[mission?.id,mission?.selectedPlanId,mission?.revision]);
  useEffect(()=>{
    if(!travel||!mission||!monitoring||!['AWAITING_APPROVAL','VERIFYING','BLOCKED'].includes(mission.state))return;
    const timer=setInterval(()=>{if(document.visibilityState==='visible')void request(`/api/missions/${mission.id}/observe`,{},false);},60000);
    return()=>clearInterval(timer);
  },[mission?.id,mission?.state,travel,monitoring]);
  useEffect(()=>{if(inspected||expanded){dialog.current?.showModal();}else dialog.current?.close();},[inspected,expanded]);
  useEffect(()=>{if(mission?.state==='BLOCKED'&&mission.inputRequest?.question)setNeedsInput(true);},[mission?.id,mission?.revision,mission?.state,mission?.inputRequest?.question]);
  useEffect(()=>{if(needsInput)inputDialog.current?.showModal();else inputDialog.current?.close();},[needsInput]);
  async function request(path:string,body:unknown,foreground=true){
    if(foreground){setBusy(path);setError('');}
    try{
      const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','x-mova-client':'web'},body:JSON.stringify(body)});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'The request could not complete.');
      if('mission'in result)setData(old=>({...result,tracking:result.tracking||old.tracking}));
      return result;
    }catch(e){setError((e as Error).message);return null;}finally{if(foreground)setBusy('');}
  }
  function locate(){
    if(!navigator.geolocation){setError('Location is unavailable in this browser. Connect your phone through Traccar.');return;}
    setNotice('Waiting for a fresh location from this device…');
    navigator.geolocation.getCurrentPosition(async p=>{
      const value={latitude:p.coords.latitude,longitude:p.coords.longitude,accuracy:p.coords.accuracy,timestamp:p.timestamp};
      setLocation(value);await request('/api/location',value);
      setNotice(`Location received, accuracy ±${Math.round(value.accuracy)} m.`);
    },e=>{setNotice('');setError(e.code===1?'Location permission was denied. Enable browser location access or connect Traccar in Connections.':'A fresh location could not be obtained. Check location services and try again.');},{enableHighAccuracy:true,maximumAge:0,timeout:20000});
  }
  async function start(e:React.FormEvent){
    e.preventDefault();if(!text.trim())return;
    setCompose(false);setPage('mission');setNotice('');
    await request('/api/missions',{text:text.trim(),mode:'live',...(deadline?{deadlineMinutes:Number(deadline)}:{}),...(location?{origin:location}:{})});
  }
  function listen(){
    const Recognition=(window as any).SpeechRecognition||(window as any).webkitSpeechRecognition;
    if(!Recognition){setError('Voice input is unavailable in this browser. Type your request instead.');return;}
    const recognition=new Recognition();recognition.lang='en-IN';
    recognition.onresult=(e:any)=>{setText(e.results[0][0].transcript);setCompose(true);setNotice('Review your dictated request, then start.');};
    recognition.onerror=()=>setError('Could not capture speech. Check microphone permission.');
    recognition.start();setNotice('Listening…');
  }
  async function speak(){
    if(!mission)return;setVoice(true);
    try{
      const r=await fetch('/api/speech',{method:'POST',headers:{'Content-Type':'application/json','x-mova-client':'web'},body:JSON.stringify({text:mission.summary})});
      if(!r.ok)throw new Error((await r.json()).error);
      const url=URL.createObjectURL(await r.blob());const audio=new Audio(url);
      const finish=()=>{URL.revokeObjectURL(url);setVoice(false);};
      audio.onended=finish;audio.onerror=finish;await audio.play();
    }catch(e){setVoice(false);setError((e as Error).message);}
  }
  const composer=<form className="request-form" onSubmit={start}>
    <label htmlFor="request">What would you like MOVA to do?</label>
    <div className="request-entry"><textarea id="request" name="request" autoComplete="off" value={text} onChange={e=>setText(e.target.value)} placeholder="Investigate this pull request, trace a rejected feature request, or prepare a source-backed response…" required maxLength={2000} rows={3}/><button type="button" className="icon-button" onClick={listen} title="Dictate your request" aria-label="Dictate your request"><Mic size={20}/></button></div>
    <div className="request-options"><button className="primary" disabled={!!busy||!text.trim()} type="submit">{busy?<LoaderCircle size={17} className="spin"/>:<ArrowRight size={17}/>}Start investigation</button></div>
    <div className="request-examples" aria-label="Request ideas"><button type="button" onClick={()=>setText('Inspect the public GitHub issues and recent approved community messages for this feature request. Determine whether it was previously rejected, explain why with sources, and propose a concise reply for my approval.')}>Trace a rejected idea</button><button type="button" onClick={()=>setText('Inspect this public pull request and related issues for duplicate work or a conflicting earlier decision. Produce evidence and propose a GitHub comment only if the conflict is clear.')}>Review a pull request</button><button type="button" onClick={()=>setText('Research an emerging issue across connected sources and save a source-linked decision brief with the next owner and the path of evidence.')}>Investigate connected context</button></div><p className="quiet">MOVA reads connected evidence, follows graph relationships, and asks before it posts or comments.</p>
  </form>;
  return <div className="mova-app">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <aside className="app-nav"><a className="brand" href="/" aria-label="MOVA home"><PawPrint size={28}/><strong>MOVA</strong></a><p>Agents that act on connected data</p><nav aria-label="Workspace">
      {([['mission','Agent',Compass],['connections','Connections',Plug],['activity','Live execution',Activity],['comparison','Graph impact',GitBranch],['history','History',History]] as const).map(([id,label,Icon])=><button key={id} aria-current={page===id?'page':undefined} onClick={()=>setPage(id)}><Icon size={19}/>{label}</button>)}
    </nav><div className="nav-companion"><Avatar state={mission?.agentStatus||'restful'} size={94}/><p>Keep the outcome.<br/>Change the plan.</p></div><div className="server-status"><span className={connected?'status-dot online':'status-dot'}/>{connected?'Agent connected':'Reconnecting…'}</div></aside>
    <main className="app-main" id="main-content" tabIndex={-1}>
      <header className="workspace-header"><div><span>MOVA workspace</span><strong>{page==='connections'?'Connections':page==='activity'?'Live execution':page==='comparison'?'FalkorDB graph impact':page==='history'?'Request history':'Your active investigation'}</strong></div><div className="header-actions"><span className="model-label">MOVA reasoning</span><button className="primary" onClick={()=>{setCompose(v=>!v);setPage('mission');}}><Plus size={17}/>New request</button></div></header>
      {error&&<div className="feedback error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={()=>setError('')}><X size={17}/></button></div>}
      {notice&&<div className="feedback notice" role="status"><span>{notice}</span><button aria-label="Dismiss notice" onClick={()=>setNotice('')}><X size={17}/></button></div>}
      {page==='connections'?<Connections/>:page==='history'?<section className="history-page"><h1>Request history</h1><p>Real requests and their last recorded outcome.</p>{data.missions.length?data.missions.map(m=><article key={m.id}><strong>{m.title}</strong><span>{readable(m.state)}</span><button className="secondary" disabled={!!busy} onClick={async()=>{await request(`/api/missions/${m.id}/select`,{});setPage('mission');}}>Open request<ArrowRight size={16}/></button></article>):<p>No requests yet.</p>}</section>:page==='activity'?mission?<ExecutionConsole mission={mission}/>:<section className="empty-workspace"><h1>No investigation is running</h1><p>Start an investigation to see MOVA’s decisions, tool calls, graph paths, and verification here.</p><button className="primary" onClick={()=>setPage('mission')}>Start investigation<ArrowRight size={17}/></button></section>:page==='comparison'?mission?<FalkorComparison mission={mission}/>:<section className="empty-workspace"><h1>No active mission to compare</h1><p>Start an investigation to inspect its live FalkorDB graph and counterfactual linear execution.</p><button className="primary" onClick={()=>setPage('mission')}>Start investigation<ArrowRight size={17}/></button></section>:<>
        {compose||!mission?<section className="composer-section">{!mission&&<div className="welcome-copy"><Avatar state="restful" size={112}/><div><p className="hook-line">Agents that act on connected data</p><h1>What should MOVA investigate?</h1><p>Give MOVA a decision to verify. It follows relationships across connected sources, explains the evidence path, and asks before taking an external action.</p></div></div>}{composer}</section>:null}
        {!mission?<section className="setup-empty"><Plug size={24}/><div><h2>Start with the right connections</h2><p>Connect web, GitHub, Slack, Discord, calendar, and weather. MOVA will show what it needs before it acts.</p></div><button className="secondary" onClick={()=>setPage('connections')}>Check connections<ChevronRight size={17}/></button></section>:<>
          <section className="outcome-heading"><div><h1>{mission.title}</h1><p>{mission.successCriteria}</p></div><span className={`state-badge state-${mission.state.toLowerCase()}`}>{mission.state==='RESOLVED'?<CheckCircle2 size={16}/>:<Activity size={16}/>} {readable(mission.state)}</span></section>
          <section className="agent-update" aria-live="polite"><Avatar state={mission.agentStatus} size={84}/><div><strong>{activeStates.includes(mission.state)?'MOVA is working':mission.state==='BLOCKED'?'MOVA needs something to continue':mission.state==='RESOLVED'?'Result verified':'MOVA’s latest update'}</strong><p>{mission.summary}</p></div><button className="icon-button" onClick={speak} disabled={voice} title="Read update aloud" aria-label="Read update aloud">{voice?<LoaderCircle size={19} className="spin"/>:<Volume2 size={19}/>}</button></section>
          {work&&mission.state==='BLOCKED'&&mission.inputRequest?<section className="attention-request" aria-labelledby="attention-title"><CircleAlert size={24}/><div><p className="attention-kicker">Attention required</p><h2 id="attention-title">{mission.inputRequest.question}</h2><p><b>Why MOVA stopped:</b> {mission.inputRequest.reason||mission.summary}</p>{mission.inputRequest.options.length?<div className="attention-options">{mission.inputRequest.options.map(option=><button key={option} className="secondary" disabled={!!busy} onClick={()=>{setInputText(option);setNeedsInput(true);}}>{option}</button>)}</div>:null}</div><button className="primary" disabled={!!busy} onClick={()=>setNeedsInput(true)}>Answer MOVA<ArrowRight size={16}/></button></section>:null}
          <Execution mission={mission}/>
          {travel&&<div className="journey-context"><span><MapPin size={16}/>{mission.origin?.label||mission.origin?.name||'Waiting for your position'}</span><ArrowRight size={15}/><span>{mission.destination?.label||mission.destination?.name||'Finding destination'}</span><span className="deadline"><Clock3 size={16}/>Arrive before {at(new Date(new Date(mission.deadline).getTime()-Number(mission.constraints.bufferMinutes||0)*60000).toISOString())}</span></div>}
          <div className={`outcome-grid ${travel?'':work?'work-outcome':'read-outcome'}`}>
            <section className="journey-panel">{travel?<><div className="section-heading"><div><h2>Your route</h2><p>Traffic-aware estimates and directions, here in MOVA.</p></div><Navigation size={21}/></div><MissionMap mission={mission} selectedPlan={selected||mission.selectedPlanId} onSelect={setSelected} onLocate={locate} mapsProvider={data.config.mapsProvider} tileUrl={data.config.tileUrl} trackingPosition={position}/>
              <div className="route-options" aria-label="Available routes">{mission.plans.map(plan=><button key={plan.id} className={`route-option ${plan.id===(selected||mission.selectedPlanId)?'selected':''}`} onClick={()=>setSelected(plan.id)} aria-pressed={plan.id===(selected||mission.selectedPlanId)}><span className="route-selector">{plan.id===(selected||mission.selectedPlanId)&&<Check size={13}/>}</span><span><strong>{plan.name}</strong><small>{plan.feasible?`${plan.slackMinutes} min spare`:plan.reason}{plan.trafficDelaySeconds!=null?` · ${Math.ceil(plan.trafficDelaySeconds/60)} min traffic delay`:''}</small></span><b>{plan.durationMinutes}<small>min</small></b></button>)}</div>
              <div className="map-monitor"><span>{data.tracking?.error||position?`Phone: ${data.tracking?.error||'fresh location received'}`:'Phone location not received yet'}</span><button onClick={()=>setPage('connections')}>Tracking setup</button><button onClick={()=>{if(mission)void request(`/api/missions/${mission.id}/observe`,{});}} disabled={!!busy}><RefreshCw size={14}/>Refresh routes</button><button onClick={()=>setMonitoring(v=>!v)}>{monitoring?'Pause route checks':'Resume route checks'}</button></div>
            </>:work?<WorkWorkspace mission={mission} busy={!!busy} onUpdate={text=>request(`/api/missions/${mission.id}/context`,{text})} onResolveAction={(proposalId,outcome)=>request(`/api/missions/${mission.id}/proposals/${proposalId}`,{revision:mission.revision,outcome})}/>:<Result mission={mission}/>}</section>
            <section className="reason-panel"><div className="section-heading"><div><h2>FalkorDB decision graph</h2><p>Live evidence paths and dependencies for this mission.</p></div><button className="icon-button" title="Expand FalkorDB decision graph" aria-label="Expand FalkorDB decision graph" onClick={()=>setExpanded(true)}><Maximize2 size={18}/></button></div><Bubble mission={mission} selectedPlan={selected||mission.selectedPlanId} onInspect={setInspected}/></section>
          </div>
          <section className="next-action"><ShieldCheck size={24}/><div><h2>{travel&&mission.state==='AWAITING_APPROVAL'?'Ready to start route guidance':travel&&mission.state==='VERIFYING'?'Guidance is open. Checking the outcome.':mission.state==='BLOCKED'?'MOVA needs your input':mission.state==='RESOLVED'?'Outcome checked against evidence':work?'Your next step':'Working toward your outcome'}</h2><p>{travel&&mission.state==='AWAITING_APPROVAL'?`MOVA selected ${mission.plans.find(p=>p.id===mission.selectedPlanId)?.name||'a route'}. Directions will open in this page. Arrival still needs fresh location evidence.`:travel&&mission.state==='VERIFYING'?'Keep phone tracking enabled. Opening directions does not mean you have arrived.':mission.summary}</p></div><div>{travel&&mission.state==='AWAITING_APPROVAL'?<button className="primary" disabled={!!busy} onClick={()=>request(`/api/missions/${mission.id}/approve`,{revision:mission.revision})}><Navigation size={17}/>Start guidance</button>:work&&mission.state==='BLOCKED'?<button className="primary" disabled={!!busy} onClick={()=>setNeedsInput(true)}>Give MOVA input</button>:['FAILED_RETRYABLE','UNKNOWN'].includes(mission.state)?<button className="secondary" disabled={!!busy} onClick={()=>request(`/api/missions/${mission.id}/resume`,{})}><RefreshCw size={17}/>Check again</button>:null}</div></section>
          <ActivityTrace mission={mission}/>
          {mission.receipts.length>0&&<section className="receipt-section"><h2>Action receipts</h2>{mission.receipts.map(r=><details key={r.id}><summary><ShieldCheck size={17}/><strong>{r.tool.replaceAll('_',' ')}</strong><span>{readable(r.status)}</span><time>{at(r.at)}</time></summary><p>{r.summary}</p>{r.verification&&<pre>{typeof r.verification==='string'?r.verification:JSON.stringify(r.verification,null,2)}</pre>}</details>)}</section>}
        </>}
      </>}
      <footer className="workspace-footer"><Database size={14}/>Connected evidence in FalkorDB<span>Source → decision → action → verification</span></footer>
    </main>
    <dialog ref={dialog} className="evidence-dialog" onCancel={()=>{setInspected(null);setExpanded(false);}}><button className="dialog-close icon-button" aria-label="Close details" onClick={()=>{setInspected(null);setExpanded(false);}}><X size={21}/></button>{inspected?<Inspector item={inspected}/>:expanded&&mission?<><h2>Mission Bubble</h2><p>Every connection comes from the mission’s stored graph. Select an item for its evidence.</p><Bubble mission={mission} selectedPlan={selected||mission.selectedPlanId} onInspect={setInspected} expanded/></>:null}</dialog>
    <dialog ref={inputDialog} className="agent-input-dialog" onCancel={()=>setNeedsInput(false)}>{mission&&<><button className="dialog-close icon-button" aria-label="Close MOVA input request" onClick={()=>setNeedsInput(false)}><X size={19}/></button><div className="action-agent-message"><Avatar state="thinking" size={46}/><div><strong>MOVA asks</strong><p>{inputPrompt.question}</p></div></div><h2>Give MOVA the missing decision</h2>{inputPrompt.reason&&<p className="input-blocker"><b>Blocked because:</b> {inputPrompt.reason}</p>}{inputPrompt.options.length>0&&<div className="input-suggestions">{inputPrompt.options.map(option=><button key={option} type="button" onClick={()=>setInputText(option)}>{option}</button>)}</div>}<form onSubmit={async event=>{event.preventDefault();if(!inputText.trim()||!mission)return;const answer=inputText.trim();setInputText('');setNeedsInput(false);await request(`/api/missions/${mission.id}/context`,{text:answer});}}><label htmlFor="agent-input">Your instruction or missing context</label><textarea id="agent-input" name="agent-input" autoComplete="off" value={inputText} onChange={event=>setInputText(event.target.value)} maxLength={2000} placeholder={inputPrompt.placeholder||inputPrompt.question} required/><button className="primary" disabled={!!busy||!inputText.trim()}>Continue investigation<ArrowRight size={16}/></button></form></>}</dialog>
  </div>;
}
function Execution({mission}:{mission:Mission}){
  const groups=[{label:'Understand',states:['DETECTED','MISSION_CREATED']},{label:'Gather context',states:['BUILDING_CONTEXT','INVESTIGATING']},{label:'Choose a plan',states:['PLANNING','POLICY_CHECK','REPLANNING','AWAITING_APPROVAL']},{label:'Take action',states:['EXECUTING']},{label:'Verify',states:['VERIFYING','RESOLVED']}];
  const recent=mission.trace.filter(t=>t.kind==='state').map(t=>t.title.replaceAll(' ','_'));
  const index=groups.findIndex(g=>g.states.includes(mission.state));
  return <section className="execution-panel" aria-label="Live execution"><div className="execution-heading"><span><Activity size={17}/>Live execution</span><span>{activeStates.includes(mission.state)?'Running':readable(mission.state)}</span></div><ol>{groups.map((g,i)=>{const done=mission.state==='RESOLVED'||(index>i&&recent.some(s=>g.states.includes(s)));const active=i===index&&mission.state!=='RESOLVED';return <li key={g.label} className={active?'current':done?'done':''}><span>{done?<Check size={14}/>:active?<span className="execution-pulse"/>:i+1}</span><strong>{g.label}</strong></li>;})}</ol></section>;
}
function Inspector({item}:{item:GraphNode|GraphEdge}){
  const edge='target'in item;
  return <><h2>{item.label.replaceAll('_',' ')}</h2><p>{edge?item.explanation:'This entity is part of the evidence used for the current request.'}</p><dl className="evidence-fields"><div><dt>Evidence type</dt><dd>{readable(item.evidenceKind||'unknown')}</dd></div><div><dt>Source</dt><dd>{edge?item.provenance:item.source}</dd></div><div><dt>Observed</dt><dd>{item.observedAt?new Date(item.observedAt).toLocaleString():'Unknown timestamp'}</dd></div><div><dt>State</dt><dd>{readable(item.status||'unknown')}</dd></div>{edge?<div><dt>Connection</dt><dd>{item.source} → {item.target}</dd></div>:null}</dl>{!edge&&<details><summary>Properties used by the agent</summary><pre>{JSON.stringify(item.properties,null,2)}</pre></details>}</>;
}
function Result({mission}:{mission:Mission}){
  const result=mission.result;
  return <div className="read-result"><h2>{mission.kind==='weather'?'Weather result':mission.kind==='calendar_read'?'Your calendar':'Request result'}</h2>{!result?<p>{mission.summary}</p>:<><p className="result-source">{String(result.source||'Connected tool')} · {result.observedAt?new Date(result.observedAt).toLocaleString():''}</p>{mission.kind==='calendar_read'?<div>{Array.isArray(result.events)&&result.events.length?result.events.map((e:any,i:number)=><article key={e.id||i}><strong>{e.summary||'Untitled event'}</strong><p>{e.start?.dateTime||e.start?.date||'Time unavailable'}{e.location?` · ${e.location}`:''}</p></article>):<p>No events returned for the requested period.</p>}</div>:mission.kind==='weather'&&result.current?<dl>{Object.entries(result.current).map(([key,value])=><div key={key}><dt>{key.replaceAll('_',' ')}</dt><dd>{String(value)} {result.current_units?.[key]||''}</dd></div>)}</dl>:<p>{mission.summary}</p>}<details><summary>Inspect source response</summary><pre>{JSON.stringify(result,null,2)}</pre></details></>}</div>;
}

