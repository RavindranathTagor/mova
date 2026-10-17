import express from 'express';
import {createWorkflows} from './workflows.mjs';
import {createResourceRegistry} from './resource-registry.mjs';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createEngine } from './engine.mjs';
import { createGraph } from './graph.mjs';
import { createStore } from './store.mjs';
import { createAdapters } from './adapters.mjs';
import { createProvider } from './provider.mjs';
import { createTraccar } from './traccar.mjs';
import { createConnectors } from './connectors.mjs';
import { createWorkTools } from './work-tools.mjs';
import { createWorkGraph } from './work-graph.mjs';
import { createRemoteMcp } from './remote-mcp.mjs';
import { createIncidentRouting } from './incident-routing.mjs';
import { createOperationsGraph } from './operations-graph.mjs';
import { resolveManualPlace, validPoint } from './geo.mjs';

const resources=createResourceRegistry({path:join(process.env.MOVA_DATA_DIR||'.data','resources.json')});
await resources.init();
const app=express();
const port=Number(process.env.PORT||3001);
const host=process.env.HOST||'127.0.0.1';
if(!['127.0.0.1','localhost','::1'].includes(host))throw new Error('This single-user prototype must bind to loopback. Deploy behind an authenticated gateway before public exposure.');
const listeners=new Set();
const adapters=createAdapters({env:process.env});
const provider=createProvider({env:process.env});
const graph=createGraph({url:process.env.FALKORDB_URL||'redis://127.0.0.1:6380'});
const traccar=createTraccar({env:process.env});
const workGraph=createWorkGraph({url:process.env.FALKORDB_URL||'redis://127.0.0.1:6380'});
const operationsGraph=createOperationsGraph({url:process.env.FALKORDB_URL||'redis://127.0.0.1:6380'});
const incidentRouting={resolve:event=>createIncidentRouting({env:process.env}).resolve(event)};
const currentWorkTools=()=>createWorkTools({env:process.env,dataDir:join(process.env.MOVA_DATA_DIR||'.data','artifacts'),adapters,operationsGraph});
const localWorkTools=Object.fromEntries(['list','call','executeProposal','listMentions','listCustomerReports'].map(name=>[name,(...args)=>currentWorkTools()[name](...args)]));
const remoteMcp=createRemoteMcp({env:process.env});
await remoteMcp.init();
const workTools={list:()=>[...localWorkTools.list(),...remoteMcp.list()],call:(name,args,context)=>name.startsWith('mcp_')?remoteMcp.call(name,args):localWorkTools.call(name,args,context),executeProposal:proposal=>localWorkTools.executeProposal(proposal)};
const workflows=createWorkflows({path:join(process.env.MOVA_DATA_DIR||'.data','workflows.json'),getTools:()=>workTools.list()});
await workflows.init();
const connectors=createConnectors({env:process.env,adapters,provider,traccar,workTools,remoteMcp});
let trackingPosition=null;
let trackingEnabled=true;
let trackingError=null;
let trackingMonitoringError=null;
let trackingRequest;
const enrich=state=>({...state,integrations:[...state.integrations,traccar.status()],tracking:{enabled:trackingEnabled,configured:traccar.configured,position:trackingPosition,error:trackingError,monitoringError:trackingMonitoringError,serverUrl:process.env.TRACCAR_URL||'http://127.0.0.1:8082'}});
const broadcast=state=>{const event=`event: state\ndata: ${JSON.stringify(enrich(state))}\n\n`;for(const response of listeners)response.write(event);};
const engine=createEngine({graph,store:createStore({path:join(process.env.MOVA_DATA_DIR||'.data','missions.json')}),adapters,provider,workTools,workGraph,operationsGraph,onChange:broadcast});
await engine.init();
await operationsGraph.init();
let mentionPoll;
const mentionSeen=new Set();
const incidentSeen=new Set();
const mentionPollSeconds=Math.max(20,Math.min(300,Number(process.env.MOVA_MENTION_POLL_SECONDS||45)||45));
const mentionMaxAgeMs=Math.max(1,Math.min(60,Number(process.env.MOVA_MENTION_MAX_AGE_MINUTES||10)||10))*60000;
async function pollMentions(){
  if(mentionPoll)return mentionPoll;
  mentionPoll=(async()=>{
    const events=await localWorkTools.listMentions();
    for(const event of events.slice(-12)){
      if(mentionSeen.has(event.eventId)||engine.hasMentionEvent(event.eventId))continue;
      mentionSeen.add(event.eventId);
      if(Date.now()-Date.parse(event.observedAt)>mentionMaxAgeMs)continue;
      const target=event.channelId?`the same ${event.service} channel`:event.repository?`${event.repository} #${event.issueNumber}`:`the originating ${event.service} thread`;
      const replyTool=event.service==='GitHub'?'propose_github_issue_comment':event.service==='Slack'?'propose_slack_message':'propose_discord_message';
      const text=`A verified ${event.service} mention from ${event.source} asks: ${event.content}\n\nInvestigate the request using connected evidence. When an answer is ready, use ${replyTool} to prepare a concise reply to ${target}. Do not send any external message; MOVA must present it for explicit approval.`;
      try{await engine.createMission({text,deadlineMinutes:90,trigger:event});broadcast(engine.getState());}
      catch(error){console.warn(`MOVA could not start a ${event.service} mention mission: ${String(error.message||'unknown error').slice(0,160)}`);}
    }
  })();
  try{return await mentionPoll;}finally{mentionPoll=null;}
}
async function pollCustomerReports(){
  const reports=await localWorkTools.listCustomerReports();
  for(const report of reports.slice(-12)){
    if(incidentSeen.has(report.eventId)||engine.hasMentionEvent(report.eventId))continue;
    incidentSeen.add(report.eventId);
    if(Date.now()-Date.parse(report.observedAt)>mentionMaxAgeMs)continue;
    try{
      const binding=incidentRouting.resolve(report);
      const fingerprint=String(report.content).toLowerCase().replace(/#customer-issue\b/g,'').replace(/[^a-z0-9]+/g,' ').trim().split(' ').filter(word=>word.length>2).slice(0,12).sort().join('-')||report.id;
      await operationsGraph.upsertReport({id:report.id,channelId:binding.channelId,repository:binding.repository,fingerprint,summary:report.content,observedAt:report.observedAt});
      const related=await operationsGraph.findRelated({repository:binding.repository,fingerprint});
      const existingIssueNumber=related.issueNumbers.length===1?related.issueNumbers[0]:null;
      const text=`Customer report from Discord: ${report.content}`;
      await engine.createMission({text,mode:'live',deadlineMinutes:90,trigger:report,operationalContext:{...binding,kind:'customer_incident',reportId:report.id,fingerprint,existingIssueNumber,relatedPaths:related.paths}},{background:true});broadcast(engine.getState());
    }catch(error){console.warn(`MOVA could not start customer incident workflow: ${String(error.message||'unknown error').slice(0,160)}`);}
  }
}
const mentionTimer=setInterval(()=>void pollMentions().catch(()=>{}),mentionPollSeconds*1000);
mentionTimer.unref();
void pollMentions().catch(()=>{});
const incidentTimer=setInterval(()=>void pollCustomerReports().catch(()=>{}),mentionPollSeconds*1000);
incidentTimer.unref();
void pollCustomerReports().catch(()=>{});
async function refreshTracking(){
  if(trackingRequest)return trackingRequest;
  if(!traccar.configured||!trackingEnabled)return enrich(engine.getState());
  trackingRequest=(async()=>{
    let position;
    try { position=await traccar.getLatestPosition(); trackingError=null; }
    catch(error){trackingError=String(error.message||'Tracking source unavailable');}
    if(position){
      try {
        trackingMonitoringError=null;
        if(position.positionId!==trackingPosition?.positionId){trackingPosition=position;await engine.setLocation(position);}
        const mission=engine.getState().mission;
        if(mission?.mode==='live'&&(!mission.kind||mission.kind==='travel')&&['VERIFYING','AWAITING_APPROVAL','BLOCKED'].includes(mission.state))await engine.observeRoutes(mission.id);
      } catch { trackingMonitoringError='Phone location received; the mission update could not finish.'; }
    }
    broadcast(engine.getState());return enrich(engine.getState());
  })();
  try{return await trackingRequest;}finally{trackingRequest=null;}
}
const trackingTimer=setInterval(()=>void refreshTracking(),traccar.pollIntervalMs||15000);
trackingTimer.unref();
app.disable('x-powered-by');
app.use(express.json({limit:'20kb'}));
const sessionSecret=process.env.APP_SESSION_SECRET||randomBytes(32).toString('hex');
const sign=value=>createHmac('sha256',sessionSecret).update(value).digest('hex');
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Cache-Control','no-store');
  const requestHost=req.hostname;
  if(!['localhost','127.0.0.1','::1','[::1]'].includes(requestHost))return res.status(403).json({error:'Unrecognized local host.'});
  const origin=req.get('origin');
  const allowed=new Set([process.env.APP_ORIGIN||'http://localhost:5173','http://127.0.0.1:5173',`http://localhost:${port}`,`http://127.0.0.1:${port}`]);
  if(origin&&!allowed.has(origin))return res.status(403).json({error:'Cross-origin request denied.'});
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&(!req.is('application/json')||!req.get('x-mova-client')))return res.status(403).json({error:'A same-origin MOVA request is required.'});
  const cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('mova_session='))?.slice(13);
  let sessionId;
  if(cookie){const [value,mac]=cookie.split('.');const expected=sign(value||'');if(mac&&mac.length===expected.length&&timingSafeEqual(Buffer.from(mac),Buffer.from(expected)))sessionId=value;}
  if(!sessionId){sessionId=randomBytes(24).toString('hex');res.cookie('mova_session',`${sessionId}.${sign(sessionId)}`,{httpOnly:true,sameSite:'lax',maxAge:86400000,path:'/'});}
  req.movaSession=sessionId;
  next();
});
const route=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){next(e);}};
app.get('/api/state',(_req,res)=>res.json(enrich(engine.getState())));
app.get('/api/resources',(_req,res)=>res.json({resources:resources.list()}));
app.get('/api/memory/graph',route(async(_req,res)=>res.json(await operationsGraph.snapshot())));
app.put('/api/resources/:service',route(async(req,res)=>res.json({resources:await resources.update(req.params.service,req.body.values)})));
app.get('/api/health',(_req,res)=>res.json({ok:true,graph:graph.status(),model:provider.configured?'configured':'disconnected'}));
app.get('/api/connectors',(_req,res)=>res.json({connectors:connectors.list()}));
app.get('/api/capabilities',(_req,res)=>res.json({tools:workTools.list(),mcp:remoteMcp.status()}));
app.post('/api/connectors/:id/check',route(async(req,res)=>res.json(await connectors.check(req.params.id))));
app.post('/api/connectors/:id/configure',route(async(req,res)=>res.json(connectors.configure(req.params.id,req.body.values))));
app.get('/api/events',(req,res)=>{
  res.set({'Content-Type':'text/event-stream','Connection':'keep-alive','Cache-Control':'no-cache','X-Accel-Buffering':'no'});res.flushHeaders();
  res.write(`event: state\ndata: ${JSON.stringify(enrich(engine.getState()))}\n\n`);listeners.add(res);
  const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),20000);
  req.on('close',()=>{clearInterval(heartbeat);listeners.delete(res);});
});
app.get('/api/workflows',(_req,res)=>res.json({workflows:workflows.list()}));
app.post('/api/workflows',route(async(req,res)=>res.json({workflow:await workflows.save(req.body)})));
app.post('/api/missions',route(async(req,res)=>res.json(await engine.createMission({...req.body,workflow:req.body.workflowId?workflows.get(req.body.workflowId):null},{background:req.get('x-mova-client')==='web'}))));
app.post('/api/missions/:id/select',route(async(req,res)=>res.json(await engine.selectMission(req.params.id))));
app.post('/api/missions/:id/context',route(async(req,res)=>res.json(await engine.updateWorkContext(req.params.id,req.body.text))));
app.post('/api/missions/:id/proposals/:proposalId',route(async(req,res)=>res.json(await engine.resolveWorkProposal(req.params.id,req.params.proposalId,req.body.revision,req.body.outcome))));
app.post('/api/missions/:id/approve',route(async(req,res)=>res.json(await engine.approve(req.params.id,req.body.revision))));
app.post('/api/missions/:id/resume',route(async(req,res)=>res.json(await engine.resume(req.params.id))));
app.post('/api/missions/:id/observe',route(async(req,res)=>res.json(await engine.observeRoutes(req.params.id))));
app.post('/api/missions/:id/acknowledge',route(async(req,res)=>res.json(await engine.acknowledge(req.params.id,req.body))));
app.post('/api/location',route(async(req,res)=>{const {latitude,longitude,accuracy,timestamp}=req.body;res.json(enrich(await engine.setLocation({latitude,longitude,accuracy,timestamp,source:'Authorized browser geolocation',evidenceKind:'observed'})));}));
app.post('/api/location/manual',route(async(req,res)=>{
  const query=typeof req.body?.query==='string'?req.body.query.trim().slice(0,300):'';
  if(!query)throw Object.assign(new Error('Enter a city, address, or landmark.'),{status:400});
  const found=await adapters.searchPlaces({query});
  const place=resolveManualPlace(found,typeof req.body.placeId==='string'?req.body.placeId:undefined);
  if(!place){
    const candidates=(found.places||[]).filter(item=>validPoint(item.location)).slice(0,5).map(item=>({id:item.id,label:String(item.displayName?.text||item.name||query).slice(0,200),address:String(item.formattedAddress||item.address||'').slice(0,300)}));
    if(!candidates.length)return res.json({location:null,candidates:[],message:'No matching location was returned. Try a more specific city, address, or landmark.'});
    if(req.body.placeId)return res.status(400).json({error:'That location is no longer in the search results. Search again and select a current result.'});
    return res.json({location:null,candidates,message:'Select the matching city or place so MOVA searches the correct area.'});
  }
  const point=validPoint(place.location);
  return res.json({location:{...point,label:String(place.displayName?.text||place.name||query).slice(0,200),source:found.source||'Connected Places search',evidenceKind:'user-provided',timestamp:Date.now(),accuracy:null},candidates:[]});
}));
app.get('/api/tracking',(_req,res)=>res.json(enrich(engine.getState()).tracking));
app.post('/api/tracking/refresh',route(async(_req,res)=>res.json(await refreshTracking())));
app.post('/api/tracking/control',route(async(req,res)=>{if(typeof req.body.enabled!=='boolean')return res.status(400).json({error:'Tracking enabled must be a boolean.'});trackingEnabled=req.body.enabled;broadcast(engine.getState());res.json(enrich(engine.getState()));}));
app.get('/api/google/auth',route(async(req,res)=>{
  const callback=new URL(process.env.GOOGLE_REDIRECT_URI||`http://localhost:${port}/api/google/callback`);
  if(req.hostname!==callback.hostname)return res.redirect(`${callback.origin}/api/google/auth`);
  res.redirect(await adapters.authURL({sessionId:req.movaSession}));
}));
app.get('/api/google/callback',route(async(req,res)=>{await adapters.callback({code:req.query.code,state:req.query.state,sessionId:req.movaSession});res.redirect(`${process.env.APP_ORIGIN||'http://localhost:5173'}/?connected=calendar`);}));
app.get('/api/calendar',route(async(_req,res)=>res.json(await adapters.getCalendarEvents({}))));
app.get('/api/voices',route(async(_req,res)=>res.json(await adapters.listVoices())));
app.post('/api/speech',route(async(req,res)=>{const audio=await adapters.speech(req.body);res.type('audio/mpeg').send(audio);}));
if(existsSync(resolve('dist/index.html'))){app.use(express.static(resolve('dist'),{maxAge:0}));app.get('/{*path}',(_req,res)=>res.sendFile(resolve('dist/index.html')));}
app.use((error,_req,res,_next)=>{const message=String(error.message||'Request failed').replace(/(?:AIza|sk_)[A-Za-z0-9_-]{15,}/g,'[redacted]');res.status(error.status||error.statusCode||400).json({error:message});});
const server=app.listen(port,host,()=>console.log(`MOVA agent http://${host}:${port} · graph ${graph.status().connected?'connected':'unavailable'}`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{clearInterval(trackingTimer);clearInterval(mentionTimer);clearInterval(incidentTimer);for(const res of listeners)res.end();server.close(async()=>{await Promise.allSettled([graph.close(),workGraph.close(),operationsGraph.close(),remoteMcp.close()]);process.exit(0);});});
