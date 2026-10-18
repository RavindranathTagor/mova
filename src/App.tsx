import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Check, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, Clock3, Compass, Database, GitBranch, History, LoaderCircle, LocateFixed, MapPin, Maximize2, Mic, Navigation, PawPrint, Plug, Plus, RefreshCw, ShieldCheck, Volume2, X } from 'lucide-react';
import { startTransition } from 'react';
import Avatar from './components/Avatar';
import Bubble from './components/Bubble';
import MissionMap from './components/MissionMap';
import NearbyMap from './components/NearbyMap';
import WorkWorkspace from './components/WorkWorkspace';
import ActivityTrace from './components/ActivityTrace';
import ExecutionConsole from './components/ExecutionConsole';
import FalkorComparison from './components/FalkorComparison';
import { Connections } from './components/Connections';
import Workflows,{WorkflowPicker,type Workflow} from './components/Workflows';
import { isNearbyPlaceRequest, locationErrorMessage, locationRequiredForRequest, readBrowserLocation } from './location.mjs';
import { mergeEnvelope, newDiscordMissionId } from './envelope.mjs';
import { alternativeSourceInstruction, attentionEventKey, contextPayload, isInvalidWorkArgumentsError, missingIssueInputRequest, readAttentionDrafts, resumeRequest, workFailureDetail } from './attention.mjs';
import { claimOnce, investigationStatus, restoreMissionId } from './ui-state.mjs';
import './thinking.css';
import type { Envelope, GraphNode, GraphEdge, Mission, WorkProposal } from './types';

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
type Location={latitude:number;longitude:number;accuracy:number|null;timestamp:number;label?:string;source?:string;evidenceKind?:string};
type Page='mission'|'connections'|'activity'|'comparison'|'history'|'workflows';
type PersistedUi={selectedMissionId?:string;freshRequest?:boolean;draft?:string;workflowId?:string;sidebarCollapsed?:boolean;attentionDrafts?:Record<string,string>};
function readPersistedUi():PersistedUi{
  try{const value=JSON.parse(localStorage.getItem('mova:ui:v1')||'{}');if(!value||typeof value!=='object')return {};const attentionDrafts=readAttentionDrafts(value.attentionDrafts);return {selectedMissionId:typeof value.selectedMissionId==='string'?value.selectedMissionId:undefined,freshRequest:value.freshRequest===true,draft:typeof value.draft==='string'?value.draft.slice(0,2000):undefined,workflowId:typeof value.workflowId==='string'?value.workflowId:undefined,sidebarCollapsed:typeof value.sidebarCollapsed==='boolean'?value.sidebarCollapsed:undefined,attentionDrafts};}catch{return {};}
}
const missionHeading=(mission:Mission)=>mission.kind==='weather'&&mission.intent?.destinationQuery
  ?`Get current weather information for ${mission.intent.destinationQuery}`
  :mission.title;
