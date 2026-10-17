import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Check, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, Clock3, Compass, Database, GitBranch, History, LoaderCircle, LocateFixed, MapPin, Maximize2, Mic, Navigation, PawPrint, Plug, Plus, RefreshCw, ShieldCheck, Volume2, X } from 'lucide-react';
import { startTransition } from 'react';
import Avatar from './components/Avatar';
import Bubble from './components/Bubble';
import MissionMap from './components/MissionMap';
import WorkWorkspace from './components/WorkWorkspace';
import ActivityTrace from './components/ActivityTrace';
import ExecutionConsole from './components/ExecutionConsole';
import FalkorComparison from './components/FalkorComparison';
import { Connections } from './components/Connections';
import Workflows,{WorkflowPicker,type Workflow} from './components/Workflows';
import type { Envelope, GraphNode, GraphEdge, Mission } from './types';

const empty:Envelope={mission:null,integrations:[],config:{},missions:[]};
type ApiResponse=Record<string,unknown>&{mission?:Mission|null};
const readable=(value:string)=>value.toLowerCase().replaceAll('_',' ');
const at=(value:string)=>new Date(value).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});
async function responseBody(response:Response){
  const text=await response.text();
  if(!text.trim())throw new Error(`The MOVA server returned an empty response (${response.status}). Restart the server and try again.`);
  try{return JSON.parse(text) as ApiResponse;}catch{throw new Error(`The MOVA server returned an invalid response (${response.status}). Restart the server and try again.`);}
}
const activeStates=['DETECTED','MISSION_CREATED','BUILDING_CONTEXT','INVESTIGATING','PLANNING','POLICY_CHECK','EXECUTING','REPLANNING'];
type Location={latitude:number;longitude:number;accuracy:number;timestamp:number};
type Page='mission'|'connections'|'activity'|'comparison'|'history'|'workflows';
const missionHeading=(mission:Mission)=>mission.kind==='weather'&&mission.intent?.destinationQuery
  ?`Get current weather information for ${mission.intent.destinationQuery}`
  :mission.title;