function ThinkingIndicator({label,active}:{label:string;active:boolean}){
  return <span className={`thinking-indicator${active?' is-active':''}`} role="status" aria-live="polite"><span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span><span>{label}</span></span>;
}
export default function App(){
  const [savedUi]=useState(readPersistedUi);
  const [data,setData]=useState<Envelope>(empty);
  const envelopeRef=useRef<Envelope>(empty);
  const initialStateLoaded=useRef(false);
  const [page,setPage]=useState<Page>('mission');
  const [connected,setConnected]=useState(false);
  const [eventStreamError,setEventStreamError]=useState('');
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [selectedMissionId,setSelectedMissionId]=useState<string|undefined>(savedUi.freshRequest?undefined:savedUi.selectedMissionId);
  const selectedMissionIdRef=useRef<string|undefined>(savedUi.freshRequest?undefined:savedUi.selectedMissionId);
  const selectionEpoch=useRef(0);
  const [missionPending,setMissionPending]=useState(false);
  const [restoring,setRestoring]=useState(true);
  const [pendingRequestText,setPendingRequestText]=useState('');
  const pendingRequestRef=useRef('');
  const [sidebarCollapsed,setSidebarCollapsed]=useState(Boolean(savedUi.sidebarCollapsed));
  const [compose,setCompose]=useState(savedUi.freshRequest===true);
  const [freshRequest,setFreshRequest]=useState(savedUi.freshRequest===true);
  const [text,setText]=useState('');
  const [workflowId,setWorkflowId]=useState(savedUi.workflowId||'');
  function useWorkflow(workflow:Workflow){setWorkflowId(workflow.id);setText('');setCompose(true);selectMission(undefined);setPage('mission');}
  const [deadline,setDeadline]=useState('');
  const [location,setLocation]=useState<Location>();
  const [manualLocationQuery,setManualLocationQuery]=useState('');
  const [manualLocationCandidates,setManualLocationCandidates]=useState<{id:string;label:string;address:string}[]>([]);
  const [needsManualLocation,setNeedsManualLocation]=useState(false);
  const [selected,setSelected]=useState<string>();
  const [inspected,setInspected]=useState<GraphNode|GraphEdge|null>(null);
  const [expanded,setExpanded]=useState(false);
  const [voice,setVoice]=useState(false);
  const [monitoring,setMonitoring]=useState(true);
  const [needsInput,setNeedsInput]=useState(false);
  const [inputText,setInputText]=useState('');
  const [attentionDrafts,setAttentionDrafts]=useState<Record<string,string>>(savedUi.attentionDrafts||{});
  const [attentionMission,setAttentionMission]=useState<Mission|null>(null);
  const [showBlockedRecovery,setShowBlockedRecovery]=useState(false);
  const [recoveryAttemptedKey,setRecoveryAttemptedKey]=useState('');
  const [recoveryError,setRecoveryError]=useState('');
  const [recoveryContext,setRecoveryContext]=useState('');
  const [selectedProposal,setSelectedProposal]=useState<WorkProposal>();
  const shownClarifications=useRef(new Set<string>());
  const shownRecoveries=useRef(new Set<string>());
  const shownProposals=useRef(new Set<string>());
  const creatingMission=useRef(false);
  const streamEnvelope=useRef<Envelope|null>(null);
  const streamFrame=useRef<number|null>(null);
  const dialog=useRef<HTMLDialogElement>(null);
  const inputDialog=useRef<HTMLDialogElement>(null);
  const actionDialog=useRef<HTMLDialogElement>(null);
  const recoveryDialog=useRef<HTMLDialogElement>(null);
  const mission=selectedMissionId&&data.mission?.id===selectedMissionId&&data.mission.mode==='live'?data.mission:null;
  const sidebarMascotState=missionPending?'detected':restoring?'thinking':mission?.agentStatus||'restful';
  const popupMission=selectedMissionId&&attentionMission?.id===selectedMissionId?attentionMission:mission;
  const bannerMission=popupMission?.id===selectedMissionId?popupMission:null;
  const bannerInput=bannerMission?.inputRequest||missingIssueInputRequest(bannerMission);
  const bannerProposals=bannerMission?.work?.proposals?.filter(item=>item.status==='PENDING_APPROVAL')||[];
  const travel=mission?.kind==='travel';
  const work=mission?.kind==='work';
  const missionNeedsAttention=['BLOCKED','FAILED_RETRYABLE','UNKNOWN'].includes(mission?.state||'');
  const popupInput=popupMission?.inputRequest||missingIssueInputRequest(popupMission);
  const inputPrompt=popupInput||{question:'MOVA has not provided a clarification question yet.',options:[] as string[]};
  const clarificationKey=popupInput?.question&&popupMission?attentionEventKey({...popupMission,inputRequest:popupInput},'clarification'):'';
  const pendingProposals=popupMission?.work?.proposals?.filter(item=>item.status==='PENDING_APPROVAL')||[];
  const blockedWithoutPrompt=popupMission?.kind==='work'&&popupMission.state==='BLOCKED'&&!popupInput?.question&&!pendingProposals.length;
  const blockedEventKey=popupMission?attentionEventKey(popupMission,'blocked'):'';
  const invalidPlanArguments=blockedWithoutPrompt&&isInvalidWorkArgumentsError(popupMission?.summary);
  const failedReadStep=popupMission?.work?.steps.find(step=>step.status==='failed'&&step.tool==='read_web_page');
  const failedReadUrl=typeof failedReadStep?.args?.url==='string'?failedReadStep.args.url:'';
  const recoverySuggestion=popupMission?alternativeSourceInstruction(popupMission):'Revise the plan to use a different evidence source. If the requested source is unavailable, finish with the verified evidence and clearly state the remaining evidence gap.';
  const proposalTitle=(proposal:WorkProposal)=>proposal.operation==='create_issue'?`Create GitHub issue: ${proposal.title||'Untitled issue'}`:proposal.operation==='create_commit'?`Commit ${proposal.files?.length||0} file${proposal.files?.length===1?'':'s'} to ${proposal.repository} · ${proposal.branch}`:proposal.operation==='comment_on_pull_request'?`Comment on ${proposal.repository} #${proposal.pullNumber}`:proposal.operation==='comment_on_issue'?`Comment on ${proposal.repository} #${proposal.issueNumber}`:`Post this message to ${proposal.service}?`;
  const proposalBody=(proposal:WorkProposal)=>proposal.operation==='create_commit'?`${proposal.message||'Untitled commit'}\n\n${(proposal.files||[]).map(file=>`FILE: ${file.path}\n${file.content}`).join('\n\n')}`:proposal.body||proposal.text||'';
  const position=data.tracking?.enabled&&!data.tracking?.error?data.tracking?.position:null;
  const liveStatus=investigationStatus(mission,missionPending);
  const latestCompletedStep=mission?.work?.steps.slice().reverse().find(step=>step.status==='completed');
  function updateAttention(incoming:Mission|null|undefined){
    if(!incoming)return;
    if(incoming.id!==selectedMissionIdRef.current)return;
    const pending=incoming.work?.proposals?.some(item=>item.status==='PENDING_APPROVAL');
    if(incoming.inputRequest?.question||pending||incoming.kind==='work'&&incoming.state==='BLOCKED')setAttentionMission(incoming);
    else setAttentionMission(current=>current?.id===incoming.id?incoming:current);
  }
  function claimPopup(key:string,shown:Set<string>){
    try{return claimOnce(key,shown,localStorage);}catch{return claimOnce(key,shown);}
  }
  function receiveState(incoming:Envelope){
    const incomingMission=incoming.mission;
    const newMentionId=initialStateLoaded.current?newDiscordMissionId(envelopeRef.current,incoming):undefined;
    if(newMentionId){
      selectMission(newMentionId);
      setFreshRequest(false);setCompose(false);setText('');
    }
    const pendingQuestion=pendingRequestRef.current;
    if(pendingQuestion&&!selectedMissionIdRef.current&&incomingMission&&(
      incomingMission.goal===pendingQuestion||incomingMission.trigger?.content===pendingQuestion||incomingMission.title===pendingQuestion.slice(0,80)
    )){
      selectMission(incomingMission.id,true);setMissionPending(false);setPendingRequestText('');pendingRequestRef.current='';
    }
    const accepted=mergeEnvelope(envelopeRef.current,incoming,selectedMissionIdRef.current);
    envelopeRef.current=accepted;
    updateAttention(accepted.mission);
    setData(accepted);
  }
  useEffect(()=>{
    const controller=new AbortController();
    const restorationEpoch=selectionEpoch.current;
    fetch('/api/state',{signal:controller.signal}).then(async r=>{const result=await responseBody(r);if(!r.ok)throw new Error(String(result.error||'The agent server is unavailable. Start the backend and reconnect.'));return result as Envelope;}).then(async initial=>{
      if(controller.signal.aborted||selectionEpoch.current!==restorationEpoch)return;
      const savedId=restoreMissionId(initial,selectedMissionIdRef.current,freshRequest);
      if(savedId&&savedId!==initial.mission?.id&&initial.missions.some(item=>item.id===savedId)){
        const response=await fetch(`/api/missions/${savedId}/select`,{method:'POST',headers:{'Content-Type':'application/json','x-mova-client':'web'},body:'{}',signal:controller.signal});
        const result=await responseBody(response);if(!response.ok)throw new Error(String(result.error||'The saved investigation could not be restored.'));
        if(!controller.signal.aborted&&selectionEpoch.current===restorationEpoch){selectMission(savedId,true);setFreshRequest(false);setCompose(false);receiveState(result as Envelope);}
      }else if(savedId){selectMission(savedId,true);setFreshRequest(false);setCompose(false);receiveState(initial);}
      else{selectMission(undefined,true);setFreshRequest(true);setCompose(true);setText('');receiveState(initial);}
      initialStateLoaded.current=true;
      if(!controller.signal.aborted&&selectionEpoch.current===restorationEpoch)setRestoring(false);
    }).catch(e=>{if(!controller.signal.aborted){setError(e.message);setRestoring(false);}});
    const events=new EventSource('/api/events');
    events.addEventListener('state',event=>{
      let incoming:Envelope;try{incoming=JSON.parse((event as MessageEvent).data) as Envelope;}catch{return;}
      streamEnvelope.current=incoming;
      if(streamFrame.current===null)streamFrame.current=requestAnimationFrame(()=>{
        const latest=streamEnvelope.current;streamEnvelope.current=null;streamFrame.current=null;
        if(latest)startTransition(()=>receiveState(latest));
      });
      setConnected(true);
      setEventStreamError('');
    });
    events.onopen=()=>{setConnected(true);setEventStreamError('');};
    events.onerror=()=>{setConnected(false);setEventStreamError('Live updates are disconnected. MOVA will reconnect automatically; your saved investigation is unchanged.');};
    return()=>{controller.abort();events.close();if(streamFrame.current!==null)cancelAnimationFrame(streamFrame.current);};
  },[]);
  useEffect(()=>{try{localStorage.setItem('mova:ui:v1',JSON.stringify({selectedMissionId,freshRequest,draft:text,workflowId,sidebarCollapsed,attentionDrafts} satisfies PersistedUi));}catch{}},[selectedMissionId,freshRequest,text,workflowId,sidebarCollapsed,attentionDrafts]);
  useEffect(()=>{if(clarificationKey)setInputText(attentionDrafts[clarificationKey]||'');},[clarificationKey]);
  useEffect(()=>{setSelected(mission?.selectedPlanId);setInspected(null);},[mission?.id,mission?.selectedPlanId,mission?.revision]);
  useEffect(()=>{
    if(!travel||!mission||!monitoring||!['AWAITING_APPROVAL','VERIFYING','BLOCKED'].includes(mission.state))return;
    const timer=setInterval(()=>{if(document.visibilityState==='visible')void request(`/api/missions/${mission.id}/observe`,{},false);},60000);
    return()=>clearInterval(timer);
  },[mission?.id,mission?.state,travel,monitoring]);
  useEffect(()=>{if(inspected||expanded){dialog.current?.showModal();}else dialog.current?.close();},[inspected,expanded]);
  useEffect(()=>{
    if(popupMission?.kind!=='work'||popupMission.state!=='BLOCKED'||!popupInput?.question)return;
    if(claimPopup(`mova:clarification-shown:${clarificationKey}`,shownClarifications.current))setNeedsInput(true);
  },[popupMission?.id,popupMission?.state,popupMission?.revision,popupInput?.id,popupInput?.question,popupMission?.work?.steps]);
  useEffect(()=>{
    if(!blockedWithoutPrompt||!popupMission)return;
    const key=`mova:blocked-recovery-shown:${attentionEventKey(popupMission,'blocked')}`;
    if(claimPopup(key,shownRecoveries.current))setShowBlockedRecovery(true);
  },[blockedWithoutPrompt,popupMission?.id,popupMission?.summary,popupMission?.work?.steps]);
  useEffect(()=>{
    if(selectedProposal)return;
    const next=pendingProposals.find(proposal=>!shownProposals.current.has(proposal.id));
    if(next&&claimPopup(`mova:proposal-shown:${next.id}`,shownProposals.current))setSelectedProposal(next);
  },[pendingProposals,selectedProposal]);
  useEffect(()=>{
    if(!selectedProposal)return;
    const latest=pendingProposals.find(proposal=>proposal.id===selectedProposal.id);
    if(!latest)setSelectedProposal(undefined);
    else if(latest!==selectedProposal)setSelectedProposal(latest);
  },[pendingProposals,selectedProposal]);
  useEffect(()=>{if(needsInput&&(!popupMission||!popupInput?.question||popupMission.state!=='BLOCKED'))setNeedsInput(false);},[needsInput,popupMission?.id,popupMission?.state,popupInput?.question]);
  useEffect(()=>{if(needsInput)inputDialog.current?.showModal();else inputDialog.current?.close();},[needsInput]);
  useEffect(()=>{if(showBlockedRecovery&&blockedWithoutPrompt)recoveryDialog.current?.showModal();else recoveryDialog.current?.close();},[showBlockedRecovery,blockedWithoutPrompt]);
  useEffect(()=>{if(selectedProposal)actionDialog.current?.showModal();else actionDialog.current?.close();},[selectedProposal]);
  function selectMission(id?:string,preserveEpoch=false){if(!preserveEpoch){selectionEpoch.current++;setRestoring(false);setMissionPending(false);setPendingRequestText('');pendingRequestRef.current='';}selectedMissionIdRef.current=id;setSelectedMissionId(id);setAttentionMission(current=>current?.id===id?current:null);setSelectedProposal(undefined);setNeedsInput(false);setShowBlockedRecovery(false);setRecoveryContext('');setRecoveryError('');setRecoveryAttemptedKey('');}
  function startNewRequest(){selectMission(undefined);setFreshRequest(true);setText('');setWorkflowId('');setCompose(true);setPage('mission');}
  function showAgent(){if(missionPending){setPage('mission');return;}const selected=data.missions.find(item=>item.id===selectedMissionIdRef.current);const active=data.missions.find(item=>activeStates.includes(item.state));const target=selected&&active&&selected.id===active.id?selected.id:active?.id||selected?.id||data.mission?.id;if(target){selectMission(target);setFreshRequest(false);setCompose(false);}else{setFreshRequest(true);setCompose(true);}setPage('mission');}
  const foregroundRequest=useRef(0);
  const resumeInFlight=useRef(new Set<string>());
  async function resumeExisting(missionId:string){
    const action=resumeRequest(missionId);
    if(!action||resumeInFlight.current.has(missionId))return null;
    resumeInFlight.current.add(missionId);
    try{return await request(action.path,action.body);}
    finally{resumeInFlight.current.delete(missionId);}
  }
  async function reviseBlockedPlan(instruction:string){
    if(!popupMission)return;
    const payload=contextPayload(instruction);
    if(!payload)return;
    const result=await request(`/api/missions/${popupMission.id}/context`,payload);
    if(!result)return;
    const latest=(result as {mission?:Mission}).mission;
    setRecoveryContext('');
    setRecoveryAttemptedKey('');
    if(latest&&!['BLOCKED','FAILED_RETRYABLE','UNKNOWN'].includes(latest.state)){setShowBlockedRecovery(false);setRecoveryError('');}
    else setRecoveryError(latest?.summary||'MOVA revised the plan but remains blocked. Review the updated evidence and failure details.');
  }
  async function request(path:string,body:unknown,foreground=true){
    const requestId=foreground?++foregroundRequest.current:0;
    if(foreground){setBusy(path);setError('');}
    try{
      const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','x-mova-client':'web'},body:JSON.stringify(body)});
      const result=await responseBody(response);
      if(!response.ok)throw new Error(String(result.error||'The request could not complete.'));
      if('mission'in result)receiveState(result as Envelope);
      return result;
    }catch(e){const missionId=path.match(/^\/api\/missions\/([^/]+)/)?.[1];if(!missionId||selectedMissionIdRef.current===missionId)setError((e as Error).message);return null;}finally{if(foreground&&foregroundRequest.current===requestId)setBusy('');}
  }
  async function locate(){
    setNotice('Waiting for a fresh location from this device…');
    try{const value=await readBrowserLocation(navigator.geolocation);const saved=await request('/api/location',value);if(!saved){setNotice('');return;}setLocation(value);setNotice(value.accuracy==null?'Location received.':`Location received, accuracy ±${Math.round(value.accuracy)} m.`);}
    catch(e){setNotice('');setError(locationErrorMessage(e as {code?:string|number}));setNeedsManualLocation(true);}
  }
  async function createMissionAt(requestText:string,origin=location){
    if(!requestText.trim()||creatingMission.current)return;
    creatingMission.current=true;const requestEpoch=++selectionEpoch.current;selectMission(undefined,true);setFreshRequest(false);setRestoring(false);pendingRequestRef.current=requestText.trim();setPendingRequestText(requestText.trim());setMissionPending(true);setCompose(false);setPage('mission');setNotice('');setError('');
    const result=await request('/api/missions',{text:requestText.trim(),...(workflowId?{workflowId}:{}),mode:'live',...(deadline?{deadlineMinutes:Number(deadline)}:{}),...(origin?{origin}:{})});
    if(selectionEpoch.current===requestEpoch){
      if(result?.mission?.id){selectMission(result.mission.id,true);setMissionPending(false);setPendingRequestText('');pendingRequestRef.current='';setText('');}
      else{setMissionPending(false);setPendingRequestText('');pendingRequestRef.current='';setFreshRequest(true);setCompose(true);}
    }
    creatingMission.current=false;
  }
  async function start(e:React.FormEvent){
    e.preventDefault();if(!text.trim()||creatingMission.current)return;
    const requestText=text.trim();
    if(locationRequiredForRequest(requestText)&&(!location||isNearbyPlaceRequest(requestText)&&location.evidenceKind!=='user-provided')){
      setBusy('location');
      setNotice('Allow location access to search nearby places. If permission is denied, enter a city below.');
      try{
        const value=await readBrowserLocation(navigator.geolocation);
        setLocation(value);setBusy('');
        const saved=await request('/api/location',value);
        if(!saved){setNeedsManualLocation(true);setNotice('');return;}
        setNeedsManualLocation(false);
        await createMissionAt(requestText,value);return;
      }catch(error){setBusy('');setNotice('');setError(locationErrorMessage(error as {code?:string|number}));setNeedsManualLocation(true);return;}
      finally{setBusy(current=>current==='location'?'':current);}
    }
    await createMissionAt(requestText,location);
  }
  async function useManualLocation(placeId?:string){
    if(!manualLocationQuery.trim())return;
    const result=await request('/api/location/manual',{query:manualLocationQuery.trim(),...(placeId?{placeId}:{})});
    if(!result)return;
    const point=result.location as Location|null|undefined;
    if(point){setLocation(point);setNeedsManualLocation(false);setManualLocationCandidates([]);await createMissionAt(text,point);return;}
    setManualLocationCandidates(Array.isArray(result.candidates)?result.candidates as {id:string;label:string;address:string}[]:[]);
    if(Array.isArray(result.candidates)&&result.candidates.length)setNotice(String(result.message||'Select the matching location.'));
    if(!Array.isArray(result.candidates)||!result.candidates.length)setError(String(result.message||'No matching location was found. Try a more specific city or address.'));
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
    {needsManualLocation&&<div className="location-fallback"><MapPin size={18}/><div><strong>Enter a starting location</strong><p>Use a city, address, or landmark. MOVA will search places near that point.</p><div className="manual-location-entry"><input aria-label="City, address, or landmark" value={manualLocationQuery} onChange={e=>setManualLocationQuery(e.target.value)} placeholder="e.g. Koramangala, Bengaluru"/><button className="secondary" type="button" disabled={!!busy||!manualLocationQuery.trim()} onClick={()=>void useManualLocation()}>Use this location</button></div>{manualLocationCandidates.length>0&&<div className="manual-location-candidates" aria-label="Location matches">{manualLocationCandidates.map(candidate=><button type="button" className="secondary" key={candidate.id} onClick={()=>void useManualLocation(candidate.id)}><strong>{candidate.label}</strong>{candidate.address&&<small>{candidate.address}</small>}</button>)}</div>}</div></div>}{location&&<p className="quiet location-confirmation">Search location: {location.label||'current location'}{location.evidenceKind==='user-provided'?' (entered manually)':' (browser location)'}</p>}<div className="request-options"><button className="primary" disabled={!!busy||!text.trim()} type="submit">{busy?<LoaderCircle size={17} className="spin"/>:<ArrowRight size={17}/>}Start investigation</button></div>
    <div className="request-examples" aria-label="Request ideas"><button type="button" onClick={()=>setText('Inspect the public GitHub issues and recent approved community messages for this feature request. Determine whether it was previously rejected, explain why with sources, and propose a concise reply for my approval.')}>Trace a rejected idea</button><button type="button" onClick={()=>setText('Inspect this public pull request and related issues for duplicate work or a conflicting earlier decision. Produce evidence and propose a GitHub comment only if the conflict is clear.')}>Review a pull request</button><button type="button" onClick={()=>setText('Research an emerging issue across connected sources and save a source-linked decision brief with the next owner and the path of evidence.')}>Investigate connected context</button></div><p className="quiet">MOVA reads connected evidence, follows graph relationships, and asks before it posts or comments.</p>
  </form>;
  return <div className={`mova-app${sidebarCollapsed?' sidebar-collapsed':''}`}>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <aside className="app-nav"><div className="sidebar-top"><a className="brand" href="/" aria-label="MOVA home" onClick={event=>{event.preventDefault();showAgent();}}><PawPrint size={28}/><strong>MOVA</strong></a><button className="sidebar-toggle" type="button" aria-label={sidebarCollapsed?'Expand sidebar':'Collapse sidebar'} aria-expanded={!sidebarCollapsed} aria-controls="workspace-navigation" onClick={()=>setSidebarCollapsed(collapsed=>!collapsed)} title={sidebarCollapsed?'Expand sidebar':'Collapse sidebar'}>{sidebarCollapsed?<ChevronRight size={18}/>:<ChevronLeft size={18}/>}</button></div><p className="sidebar-tagline">Agents that act on connected data</p><nav id="workspace-navigation" aria-label="Workspace">
      {([['mission','Agent',Compass],['workflows','Workflows',GitBranch],['connections','Connections',Plug],['activity','Live execution',Activity],['comparison','Graph impact',GitBranch],['history','History',History]] as const).map(([id,label,Icon])=><button key={id} aria-label={label} title={sidebarCollapsed?label:undefined} aria-current={page===id?'page':undefined} onClick={()=>{if(id==='mission'){showAgent();return;}setPage(id);}}><Icon size={19}/><span className="nav-label">{label}</span></button>)}
    </nav><div className="nav-companion"><Avatar state={sidebarMascotState} size={94}/><p>Keep the outcome.<br/>Change the plan.</p></div><div className="server-status"><span className={connected?'status-dot online':'status-dot'}/><span className="server-status-label">{connected?'Agent connected':'Reconnecting…'}</span></div></aside>
    <main className="app-main" id="main-content" tabIndex={-1}>
      <header className="workspace-header"><div><span>MOVA workspace</span><strong>{page==='workflows'?'Workflows':page==='connections'?'Connections':page==='activity'?'Live execution':page==='comparison'?'FalkorDB graph impact':page==='history'?'Request history':'Your active investigation'}</strong></div><div className="header-actions"><span className="model-label">MOVA reasoning</span><button className="primary" disabled={missionPending} onClick={startNewRequest}><Plus size={17}/>New request</button></div></header>
      {eventStreamError?<div className="feedback error" role="alert"><span>{eventStreamError}</span></div>:null}
      {data.discordSync?.status==='unavailable'?<div className="feedback error" role="alert"><span>Discord synchronization is unavailable: {data.discordSync.detail} MOVA will retry automatically.</span></div>:null}
      {page==='mission'&&bannerMission?.kind==='work'&&(bannerMission.state==='BLOCKED'||bannerProposals.length>0)?<section className="attention-request" aria-labelledby="global-attention-title"><CircleAlert size={24}/><div><p className="attention-kicker">{bannerMission.state==='BLOCKED'?'Attention required':'Approval required'}</p><h2 id="global-attention-title">{bannerMission.state==='BLOCKED'?bannerInput?.question||bannerMission.summary:proposalTitle(bannerProposals[0])}</h2><p><b>{bannerMission.state==='BLOCKED'?'Why MOVA stopped:':'MOVA prepared this action:'}</b> {bannerMission.state==='BLOCKED'?bannerInput?.reason||bannerMission.summary:'Review it before anything is sent.'}</p>{bannerMission.state==='BLOCKED'&&isInvalidWorkArgumentsError(bannerMission.summary)?<p>MOVA will rebuild the artifact from this investigation’s verified findings when you resume. The saved evidence and completed work are preserved.</p>:null}{bannerMission.state==='BLOCKED'&&bannerInput?.options.length?<div className="attention-options">{bannerInput.options.map(option=><button key={option} className="secondary" disabled={!!busy} onClick={()=>{setInputText(option);setNeedsInput(true);}}>{option}</button>)}</div>:null}</div><button className="primary" disabled={!!busy} onClick={()=>bannerProposals.length?(shownProposals.current.add(bannerProposals[0].id),setSelectedProposal(bannerProposals[0])):bannerInput?setNeedsInput(true):setShowBlockedRecovery(true)}>{bannerProposals.length?'Review action':bannerInput?'Answer MOVA':'Resume investigation'}<ArrowRight size={16}/></button></section>:null}
      {eventStreamError?<div className="feedback error" role="alert"><span>{eventStreamError}</span></div>:null}
      {data.discordSync?.status==='unavailable'?<div className="feedback error" role="alert"><span>Discord synchronization is unavailable: {data.discordSync.detail} MOVA will retry automatically.</span></div>:null}
      {error&&<div className="feedback error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={()=>setError('')}><X size={17}/></button></div>}
      {notice&&<div className="feedback notice" role="status"><span>{notice}</span><button aria-label="Dismiss notice" onClick={()=>setNotice('')}><X size={17}/></button></div>}
      {page==='workflows'?<Workflows onUse={useWorkflow}/>:page==='connections'?<Connections/>:page==='history'?<section className="history-page"><h1>Request history</h1><p>Real requests and their last recorded outcome.</p>{data.missions.length?data.missions.map(m=><article key={m.id}><strong>{m.title}</strong><span>{readable(m.state)}</span><button className="secondary" onClick={async()=>{const result=await request(`/api/missions/${m.id}/select`,{});if(result){selectMission(m.id);receiveState(result as Envelope);setCompose(false);setPage('mission');}}}>Open request<ArrowRight size={16}/></button></article>):<p>No requests yet.</p>}</section>:page==='activity'?mission?<ExecutionConsole mission={mission}/>:<section className="empty-workspace"><h1>No investigation is running</h1><p>Start an investigation to see MOVA’s decisions, tool calls, graph paths, and verification here.</p><button className="primary" onClick={()=>setPage('mission')}>Start investigation<ArrowRight size={17}/></button></section>:page==='comparison'?mission?<FalkorComparison mission={mission}/>:<section className="empty-workspace"><h1>No active mission to compare</h1><p>Start an investigation to inspect its live FalkorDB graph and counterfactual linear execution.</p><button className="primary" onClick={()=>setPage('mission')}>Start investigation<ArrowRight size={17}/></button></section>:<>
        {restoring&&!mission?<div className="agent-pending-enter"><section className="agent-update" aria-live="polite"><Avatar state="thinking" size={84}/><div><strong>Restoring your workspace</strong><ThinkingIndicator label="Loading the latest saved investigation…" active/><p>The server is reconnecting your selected investigation. Its saved state will appear when it is available.</p></div></section></div>:null}
        {missionPending?<div className="agent-pending-enter"><section className="agent-update" aria-live="polite"><Avatar state="thinking" size={84}/><div><strong>Starting investigation</strong><ThinkingIndicator label={liveStatus.label} active={liveStatus.active}/><p className="submitted-question">{pendingRequestText}</p><p>Your request is being registered. Progress will appear here as soon as the mission is available.</p></div></section><Execution pending/></div>:null}
        {!missionPending&&!restoring?<div className={mission?'agent-investigation-enter':''}>
        {compose||!mission?<section className="composer-section">{!mission&&<div className="welcome-copy"><img className="welcome-puppy" src="/images/mova-sleeping-transparent.png" alt="MOVA's sleeping puppy" width={160} height={160}/><div><p className="hook-line">Agents that act on connected data</p><h1>What should <span className="welcome-mova">MOVA</span> investigate?</h1><p>Give MOVA a decision to verify. It follows relationships across connected sources, explains the evidence path, and asks before taking an external action.</p></div></div>}{composer}</section>:null}
        {!mission?<section className="setup-empty"><Plug size={24}/><div><h2>Start with the right connections</h2><p>Connect web, GitHub, Slack, Discord, calendar, and weather. MOVA will show what it needs before it acts.</p></div><button className="secondary" onClick={()=>setPage('connections')}>Check connections<ChevronRight size={17}/></button></section>:<>
          <section className="outcome-heading"><div><h1>{missionHeading(mission)}</h1><p>{mission.successCriteria}</p></div><span className={`state-badge state-${mission.state.toLowerCase()}`}>{mission.state==='RESOLVED'?<CheckCircle2 size={16}/>:<Activity size={16}/>} {readable(mission.state)}</span></section>
          <section className="agent-update" aria-live="polite"><Avatar state={mission.agentStatus} size={84}/><div><strong>{activeStates.includes(mission.state)?'MOVA is working':missionNeedsAttention?mission.inputRequest?'MOVA needs your input':'Investigation needs attention':mission.state==='RESOLVED'?'Result verified':'MOVA’s latest update'}</strong><ThinkingIndicator label={liveStatus.label} active={liveStatus.active}/><p>{mission.summary}</p>{latestCompletedStep&&<small className="latest-completed">Latest completed: {latestCompletedStep.title}</small>}</div><button className="icon-button" onClick={speak} disabled={voice} title="Read update aloud" aria-label="Read update aloud">{voice?<LoaderCircle size={19} className="spin"/>:<Volume2 size={19}/>}</button></section>
          <Execution mission={mission}/>
          {travel&&<div className="journey-context"><span><MapPin size={16}/>{mission.origin?.label||mission.origin?.name||'Waiting for your position'}</span><ArrowRight size={15}/><span>{mission.destination?.label||mission.destination?.name||'Finding destination'}</span><span className="deadline"><Clock3 size={16}/>Arrive before {at(new Date(new Date(mission.deadline).getTime()-Number(mission.constraints.bufferMinutes||0)*60000).toISOString())}</span></div>}
          <div className={`outcome-grid ${travel?'':work?'work-outcome':'read-outcome'}`}>
            <section className="journey-panel">{travel?<><div className="section-heading"><div><h2>Your route</h2><p>Traffic-aware estimates and directions, here in MOVA.</p></div><Navigation size={21}/></div><MissionMap mission={mission} selectedPlan={selected||mission.selectedPlanId} onSelect={setSelected} onLocate={locate} mapsProvider={data.config.mapsProvider} tileUrl={data.config.tileUrl} trackingPosition={position}/>
              <div className="route-options" aria-label="Available routes">{mission.plans.map(plan=><button key={plan.id} className={`route-option ${plan.id===(selected||mission.selectedPlanId)?'selected':''}`} onClick={()=>setSelected(plan.id)} aria-pressed={plan.id===(selected||mission.selectedPlanId)}><span className="route-selector">{plan.id===(selected||mission.selectedPlanId)&&<Check size={13}/>}</span><span><strong>{plan.name}</strong><small>{plan.feasible?`${plan.slackMinutes} min spare`:plan.reason}{plan.trafficDelaySeconds!=null?` · ${Math.ceil(plan.trafficDelaySeconds/60)} min traffic delay`:''}</small></span><b>{plan.durationMinutes}<small>min</small></b></button>)}</div>
              <div className="map-monitor"><span>{data.tracking?.error||position?`Phone: ${data.tracking?.error||'fresh location received'}`:'Phone location not received yet'}</span><button onClick={()=>setPage('connections')}>Tracking setup</button><button onClick={()=>{if(mission)void request(`/api/missions/${mission.id}/observe`,{});}} disabled={!!busy}><RefreshCw size={14}/>Refresh routes</button><button onClick={()=>setMonitoring(v=>!v)}>{monitoring?'Pause route checks':'Resume route checks'}</button></div>
            </>:work?<WorkWorkspace mission={mission} busy={!!busy} onUpdate={text=>{const payload=contextPayload(text);return payload?request(`/api/missions/${mission.id}/context`,payload):Promise.resolve(null);}} onResolveAction={(proposalId,outcome)=>request(`/api/missions/${mission.id}/proposals/${proposalId}`,{revision:mission.revision,outcome})}/>:<Result mission={mission}/>}</section>
            <section className="reason-panel"><div className="section-heading"><div><h2>FalkorDB decision graph</h2><p>Live evidence paths and dependencies for this mission.</p></div><button className="secondary" title="Open live FalkorDB connected-data graph" aria-label="Open live FalkorDB connected-data graph" onClick={()=>setExpanded(true)}><Database size={16}/>Open live graph</button></div><Bubble mission={mission} selectedPlan={selected||mission.selectedPlanId} onInspect={setInspected}/></section>
          </div>
          <section className="next-action"><ShieldCheck size={24}/><div><h2>{travel&&mission.state==='AWAITING_APPROVAL'?'Ready to start route guidance':travel&&mission.state==='VERIFYING'?'Guidance is open. Checking the outcome.':missionNeedsAttention?mission.inputRequest?'MOVA needs your input':'Investigation needs attention':mission.state==='RESOLVED'?'Outcome checked against evidence':work?'Your next step':'Working toward your outcome'}</h2><p>{travel&&mission.state==='AWAITING_APPROVAL'?`MOVA selected ${mission.plans.find(p=>p.id===mission.selectedPlanId)?.name||'a route'}. Directions will open in this page. Arrival still needs fresh location evidence.`:travel&&mission.state==='VERIFYING'?'Keep phone tracking enabled. Opening directions does not mean you have arrived.':mission.summary}</p></div><div>{travel&&mission.state==='AWAITING_APPROVAL'?<button className="primary" disabled={!!busy} onClick={()=>request(`/api/missions/${mission.id}/approve`,{revision:mission.revision})}><Navigation size={17}/>Start guidance</button>:work&&mission.state==='BLOCKED'&&mission.inputRequest?<button className="primary" disabled={!!busy} onClick={()=>setNeedsInput(true)}>Give MOVA input</button>:mission.kind==='pending'&&mission.state==='BLOCKED'?<button className="secondary" disabled={!!busy} onClick={()=>request(`/api/missions/${mission.id}/resume`,{})}><RefreshCw size={17}/>{busy?'Retrying…':'Retry interpretation'}</button>:['FAILED_RETRYABLE','UNKNOWN'].includes(mission.state)?<button className="secondary" disabled={!!busy} onClick={()=>request(`/api/missions/${mission.id}/resume`,{})}><RefreshCw size={17}/>Check again</button>:null}</div></section>
          <ActivityTrace mission={mission}/>
          {mission.receipts.length>0&&<section className="receipt-section"><h2>Action receipts</h2>{mission.receipts.map(r=><details key={r.id}><summary><ShieldCheck size={17}/><strong>{r.tool.replaceAll('_',' ')}</strong><span>{readable(r.status)}</span><time>{at(r.at)}</time></summary><p>{r.summary}</p>{r.verification&&<pre>{typeof r.verification==='string'?r.verification:JSON.stringify(r.verification,null,2)}</pre>}</details>)}</section>}
        </>}
        </div>:null}
      </>}
      <footer className="workspace-footer"><Database size={14}/>Connected evidence in FalkorDB<span>Source → decision → action → verification</span></footer>
    </main>
    <dialog ref={dialog} className="evidence-dialog" onCancel={()=>{setInspected(null);setExpanded(false);}}><button className="dialog-close icon-button" aria-label="Close details" onClick={()=>{setInspected(null);setExpanded(false);}}><X size={21}/></button>{inspected?<Inspector item={inspected}/>:expanded&&mission?<><h2>Live FalkorDB connected-data graph</h2><p>These are persisted nodes and exact relationships from this mission. Select a node or relation to inspect its evidence.</p><Bubble mission={mission} selectedPlan={selected||mission.selectedPlanId} onInspect={setInspected} expanded/></>:null}</dialog>
    <dialog ref={inputDialog} className="agent-input-dialog" onCancel={()=>setNeedsInput(false)}>{popupMission&&<><button className="dialog-close icon-button" aria-label="Close MOVA input request" onClick={()=>setNeedsInput(false)}><X size={19}/></button><div className="action-agent-message"><Avatar state="thinking" size={46}/><div><strong>MOVA asks</strong><p>{inputPrompt.question}</p></div></div><h2>Give MOVA the missing decision</h2>{inputPrompt.reason&&<p className="input-blocker"><b>Blocked because:</b> {inputPrompt.reason}</p>}{inputPrompt.options.length>0&&<div className="input-suggestions">{inputPrompt.options.map(option=><button key={option} type="button" onClick={()=>{setInputText(option);if(clarificationKey)setAttentionDrafts(current=>({...current,[clarificationKey]:option}));}}>{option}</button>)}</div>}<form onSubmit={async event=>{event.preventDefault();const payload=contextPayload(inputText);if(!payload||!popupMission)return;const result=await request(`/api/missions/${popupMission.id}/context`,payload);if(result){setInputText('');setAttentionDrafts(current=>{const next={...current};delete next[clarificationKey];return next;});setNeedsInput(false);}}}><label htmlFor="agent-input">Your instruction or missing context</label><textarea id="agent-input" name="agent-input" autoComplete="off" value={inputText} onChange={event=>{setInputText(event.target.value);if(clarificationKey)setAttentionDrafts(current=>({...current,[clarificationKey]:event.target.value.slice(0,2000)}));}} maxLength={2000} placeholder={inputPrompt.placeholder||inputPrompt.question} required/><button className="primary" disabled={!!busy||!inputText.trim()}>Continue investigation<ArrowRight size={16}/></button></form></>}</dialog>
    <dialog ref={recoveryDialog} className="agent-input-dialog" onCancel={()=>setShowBlockedRecovery(false)}>{blockedWithoutPrompt&&popupMission&&<><button className="dialog-close icon-button" aria-label="Close investigation notice" onClick={()=>setShowBlockedRecovery(false)}><X size={19}/></button><div className="action-agent-message"><Avatar state="unsure" size={46}/><div><strong>Investigation needs attention</strong><p>MOVA stopped before finishing and did not provide a clarification question.</p></div></div><h2>Why MOVA stopped</h2><p className="input-blocker">{recoveryError||popupMission.summary}</p>{workFailureDetail(popupMission)&&<p>{workFailureDetail(popupMission)}</p>}{invalidPlanArguments?<p>The artifact content will be synthesized again from the saved request and verified evidence. Resuming keeps this investigation’s ID, completed steps, and evidence.</p>:<p>You can resume the saved plan or revise it to use a different source. Completed work and its evidence remain in this investigation’s history.</p>}<div className="action-dialog-buttons"><button className="primary" disabled={!!busy||recoveryAttemptedKey===blockedEventKey} onClick={async()=>{const result=await resumeExisting(popupMission.id);if(!result)return;const latest=(result as {mission?:Mission}).mission;if(latest&&!['BLOCKED','FAILED_RETRYABLE','UNKNOWN'].includes(latest.state)){setShowBlockedRecovery(false);setRecoveryError('');}else{setRecoveryAttemptedKey(blockedEventKey);setRecoveryError(latest?.summary||'MOVA accepted the retry but remains blocked. Review the updated plan before trying again.');}}}><RefreshCw size={16}/>{busy?'Retrying…':recoveryAttemptedKey===blockedEventKey?'Retry did not clear the issue':'Resume investigation'}</button></div><form onSubmit={event=>{event.preventDefault();void reviseBlockedPlan(recoveryContext||recoverySuggestion);}}><label htmlFor="recovery-context">Change how MOVA should continue</label><textarea id="recovery-context" value={recoveryContext} onChange={event=>setRecoveryContext(event.target.value)} maxLength={2000} placeholder={recoverySuggestion}/><button className="secondary" disabled={!!busy}>{failedReadUrl?'Find another source and revise plan':'Revise plan and continue'}<ArrowRight size={16}/></button></form></>}</dialog>
    <dialog ref={actionDialog} className="action-dialog" onCancel={()=>setSelectedProposal(undefined)}>{selectedProposal&&popupMission&&<><button className="dialog-close icon-button" aria-label="Close action review" onClick={()=>setSelectedProposal(undefined)}><X size={19}/></button><div className="action-agent-message"><Avatar state="thinking" size={46}/><div><strong>MOVA needs your decision</strong><p>This action follows the connected evidence in the current mission. Nothing has been sent.</p></div></div><h3>{proposalTitle(selectedProposal)}</h3><pre>{proposalBody(selectedProposal)}</pre><div className="action-dialog-buttons"><button className="secondary" disabled={!!busy} onClick={async()=>{const result=await request(`/api/missions/${popupMission.id}/proposals/${selectedProposal.id}`,{revision:popupMission.revision,outcome:'reject'});if(result)setSelectedProposal(undefined);}}>Reject</button><button className="primary" disabled={!!busy} onClick={async()=>{const result=await request(`/api/missions/${popupMission.id}/proposals/${selectedProposal.id}`,{revision:popupMission.revision,outcome:'approve'});if(result)setSelectedProposal(undefined);}}><ShieldCheck size={16}/>Approve action</button></div></>}</dialog>
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
  const waiting=state==='AWAITING_APPROVAL'||Boolean(mission?.work?.proposals?.some(proposal=>proposal.status==='PENDING_APPROVAL'))||state==='VERIFYING'&&mission?.kind==='travel';
  const status=pending?'Submitting request':waiting?state==='VERIFYING'?'Waiting for arrival evidence':'Awaiting approval':terminalIssue?readable(state):activeStates.includes(state)||state==='VERIFYING'?'Running':readable(state);
  return <section className="execution-panel" aria-label="Live execution"><div className="execution-heading"><span><Activity size={17}/>Live execution</span><span>{status}</span></div><ol>{groups.map((label,i)=>{const done=state==='RESOLVED'||i<index;const blocked=terminalIssue&&i===index;const isWaiting=waiting&&i===index;const active=i===index&&!blocked&&!isWaiting&&state!=='RESOLVED';const className=blocked?'blocked':isWaiting?'waiting':active?'current':done?'done':'';return <li key={label} className={className} aria-label={`${label}: ${blocked?'needs attention':isWaiting?'awaiting approval':done?'complete':active?'in progress':'not started'}`}><span>{done?<Check size={14}/>:active?<span className="execution-pulse"/>:i+1}</span><strong>{label}</strong></li>;})}</ol></section>;
}
function Inspector({item}:{item:GraphNode|GraphEdge}){
  const edge='target'in item;
  return <><h2>{item.label.replaceAll('_',' ')}</h2><p>{edge?item.explanation:'This entity is part of the evidence used for the current request.'}</p><dl className="evidence-fields"><div><dt>Evidence type</dt><dd>{readable(item.evidenceKind||'unknown')}</dd></div><div><dt>Source</dt><dd>{edge?item.provenance:item.source}</dd></div><div><dt>Observed</dt><dd>{item.observedAt?new Date(item.observedAt).toLocaleString():'Unknown timestamp'}</dd></div><div><dt>State</dt><dd>{readable(item.status||'unknown')}</dd></div>{edge?<div><dt>Connection</dt><dd>{item.source} → {item.target}</dd></div>:null}</dl>{!edge&&<details><summary>Properties used by the agent</summary><pre>{JSON.stringify(item.properties,null,2)}</pre></details>}</>;
}
function Result({mission}:{mission:Mission}){
  const result=mission.result;
  const heading=result?(mission.kind==='weather'?'Weather result':mission.kind==='calendar_read'?'Your calendar':mission.kind==='nearby_places'?'Nearby places':'Request result'):['BLOCKED','FAILED_RETRYABLE','UNKNOWN'].includes(mission.state)?'Investigation needs attention':'Investigation in progress';
  return <div className="read-result"><h2>{heading}</h2>{!result?<p>{mission.summary}</p>:<><p className="result-source">{String(result.source||'Connected tool')} · {result.observedAt?new Date(result.observedAt).toLocaleString():''}</p>{mission.kind==='nearby_places'?<NearbyResults result={result}/>:mission.kind==='calendar_read'?<div>{Array.isArray(result.events)&&result.events.length?result.events.map((e:any,i:number)=><article key={e.id||i}><strong>{e.summary||'Untitled event'}</strong><p>{e.start?.dateTime||e.start?.date||'Time unavailable'}{e.location?` · ${e.location}`:''}</p></article>):<p>No events returned for the requested period.</p>}</div>:mission.kind==='weather'&&result.current?<dl>{Object.entries(result.current).map(([key,value])=><div key={key}><dt>{key.replaceAll('_',' ')}</dt><dd>{String(value)} {result.current_units?.[key]||''}</dd></div>)}</dl>:<p>{mission.summary}</p>}<details><summary>Inspect source response</summary><pre>{JSON.stringify(result,null,2)}</pre></details></>}</div>;
}
function NearbyResults({result}:{result:Record<string,any>}){
  const places=Array.isArray(result.places)?result.places:[];
  return <div className="nearby-results"><p className="nearby-result-count">{places.length?`${places.length} places within ${(Number(result.radiusMeters||0)/1000).toFixed(1)} km, sorted by straight-line distance.`:`No matching places within ${(Number(result.radiusMeters||0)/1000).toFixed(1)} km. Try a wider radius or another category.`}</p>{result.center&&<NearbyMap center={result.center} places={places} radiusMeters={Number(result.radiusMeters||5000)}/>}<div className="nearby-place-list">{places.map((place:any)=><article key={place.id}><div className="nearby-place-title"><strong>{place.name}</strong><span>{place.distanceMeters<1000?`${Math.round(place.distanceMeters)} m`:`${(place.distanceMeters/1000).toFixed(1)} km`}</span></div>{place.address&&<p>{place.address}</p>}{place.categories?.length>0&&<small>{place.categories.join(' · ')}</small>}{place.rating!=null&&<small> · {place.rating}★{place.userRatingCount?` (${place.userRatingCount})`:''}</small>}{place.phone&&<p>{place.phone}</p>}{place.openingHours&&<small>{place.openingHours}</small>}{place.url&&<p><a href={place.url} target="_blank" rel="noreferrer">More information</a></p>}</article>)}</div></div>;
}