function mergeEnvelope(previous:Envelope,next:Envelope):Envelope{
  const oldMission=previous.mission,newMission=next.mission;
  const oldTime=oldMission?.trace.length?Date.parse(oldMission.trace.at(-1)!.at):0;
  const newTime=newMission?.trace.length?Date.parse(newMission.trace.at(-1)!.at):0;
  const keepOld=oldMission&&newMission&&oldMission.id===newMission.id&&(
    oldMission.revision>newMission.revision||
    oldMission.trace.length>newMission.trace.length||
    oldMission.trace.length===newMission.trace.length&&oldTime>newTime
  );
  return {...next,mission:keepOld?oldMission:newMission,tracking:next.tracking||previous.tracking};
}
export default function App(){
  const [data,setData]=useState<Envelope>(empty);
  const [page,setPage]=useState<Page>('mission');
  const [connected,setConnected]=useState(false);
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [selectedMissionId,setSelectedMissionId]=useState<string>();
  const selectedMissionIdRef=useRef<string|undefined>(undefined);
  const [missionPending,setMissionPending]=useState(false);
  const [sidebarCollapsed,setSidebarCollapsed]=useState(false);
  const [compose,setCompose]=useState(false);
  const [text,setText]=useState('');
  const [workflowId,setWorkflowId]=useState('');
  function useWorkflow(workflow:Workflow){setWorkflowId(workflow.id);setText('');setCompose(true);selectMission(undefined);setPage('mission');}
  const [deadline,setDeadline]=useState('');
  const [location,setLocation]=useState<Location>();
  const [selected,setSelected]=useState<string>();
  const [inspected,setInspected]=useState<GraphNode|GraphEdge|null>(null);
  const [expanded,setExpanded]=useState(false);
  const [voice,setVoice]=useState(false);
  const [monitoring,setMonitoring]=useState(true);
  const [needsInput,setNeedsInput]=useState(false);
  const [inputText,setInputText]=useState('');
  const creatingMission=useRef(false);
  const streamEnvelope=useRef<Envelope|null>(null);
  const streamFrame=useRef<number|null>(null);
  const dialog=useRef<HTMLDialogElement>(null);
  const inputDialog=useRef<HTMLDialogElement>(null);
  const mission=selectedMissionId&&data.mission?.id===selectedMissionId&&data.mission.mode==='live'?data.mission:null;
  const travel=mission?.kind==='travel';
  const work=mission?.kind==='work';
  const missionNeedsAttention=['BLOCKED','FAILED_RETRYABLE','UNKNOWN'].includes(mission?.state||'');
  const inputPrompt=mission?.inputRequest||{question:mission?.summary||'What should MOVA use to continue?',options:[] as string[]};
  const position=data.tracking?.enabled&&!data.tracking?.error?data.tracking?.position:null;
  function receiveState(incoming:Envelope){
    setData(previous=>{
      if(selectedMissionIdRef.current&&incoming.mission?.id!==selectedMissionIdRef.current)return {...incoming,mission:previous.mission,tracking:incoming.tracking||previous.tracking};
      return mergeEnvelope(previous,incoming);
    });
  }
  useEffect(()=>{
    fetch('/api/state').then(async r=>{const result=await responseBody(r);if(!r.ok)throw new Error(String(result.error||'The agent server is unavailable. Start the backend and reconnect.'));return result as Envelope;}).then(receiveState).catch(e=>setError(e.message));
    const events=new EventSource('/api/events');
    events.addEventListener('state',event=>{
      const incoming=JSON.parse((event as MessageEvent).data) as Envelope;
      streamEnvelope.current=incoming;
      if(streamFrame.current===null)streamFrame.current=requestAnimationFrame(()=>{
        const latest=streamEnvelope.current;streamEnvelope.current=null;streamFrame.current=null;
        if(latest)startTransition(()=>receiveState(latest));
      });
      setConnected(true);
    });
    events.onerror=()=>setConnected(false);
    return()=>{events.close();if(streamFrame.current!==null)cancelAnimationFrame(streamFrame.current);};
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
  function selectMission(id?:string){selectedMissionIdRef.current=id;setSelectedMissionId(id);}
  async function request(path:string,body:unknown,foreground=true){
    if(foreground){setBusy(path);setError('');}
    try{
      const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','x-mova-client':'web'},body:JSON.stringify(body)});
      const result=await responseBody(response);
      if(!response.ok)throw new Error(String(result.error||'The request could not complete.'));
      if('mission'in result)setData(old=>mergeEnvelope(old,result as Envelope));
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
    e.preventDefault();if(!text.trim()||creatingMission.current)return;
    creatingMission.current=true;selectMission(undefined);setMissionPending(true);setCompose(false);setPage('mission');setNotice('');
    const result=await request('/api/missions',{text:text.trim(),...(workflowId?{workflowId}:{}),mode:'live',...(deadline?{deadlineMinutes:Number(deadline)}:{}),...(location?{origin:location}:{})});
    if(result?.mission?.id){selectMission(result.mission.id);setMissionPending(false);}
    else{setMissionPending(false);setCompose(true);}
    creatingMission.current=false;
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
    <WorkflowPicker value={workflowId} onChange={setWorkflowId} onManage={()=>setPage('workflows')}/>
    <label htmlFor="request">What would you like MOVA to do?</label>
    <div className="request-entry"><textarea id="request" name="request" autoComplete="off" value={text} onChange={e=>setText(e.target.value)} placeholder="Investigate this pull request, trace a rejected feature request, or prepare a source-backed response…" required maxLength={2000} rows={3}/><button type="button" className="icon-button" onClick={listen} title="Dictate your request" aria-label="Dictate your request"><Mic size={20}/></button></div>
    <div className="request-options"><button className="primary" disabled={!!busy||!text.trim()} type="submit">{busy?<LoaderCircle size={17} className="spin"/>:<ArrowRight size={17}/>}Start investigation</button></div>
    <div className="request-examples" aria-label="Request ideas"><button type="button" onClick={()=>setText('Inspect the public GitHub issues and recent approved community messages for this feature request. Determine whether it was previously rejected, explain why with sources, and propose a concise reply for my approval.')}>Trace a rejected idea</button><button type="button" onClick={()=>setText('Inspect this public pull request and related issues for duplicate work or a conflicting earlier decision. Produce evidence and propose a GitHub comment only if the conflict is clear.')}>Review a pull request</button><button type="button" onClick={()=>setText('Research an emerging issue across connected sources and save a source-linked decision brief with the next owner and the path of evidence.')}>Investigate connected context</button></div><p className="quiet">MOVA reads connected evidence, follows graph relationships, and asks before it posts or comments.</p>
  </form>;
  return <div className={`mova-app${sidebarCollapsed?' sidebar-collapsed':''}`}>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <aside className="app-nav"><div className="sidebar-top"><a className="brand" href="/" aria-label="MOVA home"><PawPrint size={28}/><strong>MOVA</strong></a><button className="sidebar-toggle" type="button" aria-label={sidebarCollapsed?'Expand sidebar':'Collapse sidebar'} aria-expanded={!sidebarCollapsed} aria-controls="workspace-navigation" onClick={()=>setSidebarCollapsed(collapsed=>!collapsed)} title={sidebarCollapsed?'Expand sidebar':'Collapse sidebar'}>{sidebarCollapsed?<ChevronRight size={18}/>:<ChevronLeft size={18}/>}</button></div><p className="sidebar-tagline">Agents that act on connected data</p><nav id="workspace-navigation" aria-label="Workspace">
      {([['mission','Agent',Compass],['workflows','Workflows',GitBranch],['connections','Connections',Plug],['activity','Live execution',Activity],['comparison','Graph impact',GitBranch],['history','History',History]] as const).map(([id,label,Icon])=><button key={id} aria-label={label} title={sidebarCollapsed?label:undefined} aria-current={page===id?'page':undefined} onClick={()=>setPage(id)}><Icon size={19}/><span className="nav-label">{label}</span></button>)}
    </nav><div className="nav-companion"><img className="sidebar-puppy" src="/images/mova-sleeping-transparent.png" alt="MOVA's sleeping puppy" width={94} height={94}/><p>Keep the outcome.<br/>Change the plan.</p></div><div className="server-status"><span className={connected?'status-dot online':'status-dot'}/><span className="server-status-label">{connected?'Agent connected':'Reconnecting…'}</span></div></aside>
    <main className="app-main" id="main-content" tabIndex={-1}>
      <header className="workspace-header"><div><span>MOVA workspace</span><strong>{page==='workflows'?'Workflows':page==='connections'?'Connections':page==='activity'?'Live execution':page==='comparison'?'FalkorDB graph impact':page==='history'?'Request history':'Your active investigation'}</strong></div><div className="header-actions"><span className="model-label">MOVA reasoning</span><button className="primary" disabled={missionPending} onClick={()=>{selectMission(undefined);setMissionPending(false);setCompose(true);setPage('mission');}}><Plus size={17}/>New request</button></div></header>
      {error&&<div className="feedback error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={()=>setError('')}><X size={17}/></button></div>}
      {notice&&<div className="feedback notice" role="status"><span>{notice}</span><button aria-label="Dismiss notice" onClick={()=>setNotice('')}><X size={17}/></button></div>}
      {page==='workflows'?<Workflows onUse={useWorkflow}/>:page==='connections'?<Connections/>:page==='history'?<section className="history-page"><h1>Request history</h1><p>Real requests and their last recorded outcome.</p>{data.missions.length?data.missions.map(m=><article key={m.id}><strong>{m.title}</strong><span>{readable(m.state)}</span><button className="secondary" disabled={!!busy} onClick={async()=>{if(await request(`/api/missions/${m.id}/select`,{})){selectMission(m.id);setMissionPending(false);setCompose(false);setPage('mission');}}}>Open request<ArrowRight size={16}/></button></article>):<p>No requests yet.</p>}</section>:page==='activity'?mission?<ExecutionConsole mission={mission}/>:<section className="empty-workspace"><h1>No investigation is running</h1><p>Start an investigation to see MOVA’s decisions, tool calls, graph paths, and verification here.</p><button className="primary" onClick={()=>setPage('mission')}>Start investigation<ArrowRight size={17}/></button></section>:page==='comparison'?mission?<FalkorComparison mission={mission}/>:<section className="empty-workspace"><h1>No active mission to compare</h1><p>Start an investigation to inspect its live FalkorDB graph and counterfactual linear execution.</p><button className="primary" onClick={()=>setPage('mission')}>Start investigation<ArrowRight size={17}/></button></section>:<>
        {missionPending?<div className="agent-pending-enter"><section className="agent-update" aria-live="polite"><Avatar state="thinking" size={84}/><div><strong>Starting investigation</strong><p>Your request is being registered. Progress will appear here as soon as the mission is available.</p></div></section><Execution pending/></div>:null}
        {!missionPending?<div className={mission?'agent-investigation-enter':''}>
        {compose||!mission?<section className="composer-section">{!mission&&<div className="welcome-copy"><img className="welcome-puppy" src="/images/mova-sleeping-transparent.png" alt="MOVA's sleeping puppy" width={160} height={160}/><div><p className="hook-line">Agents that act on connected data</p><h1>What should <span className="welcome-mova">MOVA</span> investigate?</h1><p>Give MOVA a decision to verify. It follows relationships across connected sources, explains the evidence path, and asks before taking an external action.</p></div></div>}{composer}</section>:null}
        {!mission?<section className="setup-empty"><Plug size={24}/><div><h2>Start with the right connections</h2><p>Connect web, GitHub, Slack, Discord, calendar, and weather. MOVA will show what it needs before it acts.</p></div><button className="secondary" onClick={()=>setPage('connections')}>Check connections<ChevronRight size={17}/></button></section>:<>
          <section className="outcome-heading"><div><h1>{missionHeading(mission)}</h1><p>{mission.successCriteria}</p></div><span className={`state-badge state-${mission.state.toLowerCase()}`}>{mission.state==='RESOLVED'?<CheckCircle2 size={16}/>:<Activity size={16}/>} {readable(mission.state)}</span></section>
          <section className="agent-update" aria-live="polite"><Avatar state={mission.agentStatus} size={84}/><div><strong>{activeStates.includes(mission.state)?'MOVA is working':missionNeedsAttention?mission.inputRequest?'MOVA needs your input':'Investigation needs attention':mission.state==='RESOLVED'?'Result verified':'MOVA’s latest update'}</strong><p>{mission.summary}</p></div><button className="icon-button" onClick={speak} disabled={voice} title="Read update aloud" aria-label="Read update aloud">{voice?<LoaderCircle size={19} className="spin"/>:<Volume2 size={19}/>}</button></section>
          {work&&mission.state==='BLOCKED'&&mission.inputRequest?<section className="attention-request" aria-labelledby="attention-title"><CircleAlert size={24}/><div><p className="attention-kicker">Attention required</p><h2 id="attention-title">{mission.inputRequest.question}</h2><p><b>Why MOVA stopped:</b> {mission.inputRequest.reason||mission.summary}</p>{mission.inputRequest.options.length?<div className="attention-options">{mission.inputRequest.options.map(option=><button key={option} className="secondary" disabled={!!busy} onClick={()=>{setInputText(option);setNeedsInput(true);}}>{option}</button>)}</div>:null}</div><button className="primary" disabled={!!busy} onClick={()=>setNeedsInput(true)}>Answer MOVA<ArrowRight size={16}/></button></section>:null}
          <Execution mission={mission}/>
          {travel&&<div className="journey-context"><span><MapPin size={16}/>{mission.origin?.label||mission.origin?.name||'Waiting for your position'}</span><ArrowRight size={15}/><span>{mission.destination?.label||mission.destination?.name||'Finding destination'}</span><span className="deadline"><Clock3 size={16}/>Arrive before {at(new Date(new Date(mission.deadline).getTime()-Number(mission.constraints.bufferMinutes||0)*60000).toISOString())}</span></div>}
          <div className={`outcome-grid ${travel?'':work?'work-outcome':'read-outcome'}`}>
            <section className="journey-panel">{travel?<><div className="section-heading"><div><h2>Your route</h2><p>Traffic-aware estimates and directions, here in MOVA.</p></div><Navigation size={21}/></div><MissionMap mission={mission} selectedPlan={selected||mission.selectedPlanId} onSelect={setSelected} onLocate={locate} mapsProvider={data.config.mapsProvider} tileUrl={data.config.tileUrl} trackingPosition={position}/>
              <div className="route-options" aria-label="Available routes">{mission.plans.map(plan=><button key={plan.id} className={`route-option ${plan.id===(selected||mission.selectedPlanId)?'selected':''}`} onClick={()=>setSelected(plan.id)} aria-pressed={plan.id===(selected||mission.selectedPlanId)}><span className="route-selector">{plan.id===(selected||mission.selectedPlanId)&&<Check size={13}/>}</span><span><strong>{plan.name}</strong><small>{plan.feasible?`${plan.slackMinutes} min spare`:plan.reason}{plan.trafficDelaySeconds!=null?` · ${Math.ceil(plan.trafficDelaySeconds/60)} min traffic delay`:''}</small></span><b>{plan.durationMinutes}<small>min</small></b></button>)}</div>
              <div className="map-monitor"><span>{data.tracking?.error||position?`Phone: ${data.tracking?.error||'fresh location received'}`:'Phone location not received yet'}</span><button onClick={()=>setPage('connections')}>Tracking setup</button><button onClick={()=>{if(mission)void request(`/api/missions/${mission.id}/observe`,{});}} disabled={!!busy}><RefreshCw size={14}/>Refresh routes</button><button onClick={()=>setMonitoring(v=>!v)}>{monitoring?'Pause route checks':'Resume route checks'}</button></div>
            </>:work?<WorkWorkspace mission={mission} busy={!!busy} onUpdate={text=>request(`/api/missions/${mission.id}/context`,{text})} onResolveAction={(proposalId,outcome)=>request(`/api/missions/${mission.id}/proposals/${proposalId}`,{revision:mission.revision,outcome})}/>:<Result mission={mission}/>}</section>
            <section className="reason-panel"><div className="section-heading"><div><h2>FalkorDB decision graph</h2><p>Live evidence paths and dependencies for this mission.</p></div><button className="secondary" title="Open live FalkorDB connected-data graph" aria-label="Open live FalkorDB connected-data graph" onClick={()=>setExpanded(true)}><Database size={16}/>Open live graph</button></div><Bubble mission={mission} selectedPlan={selected||mission.selectedPlanId} onInspect={setInspected}/></section>
          </div>
          <section className="next-action"><ShieldCheck size={24}/><div><h2>{travel&&mission.state==='AWAITING_APPROVAL'?'Ready to start route guidance':travel&&mission.state==='VERIFYING'?'Guidance is open. Checking the outcome.':missionNeedsAttention?mission.inputRequest?'MOVA needs your input':'Investigation needs attention':mission.state==='RESOLVED'?'Outcome checked against evidence':work?'Your next step':'Working toward your outcome'}</h2><p>{travel&&mission.state==='AWAITING_APPROVAL'?`MOVA selected ${mission.plans.find(p=>p.id===mission.selectedPlanId)?.name||'a route'}. Directions will open in this page. Arrival still needs fresh location evidence.`:travel&&mission.state==='VERIFYING'?'Keep phone tracking enabled. Opening directions does not mean you have arrived.':mission.summary}</p></div><div>{travel&&mission.state==='AWAITING_APPROVAL'?<button className="primary" disabled={!!busy} onClick={()=>request(`/api/missions/${mission.id}/approve`,{revision:mission.revision})}><Navigation size={17}/>Start guidance</button>:work&&mission.state==='BLOCKED'&&mission.inputRequest?<button className="primary" disabled={!!busy} onClick={()=>setNeedsInput(true)}>Give MOVA input</button>:['FAILED_RETRYABLE','UNKNOWN'].includes(mission.state)?<button className="secondary" disabled={!!busy} onClick={()=>request(`/api/missions/${mission.id}/resume`,{})}><RefreshCw size={17}/>Check again</button>:null}</div></section>
          <ActivityTrace mission={mission}/>
          {mission.receipts.length>0&&<section className="receipt-section"><h2>Action receipts</h2>{mission.receipts.map(r=><details key={r.id}><summary><ShieldCheck size={17}/><strong>{r.tool.replaceAll('_',' ')}</strong><span>{readable(r.status)}</span><time>{at(r.at)}</time></summary><p>{r.summary}</p>{r.verification&&<pre>{typeof r.verification==='string'?r.verification:JSON.stringify(r.verification,null,2)}</pre>}</details>)}</section>}
        </>}
        </div>:null}
      </>}
      <footer className="workspace-footer"><Database size={14}/>Connected evidence in FalkorDB<span>Source → decision → action → verification</span></footer>
    </main>
    <dialog ref={dialog} className="evidence-dialog" onCancel={()=>{setInspected(null);setExpanded(false);}}><button className="dialog-close icon-button" aria-label="Close details" onClick={()=>{setInspected(null);setExpanded(false);}}><X size={21}/></button>{inspected?<Inspector item={inspected}/>:expanded&&mission?<><h2>Live FalkorDB connected-data graph</h2><p>These are persisted nodes and exact relationships from this mission. Select a node or relation to inspect its evidence.</p><Bubble mission={mission} selectedPlan={selected||mission.selectedPlanId} onInspect={setInspected} expanded/></>:null}</dialog>
    <dialog ref={inputDialog} className="agent-input-dialog" onCancel={()=>setNeedsInput(false)}>{mission&&<><button className="dialog-close icon-button" aria-label="Close MOVA input request" onClick={()=>setNeedsInput(false)}><X size={19}/></button><div className="action-agent-message"><Avatar state="thinking" size={46}/><div><strong>MOVA asks</strong><p>{inputPrompt.question}</p></div></div><h2>Give MOVA the missing decision</h2>{inputPrompt.reason&&<p className="input-blocker"><b>Blocked because:</b> {inputPrompt.reason}</p>}{inputPrompt.options.length>0&&<div className="input-suggestions">{inputPrompt.options.map(option=><button key={option} type="button" onClick={()=>setInputText(option)}>{option}</button>)}</div>}<form onSubmit={async event=>{event.preventDefault();if(!inputText.trim()||!mission)return;const answer=inputText.trim();setInputText('');setNeedsInput(false);await request(`/api/missions/${mission.id}/context`,{text:answer});}}><label htmlFor="agent-input">Your instruction or missing context</label><textarea id="agent-input" name="agent-input" autoComplete="off" value={inputText} onChange={event=>setInputText(event.target.value)} maxLength={2000} placeholder={inputPrompt.placeholder||inputPrompt.question} required/><button className="primary" disabled={!!busy||!inputText.trim()}>Continue investigation<ArrowRight size={16}/></button></form></>}</dialog>
  </div>;
}
function Execution({mission,pending=false}:{mission?:Mission;pending?:boolean}){
  const groups=['Understand','Gather context','Choose a plan','Take action','Verify'];
  const state=mission?.state||'MISSION_CREATED';
  const understood=mission?.trace.some(trace=>trace.kind==='agent'&&trace.title==='Mission understood')||false;
  const stageForState=(state:string)=>{
    if(['DETECTED','MISSION_CREATED'].includes(state))return 0;
    if(state==='INVESTIGATING')return understood?1:0;
    if(state==='BUILDING_CONTEXT')return 1;
    if(['PLANNING','POLICY_CHECK','REPLANNING'].includes(state))return 2;
    if(['AWAITING_APPROVAL','EXECUTING'].includes(state))return 3;
    if(state==='VERIFYING')return 4;
    if(state==='RESOLVED')return 5;
    return -1;
  };
  const stateEvents=mission?.trace.filter(trace=>trace.kind==='state').map(trace=>trace.title.replaceAll(' ','_'))||[];
  const terminalIssue=['BLOCKED','FAILED_RETRYABLE','UNKNOWN'].includes(state);
  const previousStages=stateEvents.map(stageForState).filter(index=>index>=0);
  const index=mission?.state==='RESOLVED'?5:terminalIssue?Math.max(0,...previousStages):Math.max(stageForState(state),...previousStages);
  const waiting=state==='AWAITING_APPROVAL';
  const status=pending?'Starting':waiting?'Awaiting approval':terminalIssue?readable(state):activeStates.includes(state)?'Running':readable(state);
  return <section className="execution-panel" aria-label="Live execution"><div className="execution-heading"><span><Activity size={17}/>Live execution</span><span>{status}</span></div><ol>{groups.map((label,i)=>{const done=state==='RESOLVED'||i<index;const blocked=terminalIssue&&i===index;const isWaiting=waiting&&i===index;const active=i===index&&!blocked&&!isWaiting&&state!=='RESOLVED';const className=blocked?'blocked':isWaiting?'waiting':active?'current':done?'done':'';return <li key={label} className={className} aria-label={`${label}: ${blocked?'needs attention':isWaiting?'awaiting approval':done?'complete':active?'in progress':'not started'}`}><span>{done?<Check size={14}/>:active?<span className="execution-pulse"/>:i+1}</span><strong>{label}</strong></li>;})}</ol></section>;
}
function Inspector({item}:{item:GraphNode|GraphEdge}){
  const edge='target'in item;
  return <><h2>{item.label.replaceAll('_',' ')}</h2><p>{edge?item.explanation:'This entity is part of the evidence used for the current request.'}</p><dl className="evidence-fields"><div><dt>Evidence type</dt><dd>{readable(item.evidenceKind||'unknown')}</dd></div><div><dt>Source</dt><dd>{edge?item.provenance:item.source}</dd></div><div><dt>Observed</dt><dd>{item.observedAt?new Date(item.observedAt).toLocaleString():'Unknown timestamp'}</dd></div><div><dt>State</dt><dd>{readable(item.status||'unknown')}</dd></div>{edge?<div><dt>Connection</dt><dd>{item.source} → {item.target}</dd></div>:null}</dl>{!edge&&<details><summary>Properties used by the agent</summary><pre>{JSON.stringify(item.properties,null,2)}</pre></details>}</>;
}
function Result({mission}:{mission:Mission}){
  const result=mission.result;
  const heading=result?(mission.kind==='weather'?'Weather result':mission.kind==='calendar_read'?'Your calendar':'Request result'):['BLOCKED','FAILED_RETRYABLE','UNKNOWN'].includes(mission.state)?'Investigation needs attention':'Investigation in progress';
  return <div className="read-result"><h2>{heading}</h2>{!result?<p>{mission.summary}</p>:<><p className="result-source">{String(result.source||'Connected tool')} · {result.observedAt?new Date(result.observedAt).toLocaleString():''}</p>{mission.kind==='calendar_read'?<div>{Array.isArray(result.events)&&result.events.length?result.events.map((e:any,i:number)=><article key={e.id||i}><strong>{e.summary||'Untitled event'}</strong><p>{e.start?.dateTime||e.start?.date||'Time unavailable'}{e.location?` · ${e.location}`:''}</p></article>):<p>No events returned for the requested period.</p>}</div>:mission.kind==='weather'&&result.current?<dl>{Object.entries(result.current).map(([key,value])=><div key={key}><dt>{key.replaceAll('_',' ')}</dt><dd>{String(value)} {result.current_units?.[key]||''}</dd></div>)}</dl>:<p>{mission.summary}</p>}<details><summary>Inspect source response</summary><pre>{JSON.stringify(result,null,2)}</pre></details></>}</div>;
}
