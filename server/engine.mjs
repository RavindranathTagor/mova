import {approveWorkProposal,runWorkMission} from './work-engine.mjs';
import {connectedResources} from './resource-registry.mjs';
import { distanceMeters, validPoint } from './geo.mjs';
﻿import { randomUUID, createHash } from 'node:crypto';

const tools = [
  ['get_mission_constraints','Read the protected deadline, budget and arrival success criterion.'],
  ['find_recovery_options','Traverse connected graph dependencies and discover feasible route options.'],
  ['evaluate_candidate_plans','Evaluate graph-connected options against deadline and cost constraints.'],
  ['explain_decision_path','Inspect actual evidence and dependency paths behind available options.'],
  ['find_impact_cone','Trace the latest observation through affected dependencies to this mission.'],
  ['find_mission_dependencies','Return exact bounded relationship paths linking the mission, constraints and route dependencies.'],
].map(([name,description])=>({name,description,inputSchema:{type:'object',properties:{},additionalProperties:false}}));
const stamp=()=>new Date().toISOString();
const errorWithStatus=(message,status=400)=>Object.assign(new Error(message),{status,statusCode:status});
function withBudget(promise,deadline){
  let timer;
  const left=deadline-Date.now();
  if(left<=0)return Promise.reject(new Error('The investigation time budget is exhausted. Resume to continue.'));
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The investigation time budget is exhausted. Resume to continue.')),left);})]).finally(()=>clearTimeout(timer));
}
const readTool=(name,description)=>({name,description,inputSchema:{type:'object',properties:{},additionalProperties:false}});

function resolvedPlace(result, purpose) {
  if (!result.resolution) return result.places?.[0];
  const resolution = result.resolution;
  const selected = result.places?.find(place => place.id === resolution.selectedPlaceId);
  if (resolution.status === 'matched' && selected) return selected;
  const candidates = (result.places || []).filter(place => !resolution.candidateIds?.length || resolution.candidateIds.includes(place.id));
  const names = candidates.slice(0, 3).map(place => String(place.displayName?.text || place.name || '').slice(0, 100)).filter(Boolean);
  throw new Error(`The ${purpose} is ${resolution.status === 'ambiguous' ? 'ambiguous' : 'unresolved'}.${names.length ? ' Candidates: ' + names.join('; ') + '.' : ''} Specify a more specific address or landmark.`);
}

function distanceToRoute(position, mission) {
  const plan = mission.plans.find(p => p.id === mission.selectedPlanId);
  const geometry = (plan?.coordinates || []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const points = [...geometry];
  for (const place of [mission.origin, mission.destination]) if (place) points.push([place.longitude, place.latitude]);
  const projected = points.map(([lon, lat]) => {
    const delta = ((lon - position.longitude + 540) % 360) - 180;
    return [delta * Math.PI / 180 * 6371000 * Math.cos(position.latitude * Math.PI / 180), (lat - position.latitude) * Math.PI / 180 * 6371000];
  });
  let closest = Infinity;
  for (let i = 0; i < projected.length; i++) {
    const [x, y] = projected[i];
    closest = Math.min(closest, Math.hypot(x, y));
    // Only source geometry defines segments; origin and destination are independent points.
    if (i > 0 && i < geometry.length) {
      const [a, b] = projected[i - 1], dx = x - a, dy = y - b;
      const fraction = Math.max(0, Math.min(1, -(a * dx + b * dy) / (dx * dx + dy * dy || 1)));
      closest = Math.min(closest, Math.hypot(a + fraction * dx, b + fraction * dy));
    }
  }
  return closest;
}

export function createEngine({graph,store,adapters={},provider,workTools,workGraph,operationsGraph=null,onChange=()=>{}}) {
  let state={version:1,currentId:null,missions:[]};
  let queue=Promise.resolve();
  let location=null;
  const routePolls=new Map();
  const current=()=>state.missions.find(m=>m.id===state.currentId)||null;
  const integrations=()=>[
    {id:'falkordb',name:'FalkorDB',status:graph.status().connected?'connected':'disconnected',detail:graph.status().detail},
    ...(adapters.getIntegrations?.()||[]).map(row=>row.id===provider?.name?.toLowerCase()&&provider.status?{...row,...provider.status()}:row),
  ];
  const getState=()=>structuredClone({mission:current(),integrations:integrations(),config:{mapsProvider:process.env.MAPS_PROVIDER||'osm',tileUrl:process.env.OSM_TILE_URL||'https://tile.openstreetmap.org/{z}/{x}/{y}.png',mapsWebKey:process.env.GOOGLE_MAPS_WEB_API_KEY||''},missions:state.missions.map(({id,title,state,mode})=>({id,title,state,mode}))});
  const persist=async()=>{await store.save(state);onChange(getState());};
  const trace=(mission,kind,title,detail,extra={})=>{
    mission.trace.push({id:randomUUID(),at:stamp(),kind,title,detail,...extra});
    if(mission.trace.length>150)mission.trace=mission.trace.slice(-150);
  };
  async function transition(mission,next,summary) {
    mission.state=next;mission.summary=summary;mission.agentStatus=next.toLowerCase();
    trace(mission,'state',next.replaceAll('_',' '),summary);
    await persist();
  }
  const serialize=operation=>{const task=queue.then(operation);queue=task.catch(()=>{});return task;};
  const find=(id,select=true)=>{const mission=state.missions.find(m=>m.id===id);if(!mission)throw errorWithStatus('Mission not found',404);if(select)state.currentId=id;return mission;};
  async function refreshGraph(mission) {
    mission.graph=await graph.snapshot(mission);
    const selected=mission.plans.find(p=>p.id===mission.selectedPlanId);
    for(const node of mission.graph.nodes){
      const plan=mission.plans.find(p=>p.id===node.id);
      if(plan)node.status=plan.id===mission.selectedPlanId?'selected':plan.feasible?'healthy':'rejected';
      if(node.id==='mission')node.status=mission.state==='RESOLVED'?'verified':mission.state==='BLOCKED'?'threatened':'healthy';
    }
    for(const edge of mission.graph.edges)if(selected?.path.includes(edge.source)&&selected.path.includes(edge.target))edge.status='selected';
  }
  function recordEvaluation(mission,result) {
    mission.plans=result.plans;
    mission.graphBackend=result.backend;
    trace(mission,'graph','Connected plans evaluated',`${result.plans.filter(p=>p.feasible).length} feasible options from ${result.source}.`,{tool:'evaluate_candidate_plans',query:result.query,params:result.params,source:result.source,evidenceIds:result.plans.flatMap(p=>p.blockers||[]),result:result.plans.map(({id,feasible,reason,path})=>({id,feasible,reason,path}))});
  }
  async function captureImpact(mission,event){
    const result=await graph.findImpactCone(mission,event.id);
    mission.impactPaths=result.paths;
    trace(mission,'graph','Impact Cone traced',`${result.paths.length} connected paths link this observation to the mission.`,{tool:'find_impact_cone',query:result.query,params:result.params,source:result.source,evidenceIds:[...new Set(result.paths.flatMap(p=>p.nodeIds))],result:result.paths});
    return result;
  }
  async function investigate(mission) {
    const requestedBudget=Number(provider?.investigationBudgetMs);
    const cycleBudget=Number.isFinite(requestedBudget)?Math.max(60000,Math.min(240000,requestedBudget)):60000;
    const cycleDeadline=Date.now()+cycleBudget;
    let cycleActive=true;
    const bounded=async promise=>{const result=await withBudget(promise,cycleDeadline);if(!cycleActive)throw new Error('Investigation was cancelled; late tool result discarded.');return result;};
    let toolSession;
    try {
      if(!graph.status().connected)throw new Error('Connect FalkorDB before starting a live mission.');
      if(!provider?.configured)throw new Error(`Connect ${provider?.name||'a model provider'} before starting live reasoning.`);
      const mentionText=`${mission.trigger?.content||''}\n${mission.originalGoal||mission.goal}`;
      const approvalGatedDiscordWork=['unsupported','pending'].includes(mission.kind)&&(mission.kind==='unsupported'||!mission.intent)&&mission.trigger?.service==='Discord'&&/\b(?:create|make|open|file|draft|prepare)\b.{0,100}\b(?:github\s+)?issues?\b/i.test(mentionText)&&/\b(?:send|post|message|reply|revert back)\b.{0,100}\bdiscord\b/i.test(mentionText);
      if(approvalGatedDiscordWork){
        mission.kind='work';mission.intent={kind:'work',goal:mission.goal,destinationQuery:'',summary:'The verified Discord request asks MOVA to gather repository evidence and prepare GitHub issue and Discord reply proposals for explicit approval.'};
        mission.successCriteria='Gather connected repository evidence and prepare only reviewable proposals. Do not create issues or send messages before user approval.';
        trace(mission,'agent','Discord request reclassified for investigation','The mention requests GitHub issue drafts and a Discord reply. MOVA will gather evidence and prepare approval-gated proposals; no external write will be sent automatically.',{source:'Verified Discord mention'});
      }
      if(!mission.intent){
        if(!provider.compileIntent)throw new Error('The configured provider cannot compile a travel mission.');
        await transition(mission,'INVESTIGATING',`${provider.name||'The connected model'} is interpreting your request and checking supported tools.`);
        const intent=await bounded(provider.compileIntent({text:mission.goal,origin:mission.origin}));
        mission.kind=intent.kind||'travel';
        if(mission.kind==='unsupported')throw new Error(intent.summary||'This task is not supported by the connected travel, weather, or calendar read tools.');
        if(mission.kind==='travel'&&intent.originQuery){const places=await bounded(adapters.searchPlaces({query:intent.originQuery}));const place=resolvedPlace(places,'starting place');if(!place?.location||!Number.isFinite(place.location.latitude)||!Number.isFinite(place.location.longitude))throw new Error('The named starting place could not be resolved. Specify a more precise starting place.');mission.origin={...place.location,label:place.displayName?.text||intent.originQuery,source:places.source,evidenceKind:'user-provided',observedAt:places.observedAt};}
        if(mission.kind==='travel'&&!mission.origin)throw new Error('Share your authorized current location before starting travel.');
        if(mission.kind==='travel'&&!mission.deadlineExplicit&&Number.isFinite(intent.deadlineMinutes)&&intent.deadlineMinutes>0&&intent.deadlineMinutes<=1440)mission.deadline=new Date(new Date(mission.createdAt).getTime()+intent.deadlineMinutes*60000).toISOString();
        mission.intent=intent;
        if(intent.goal){const title=intent.goal.trim();mission.title=title.length>120?title.slice(0,120).replace(/\s+\S*$/,''):title;}
        mission.successCriteria=mission.kind==='travel'?'Arrive within 500 m of the specified destination before the deadline minus 15 minutes. This does not verify boarding.':mission.kind==='weather'?'Retrieve current weather from the connected source.':mission.kind==='work'?'Produce the requested answer or local deliverable using verified tool evidence.':'Read upcoming events from the authorized calendar.';
        if(mission.kind==='nearby_places')mission.successCriteria='Return real places from the configured Places API within the requested radius of the authorized current or manually selected location, with verified coordinates and distances.';
        trace(mission,'agent','Mission understood',intent.summary,{source:'Model intent extraction'});
        await persist();
      }
      await transition(mission,'BUILDING_CONTEXT','Gathering the connected context needed for this investigation.');
      if(mission.kind==='nearby_places'){
        await performNearbyPlaces(mission,bounded);
        return;
      }
      if(mission.kind==='work'){
        if(mission.operationalContext?.kind==='customer_incident'&&!mission.operationalContext.reportId)delete mission.operationalContext;
        mission.connectedResources=connectedResources();
        if(mission.workflow)mission.connectedResources=Object.fromEntries(Object.entries(mission.connectedResources).filter(([service])=>mission.workflow.connectors.includes(service)).map(([service,ids])=>[service,ids.filter(id=>!mission.workflow.resources?.[service]?.length||mission.workflow.resources[service].includes(id))]));
        mission.previousContext=state.missions.filter(item=>item.id!==mission.id&&item.kind==='work').slice(-5).map(item=>({id:item.id,goal:item.goal.slice(0,1000),answer:item.work?.answer?.slice(0,1500),state:item.state}));
        if(operationsGraph?.recallMissions){
          const recalled=await operationsGraph.recallMissions({excludeId:mission.id,resources:mission.connectedResources});
          mission.previousContext=recalled.memories;
          trace(mission,'graph','Persistent memory recalled',`${recalled.memories.length} previous missions retrieved for the selected resources.`,{source:'FalkorDB',query:recalled.query,evidenceIds:recalled.memories.map(item=>item.id)});
        }
        try{await runWorkMission({mission,provider,workTools,workGraph,persist,transition,trace});}
        finally{if(operationsGraph?.rememberMission)await operationsGraph.rememberMission(mission);}
        return;
      }
      if(mission.kind==='calendar_read'||mission.kind==='weather'){await performRead(mission,bounded);return;}
      if(!mission.destination){
        const places=await bounded(adapters.searchPlaces({query:mission.intent.destinationQuery}));
        const place=resolvedPlace(places,'destination');
        if(!place?.location||!Number.isFinite(place.location.latitude)||!Number.isFinite(place.location.longitude))throw new Error('No supported destination was found. Give a more specific airport and terminal.');
        mission.destination={...place.location,label:place.displayName?.text||mission.intent.destinationQuery,placeId:place.id,source:places.source,observedAt:places.observedAt};
        trace(mission,'tool','Destination resolved',mission.destination.label,{tool:'search_places',source:places.source});
      }
      if(mission.plans.some(p=>{const age=Date.now()-Date.parse(p.observedAt);return !Number.isFinite(age)||age>300000||age< -60000;})){
        mission.plans=[];
        trace(mission,'source','Refreshing stale route evidence','Route estimates older than five minutes cannot authorize navigation.',{source:'Freshness policy'});
      }
      if(!mission.plans.length){
        if(!mission.origin||!mission.destination)throw new Error('Live travel needs an authorized current location and a destination.');
        const routes=await bounded(adapters.calculateRoutes({origin:mission.origin,destination:mission.destination,deadline:mission.deadline,maxCost:mission.constraints.maxCost}));
        mission.plans=Array.isArray(routes)?routes:routes.routes||[];
        mission.needsRouteRefresh=false;
        trace(mission,'tool','Route source queried',`${mission.plans.length} route options returned.`,{tool:'calculate_routes',source:mission.plans[0]?.source||'Configured route adapter'});
      }
      await bounded(graph.seed(mission));
      if(mission.observations.length)await bounded(captureImpact(mission,mission.observations.at(-1)));
      const dependencies=await bounded(graph.findDependencies(mission));
      trace(mission,'graph','Mission dependencies connected',`${dependencies.paths.length} exact relationship paths explain the active context.`,{tool:'find_mission_dependencies',query:dependencies.query,params:dependencies.params,source:dependencies.source,evidenceIds:[...new Set(dependencies.paths.flatMap(p=>p.nodeIds))],result:dependencies.paths});
      await bounded(refreshGraph(mission));
      await transition(mission,'INVESTIGATING','Checking connected evidence before choosing the next tool.');
      const result=await graph.evaluate(mission);
      recordEvaluation(mission,result);
      await refreshGraph(mission);
      await transition(mission,'PLANNING','Comparing routes against your protected arrival deadline.');
      let feasible=mission.plans.filter(p=>p.feasible);
      mission.selectedPlanId=null;
      await graph.recordDecision(mission);
      if(!feasible.length){await transition(mission,'BLOCKED','No known route satisfies the deadline and connected constraints. I need changed conditions or an adjusted goal.');await refreshGraph(mission);await persist();return;}
      let selected=feasible[0];
      let summary=`${selected.name} protects ${selected.slackMinutes} minutes of arrival margin.`;
      {
        const availableTools=[...tools,readTool('calculate_routes','Refresh real route estimates, update the graph, and recompute feasibility.')];
        if(adapters.getIntegrations?.().some(i=>i.id==='calendar'&&['read_only','write_available','connected'].includes(i.status)))availableTools.push(readTool('get_calendar_events','Read authorized upcoming calendar events relevant to this mission deadline.'));
        if(adapters.getWeather)availableTools.push(readTool('get_weather','Read destination weather only if it affects this mission.'));
        const dispatchTool=async(name)=>{
          if(name==='get_mission_constraints')return {...mission.constraints,deadline:mission.deadline,successCriteria:mission.successCriteria};
          if(name==='explain_decision_path')return {paths:mission.plans.map(({id,path,decisionPaths,reason,blockers})=>({id,path,decisionPaths,reason,blockers})),graph:mission.graph};
          if(name==='find_impact_cone')return mission.observations.length?captureImpact(mission,mission.observations.at(-1)):graph.findImpactCone(mission,'no-observation');
          if(name==='find_mission_dependencies')return graph.findDependencies(mission);
          if(name==='calculate_routes'){
            const previous=mission.plans;
            const observations=[];
            const routes=await bounded(adapters.calculateRoutes({origin:mission.origin,destination:mission.destination,deadline:mission.deadline,maxCost:mission.constraints.maxCost}));
            mission.plans=Array.isArray(routes)?routes:routes.routes||[];
            mission.needsRouteRefresh=false;
            for(const plan of mission.plans){
              const old=previous.find(p=>p.id===plan.id);
              if(old&&old.durationMinutes!==plan.durationMinutes)observations.push({id:randomUUID(),type:'route_update',at:Date.parse(plan.observedAt),source:plan.source,evidenceKind:'calculated_estimate',value:{planId:plan.id,durationMinutes:plan.durationMinutes,previousDurationMinutes:old.durationMinutes}});
            }
            mission.observations.push(...observations);
            await bounded(graph.seed(mission));
            for(const event of observations)await bounded(captureImpact(mission,event));
            const evaluation=await bounded(graph.evaluate(mission));recordEvaluation(mission,evaluation);
            return {plans:evaluation.plans,source:mission.plans[0]?.source||'Configured route adapter'};
          }
          if(name==='get_calendar_events'||name==='get_weather'){
            const output=await bounded(name==='get_calendar_events'?adapters.getCalendarEvents({timeMin:stamp(),timeMax:mission.deadline,maxResults:10}):adapters.getWeather(mission.destination));
            const event={id:randomUUID(),type:name==='get_weather'?'weather':'calendar',at:Date.now(),source:output.source,evidenceKind:output.evidenceKind||'observed',value:output};
            mission.observations.push(event);await graph.observe(mission,event);await bounded(captureImpact(mission,event));return output;
          }
          if(name==='find_recovery_options'||name==='evaluate_candidate_plans'){
            const evaluation=await bounded(graph.evaluate(mission));recordEvaluation(mission,evaluation);return {plans:evaluation.plans,query:evaluation.query};
          }
          throw new Error('Unsupported investigative tool');
        };
        const {createToolSession}=await import('./tool-session.mjs');
        toolSession=await bounded(createToolSession(availableTools,dispatchTool));
        const results=[{tool:'evaluate_candidate_plans',result:{plans:mission.plans}}];
        let chosen=false;
        for(let round=0;round<12;round++){
          await transition(mission,'PLANNING',`${provider.name||'The connected model'} is evaluating graph evidence and choosing the next step.`);
          const decision=await bounded(provider.next({mission:structuredClone(mission),tools:availableTools,results}));
          if(decision.summary){mission.summary=String(decision.summary).slice(0,1200);trace(mission,'agent','Agent update',mission.summary,{source:'Model decision summary'});await persist();}
          if(decision.selectedPlanId){const fresh=await bounded(graph.evaluate(mission));recordEvaluation(mission,fresh);feasible=mission.plans.filter(p=>p.feasible);selected=feasible.find(p=>p.id===decision.selectedPlanId);if(!selected)throw new Error('The model selected an infeasible or unknown route; action blocked.');summary=decision.summary||summary;chosen=true;break;}
          if(!availableTools.some(t=>t.name===decision.tool))throw new Error('The model requested an unsupported tool; action blocked.');
          const output=await bounded(toolSession.call(decision.tool,decision.args||{}));
          feasible=mission.plans.filter(p=>p.feasible);
          await refreshGraph(mission);
          trace(mission,'tool',decision.tool.replaceAll('_',' '),'Typed tool returned current mission evidence.',{tool:decision.tool,source:output.source||'FalkorDB'});
          results.push({tool:decision.tool,result:output});await persist();
        }
        if(!chosen)throw new Error('The model reached its 12-tool budget without a valid plan. Resume after checking the mission context.');
      }
      mission.selectedPlanId=selected.id;
      mission.revision++;
      await graph.recordDecision(mission);
      await refreshGraph(mission);
      await transition(mission,'POLICY_CHECK',summary);
      trace(mission,'decision','Recovery path selected',summary,{source:'Model selection + constraint validation',evidenceIds:selected.path});
      await transition(mission,'AWAITING_APPROVAL',`${summary} Review this route before opening navigation.`);
    }catch(error){
      cycleActive=false;
      mission.selectedPlanId=null;
      if(mission.kind==='work')delete mission.inputRequest;
      trace(mission,'error','Mission needs attention',error.message,{status:'FAILED'});
      await transition(mission,'BLOCKED',error.message);
    }finally{cycleActive=false;if(toolSession)await toolSession.close();}
  }
  async function performNearbyPlaces(mission,bounded){
    const center=validPoint(mission.origin);
    if(!center)throw new Error('Location is needed for a nearby search. Allow browser location or enter a city or address.');
    const query=typeof mission.intent?.placeQuery==='string'&&mission.intent.placeQuery.trim()?mission.intent.placeQuery.trim():'points of interest';
    const radiusMeters=Number.isFinite(mission.intent?.radiusMeters)?mission.intent.radiusMeters:5000;
    if(typeof adapters.searchNearbyPlaces!=='function')throw new Error('Nearby place search is unavailable. Configure TomTom Search (TOMTOM_API_KEY) or Google Places API (New) (GOOGLE_MAPS_SERVER_API_KEY).');
    await transition(mission,'PLANNING',`Searching for ${query} within ${Math.round(radiusMeters/100)/10} km of ${mission.origin.label||'your selected location'}.`);
    await transition(mission,'EXECUTING','Retrieving nearby places from the configured Places API.');
    trace(mission,'tool','Nearby places search started',`Searching for ${query} within ${radiusMeters} m of verified coordinates.`,{tool:'search_nearby_places',source:mission.origin.source||'Authorized location',result:{latitude:center.latitude,longitude:center.longitude,radiusMeters}});
    const output=await bounded(adapters.searchNearbyPlaces({query,location:center,radiusMeters,limit:20}));
    if(!output||typeof output.source!=='string'||!Number.isFinite(Date.parse(output.observedAt))||!Array.isArray(output.places))throw new Error('The Places API returned an invalid or unverifiable nearby search response.');
    const places=output.places.flatMap(place=>{
      const point=validPoint(place.location);if(!point)return[];
      const distance=distanceMeters(center,point);if(distance>radiusMeters)return[];
      return [{...place,location:point,distanceMeters:Math.round(distance)}];
    }).sort((a,b)=>a.distanceMeters-b.distanceMeters).slice(0,20);
    mission.result={...output,center,radiusMeters,places};
    await transition(mission,'VERIFYING','Verifying place coordinates, requested radius, and distances.');
    const event={id:randomUUID(),type:'nearby_places',at:Date.parse(output.observedAt),source:output.source,evidenceKind:'observed',value:{query,center,radiusMeters,placeCount:places.length}};
    mission.observations.push(event);
    try{await bounded(graph.seed(mission));}catch(error){trace(mission,'error','Nearby results graph update unavailable',String(error.message||error),{source:'FalkorDB',status:'UNKNOWN'});}
    const receipt={id:randomUUID(),tool:'search_nearby_places',status:'VERIFIED',at:stamp(),summary:`Places API returned ${places.length} verified result${places.length===1?'':'s'} within ${radiusMeters} m.`,revision:mission.revision,verification:{source:output.source,observationId:event.id,evidenceKind:'observed'}};
    mission.receipts.push(receipt);
    await transition(mission,'RESOLVED',places.length?`Found ${places.length} real ${query} result${places.length===1?'':'s'} within ${Math.round(radiusMeters/100)/10} km of ${mission.origin.label||'your selected location'}, sorted by distance.`:`No ${query} were returned within ${Math.round(radiusMeters/100)/10} km. Try a wider radius or another place category.`);
  }
  async function performRead(mission,bounded){
    let output;
    if(mission.kind==='calendar_read'){
      if(!adapters.getCalendarEvents)throw new Error('Connect a calendar with read permission to answer this request.');
    }else{
      if(!mission.destination&&mission.intent.destinationQuery){const places=await bounded(adapters.searchPlaces({query:mission.intent.destinationQuery}));const place=resolvedPlace(places,'weather location');if(place?.location)mission.destination={...place.location,label:place.displayName?.text||mission.intent.destinationQuery,source:places.source};}
      const place=mission.destination||mission.origin;
      if(!place)throw new Error('Specify a weather location or share your current position.');
    }
    await transition(mission,'PLANNING','Selecting the authorized source for the requested information.');
    if(mission.kind==='weather'&&!adapters.getWeather)throw new Error('Connect a weather source to answer this request.');
    await transition(mission,'EXECUTING',mission.kind==='weather'?'Reading current weather from the connected source.':'Reading events from the authorized calendar.');
    trace(mission,'tool',mission.kind==='weather'?'Weather source read started':'Calendar source read started','MOVA is requesting current information from the selected connected source.',{tool:mission.kind==='weather'?'get_weather':'get_calendar_events'});
    await persist();
    output=mission.kind==='calendar_read'
      ?await bounded(adapters.getCalendarEvents({timeMin:stamp(),timeMax:mission.deadline,maxResults:10}))
      :await bounded(adapters.getWeather(mission.destination||mission.origin));
    await transition(mission,'VERIFYING','Checking the source response and its evidence before presenting a result.');
    trace(mission,'tool',mission.kind==='weather'?'Weather source returned':'Calendar source returned','The connected source returned data for verification.',{tool:mission.kind==='weather'?'get_weather':'get_calendar_events',source:output?.source});
    await persist();
    if(!output||!output.source||!output.observedAt)throw new Error('The connector did not return verifiable source evidence.');
    mission.result=output;
    const event={id:randomUUID(),type:mission.kind==='weather'?'weather':'calendar',at:Date.parse(output.observedAt),source:output.source,evidenceKind:output.evidenceKind||'observed',value:output};
    if(!Number.isFinite(event.at))throw new Error('The connector returned an invalid evidence timestamp.');
    mission.observations.push(event);await bounded(graph.seed(mission));
    const receipt={id:randomUUID(),tool:mission.kind==='weather'?'get_weather':'get_calendar_events',status:'VERIFIED',at:stamp(),summary:'Authorized source read completed.',revision:mission.revision,verification:{source:output.source,observationId:event.id,evidenceKind:event.evidenceKind}};
    mission.receipts.push(receipt);await bounded(graph.recordAction(mission,receipt));await bounded(refreshGraph(mission));
    await transition(mission,'RESOLVED',mission.kind==='weather'?'Current weather retrieved from the connected source.':'Calendar events retrieved from your authorized account.');
  }
  async function resolveArrival(mission,event) {
    const at=new Date(event.at).getTime();
    const protectedDeadline=new Date(mission.deadline).getTime()-mission.constraints.bufferMinutes*60000;
    if(at>protectedDeadline){await transition(mission,'BLOCKED','Arrival was observed after the protected deadline. The original outcome was not achieved.');return;}
    if(!Number.isFinite(at)||Math.abs(Date.now()-at)>120000){await transition(mission,'UNKNOWN','Arrival evidence is not fresh enough to verify this outcome.');return;}
    const receipt={id:randomUUID(),tool:'verify_mission_outcome',status:'VERIFIED',at:stamp(),summary:'Fresh device location is within the arrival area before the protected deadline.',verification:{source:event.source,evidenceKind:event.evidenceKind,observationId:event.id,at:event.at,criterion:mission.successCriteria},revision:mission.revision};
    mission.receipts.push(receipt);
    await graph.recordAction(mission,receipt);
    await transition(mission,'RESOLVED','Arrival verified from fresh location evidence. Boarding and security clearance are not verified.');
    await refreshGraph(mission);await persist();
  }
  return {getState,
    hasMentionEvent(eventId){return (typeof eventId==='string'&&state.missions.some(mission=>mission.trigger?.eventId===eventId))||Boolean(state.archivedMissions?.some(mission=>mission.trigger?.eventId===eventId));},
    updateWorkContext(id,text){return serialize(async()=>{
      const mission=find(id);if(mission.kind!=='work')throw errorWithStatus('Context updates require a work mission.');
      if(typeof text!=='string'||!text.trim()||text.length>2000)throw errorWithStatus('Provide a context update between 1 and 2000 characters.');
      const value=text.trim(),normalize=input=>input.replace(/\s+/g,' ').toLocaleLowerCase();
      mission.contextUpdates||=[];
      if(mission.contextUpdates.some(item=>normalize(item.text)===normalize(value))){
        delete mission.inputRequest;trace(mission,'decision','Repeated clarification ignored','This same instruction was already applied to this investigation. Keeping its existing evidence and plan.');
        await persist();return getState();
      }
      mission.originalGoal||=mission.goal;mission.contextUpdates.push({text:value,at:stamp()});
      mission.goal=`Original objective: ${mission.originalGoal}\nUpdates (oldest to newest):\n${mission.contextUpdates.slice(-8).map(item=>item.text).join('\n')}`;
      mission.clarificationCount=Math.max(Number(mission.clarificationCount||0),1);
      mission.revision++;delete mission.inputRequest;mission.work||={steps:[],evidence:[],artifacts:[],proposals:[]};
      mission.work.evidence=mission.work.evidence.map(e=>({...e,stale:true}));mission.work.artifacts=mission.work.artifacts.map(a=>({...a,stale:true}));
      mission.work.proposals=(mission.work.proposals||[]).map(item=>item.status==='PENDING_APPROVAL'?{...item,status:'STALE',resolvedAt:stamp()}:item);
      mission.work.steps=[];delete mission.work.synthesis;delete mission.work.answer;delete mission.work.completedAt;
      await transition(mission,'REPLANNING','The updated context requires fresh evidence and a revised tool plan.');await investigate(mission);return getState();
    });},
    resolveWorkProposal(id,proposalId,revision,outcome){return serialize(async()=>{
      const mission=find(id);if(mission.kind!=='work')throw errorWithStatus('Action proposals require a connected-data mission.',409);
      if(!['approve','reject'].includes(outcome))throw errorWithStatus('Choose approve or reject.',400);
      let result;
      try{result=await approveWorkProposal({mission,proposalId,revision,reject:outcome==='reject',execute:proposal=>workTools.executeProposal(proposal)});}
      catch(error){trace(mission,'error','Approved action needs attention','The connected service did not confirm the requested action.',{tool:'approved_external_action',status:'UNKNOWN'});await workGraph.sync(mission);mission.graph=await workGraph.snapshot(mission);await persist();throw error;}
      const proposal=mission.work.proposals.find(item=>item.id===proposalId);
      const summary=outcome==='reject'?'You rejected the proposed external action. Nothing was sent.':result.status==='VERIFIED'?`Approved ${proposal.service} action completed and was confirmed by the connector.`:'The approved action did not return a confirmed result.';
      mission.receipts.push({id:randomUUID(),tool:`${proposal.service}_${proposal.operation}`,status:result.status,at:stamp(),summary,revision,verification:{proposalId,source:result.source||null,remoteId:result.remoteId||null,url:result.url||null}});
      if(outcome==='approve'&&result.status==='VERIFIED'){
        const step=mission.work.steps.find(item=>item.id===proposal.stepId);
        const evidenceId=`e-${revision}-approved-${proposal.id}`;
        if(step&&!mission.work.evidence.some(item=>item.id===evidenceId)){
          const issueNumber=proposal.operation==='create_issue'?(Number(result.remoteId||0)||Number(String(result.url||'').match(/\/issues\/(\d+)/)?.[1])||undefined):undefined;
          mission.work.evidence.push({id:evidenceId,stepId:step.id,title:`${proposal.operation.replaceAll('_',' ')} verified`,...(issueNumber?{issueNumber}:{}),...(proposal.repository?{repository:proposal.repository}:{}),...(result.url?{url:result.url}:{}),source:result.source||`${proposal.service} action receipt`,observedAt:Number.isFinite(Date.parse(result.observedAt))?new Date(result.observedAt).toISOString():stamp(),evidenceKind:'observed',summary:`The user-approved ${proposal.operation.replaceAll('_',' ')} was confirmed by ${proposal.service}.${result.remoteId?` Remote ID: ${result.remoteId}.`:''}${result.url?` Receipt: ${result.url}`:''}`,stale:false});
        }
      }
      if(outcome==='approve'&&result.status==='VERIFIED'&&mission.operationalContext?.reportId&&operationsGraph){
        if(proposal.operation==='create_issue'){
          const issueNumber=Number(result.remoteId||0)||Number(String(result.url||'').match(/\/issues\/(\d+)/)?.[1]);
          await operationsGraph.recordIssueReceipt({reportId:mission.operationalContext.reportId,repository:proposal.repository,issueNumber,url:result.url,idempotencyKey:`incident:${mission.operationalContext.reportId}:issue`});
          for(const pending of mission.work.proposals.filter(item=>item.status==='PENDING_APPROVAL'&&item.service==='discord'&&item.operation==='post_channel_message')){
            if(result.url&&!pending.text?.includes(result.url))pending.text=`${pending.text}\n\nTracked in GitHub: ${result.url}`;
          }
        }
        if(proposal.service==='discord'&&proposal.operation==='post_channel_message')await operationsGraph.recordNotificationReceipt({reportId:mission.operationalContext.reportId,id:`incident:${mission.operationalContext.reportId}:discord`,url:result.url||`discord:${result.remoteId||''}`});
      }
      trace(mission,outcome==='reject'?'decision':'action',outcome==='reject'?'Action proposal rejected':'Approved action completed',summary,{tool:`${proposal.service}_${proposal.operation}`,status:result.status,source:result.source});
      const work=mission.work;
      const hasPendingProposals=work?.proposals?.some(item=>item.status==='PENDING_APPROVAL');
      const hasBlockedSteps=work?.steps?.some(step=>step.status==='blocked');
      if(outcome==='approve'&&result.status==='VERIFIED'&&!hasPendingProposals&&hasBlockedSteps){
        delete work.synthesis;delete work.answer;delete work.completedAt;
        await workGraph.sync(mission);mission.graph=await workGraph.snapshot(mission);await persist();
        await investigate(mission);
        return getState();
      }
      await workGraph.sync(mission);mission.graph=await workGraph.snapshot(mission);
      // A pending approval is a valid reason for runWorkMission to finish in
      // BLOCKED. Once the user resolves that proposal, clear the stale blocker
      // when every work step and remaining proposal is otherwise complete.
      const hasUnresolvedWork=work?.steps?.some(step=>['pending','running','failed','blocked'].includes(step.status))
        ||work?.proposals?.some(item=>item.status==='PENDING_APPROVAL');
      if(!hasUnresolvedWork&&work?.answer){
        await transition(mission,'RESOLVED',outcome==='reject'
          ?'The verified result is complete. The proposed external action was rejected and was not sent.'
          :'The verified result and approved external action are complete.');
        await workGraph.sync(mission);mission.graph=await workGraph.snapshot(mission);await persist();
      }else await persist();
      return getState();
    });},
    selectMission(id){return serialize(async()=>{find(id);await persist();return getState();});},
    async init(){state=await store.load();state.missions||=[];state.archivedMissions||=[];const savedCurrentId=state.currentId;const retired=state.missions.filter(m=>m.mode!=='live');state.archivedMissions.push(...retired);state.missions=state.missions.filter(m=>m.mode==='live');state.currentId=state.missions.some(m=>m.id===savedCurrentId)?savedCurrentId:null;await graph.init();for(const mission of state.missions){mission.kind||=mission.intent?.kind||'travel';
      if(mission.kind==='pending'&&['MISSION_CREATED','INVESTIGATING'].includes(mission.state)){mission.state='BLOCKED';mission.summary='MOVA was interrupted while interpreting this request. Retry to resume; no investigation result was recorded.';mission.agentStatus='blocked';trace(mission,'state','Request interpretation interrupted',mission.summary);}
      else if(mission.kind==='work'&&['INVESTIGATING','BUILDING_CONTEXT','PLANNING','REPLANNING','EXECUTING','VERIFYING'].includes(mission.state)){mission.state='BLOCKED';mission.summary='The investigation was interrupted before completion. Resume to continue from its saved evidence.';mission.agentStatus='blocked';for(const step of mission.work?.steps||[])if(step.status==='running')step.status='pending';trace(mission,'state','Work investigation recovered after restart',mission.summary);}
      else if(mission.state==='EXECUTING'){mission.state='UNKNOWN';mission.summary='An action was interrupted. Its effect must be reconciled before retrying.';for(const receipt of mission.receipts)if(receipt.status==='PENDING')receipt.status='UNKNOWN';}
    }await persist();return getState();},
    createMission(input,{background=false}={}){return serialize(async()=>{
      if(!input||typeof input.text!=='string'||!input.text.trim()||input.text.length>2000)throw errorWithStatus('Enter a mission between 1 and 2000 characters.');
      if(input.mode!=null&&input.mode!=='live')throw errorWithStatus('Only live missions are supported.');
      const minutes=Number(input.deadlineMinutes??90);
      if(!Number.isFinite(minutes)||minutes<=0||minutes>1440)throw errorWithStatus('Deadline must be between 1 and 1440 minutes.');
      const budget=input.maxCost==null||input.maxCost===''?null:Number(input.maxCost);
      if(budget!=null&&(!Number.isFinite(budget)||budget<0))throw errorWithStatus('Budget must be a non-negative number.');
      const trigger=input.trigger&&typeof input.trigger==='object'?{service:String(input.trigger.service||'').slice(0,100),source:String(input.trigger.source||'').slice(0,300),channelId:input.trigger.channelId?String(input.trigger.channelId).slice(0,100):null,repository:input.trigger.repository?String(input.trigger.repository).slice(0,200):null,issueNumber:Number.isInteger(input.trigger.issueNumber)?input.trigger.issueNumber:null,eventId:String(input.trigger.eventId||'').slice(0,200),authorId:String(input.trigger.authorId||'').slice(0,200),content:String(input.trigger.content||'').slice(0,4000),observedAt:input.trigger.observedAt&&Number.isFinite(Date.parse(input.trigger.observedAt))?new Date(input.trigger.observedAt).toISOString():stamp()}:null;
      if(trigger&&(!trigger.service||!trigger.source||!trigger.eventId))throw errorWithStatus('Invalid connected mention event.',400);
      if(trigger&&[...state.missions,...state.archivedMissions].some(mission=>mission.trigger?.eventId===trigger.eventId))return getState();
      const suppliedContext=input.operationalContext&&typeof input.operationalContext==='object'?structuredClone(input.operationalContext):null;
      const operationalContext=suppliedContext;
      const incidentIntent=input.workflow||operationalContext?.channelId&&operationalContext?.repository?{kind:'work',goal:input.text.trim(),destinationQuery:'',summary:'Connected workflow selected.',successCriteria:'Complete the selected workflow using connected evidence.'}:null;
      const mission={...(input.workflow?{workflow:structuredClone(input.workflow)}:{}),id:randomUUID(),title:input.text.trim().slice(0,80),goal:input.text.trim(),state:'DETECTED',mode:'live',kind:incidentIntent?'work':'pending',revision:0,createdAt:stamp(),deadlineExplicit:input.deadlineMinutes!=null,deadline:new Date(Date.now()+minutes*60000).toISOString(),successCriteria:incidentIntent?.successCriteria||'Identify the requested outcome and verify it against a connected source.',summary:'Mission detected',agentStatus:'detected',selectedPlanId:null,plans:[],graph:{nodes:[],edges:[],backend:'unavailable'},trace:[],receipts:[],observations:[],constraints:{bufferMinutes:15,maxCost:budget},origin:input.origin||location,destination:input.destination||null,...(incidentIntent?{intent:incidentIntent,operationalContext}:{}),...(trigger?{trigger}:{})};
      state.missions.push(mission);state.currentId=mission.id;
      trace(mission,'event','Mission created',mission.goal,{source:trigger?trigger.source:'User',evidenceKind:trigger?'observed':'user-provided'});
      await transition(mission,'MISSION_CREATED','Compiling the mission constraints and authorized sources.');
      if(background){
        setImmediate(()=>{void investigate(mission).catch(error=>console.error(`MOVA background investigation ${mission.id} failed:`,error));});
        return getState();
      }
      await investigate(mission);return getState();
    });},
    approve(id,revision){return serialize(async()=>{
      const mission=find(id);
      if(revision!==mission.revision)throw errorWithStatus('The plan changed. Review the current revision before approving.',409);
      const key=`${mission.id}:${mission.revision}:open_navigation`;
      if(mission.receipts.some(r=>r.idempotencyKey===key))return getState();
      if(mission.state!=='AWAITING_APPROVAL')throw errorWithStatus('This mission is not awaiting approval.',409);
      if(mission.needsRouteRefresh){mission.plans=[];mission.revision++;await investigate(mission);throw errorWithStatus('Your location changed. Review the route refreshed from your current position.',409);}
      const plan=mission.plans.find(p=>p.id===mission.selectedPlanId&&p.feasible);
      if(!plan)throw errorWithStatus('No feasible plan is selected.',409);
      // Re-read constraints immediately before the side effect; a deadline can expire while waiting.
      const checked=await graph.evaluate(mission);
      if(!checked.plans.some(p=>p.id===plan.id&&p.feasible)){mission.revision++;await investigate(mission);throw errorWithStatus('The plan is no longer feasible. Review the updated mission.',409);}
      await graph.recordApproval(mission,{revision:mission.revision,planId:plan.id,at:stamp()});
      const args={destination:mission.destination,plan,idempotencyKey:key};
      const receipt={id:randomUUID(),tool:'open_navigation',status:'PENDING',at:stamp(),summary:'Preparing in-app directions.',idempotencyKey:key,argumentHash:createHash('sha256').update(JSON.stringify(args)).digest('hex'),revision:mission.revision};
      mission.receipts.push(receipt);
      await transition(mission,'EXECUTING','Preparing the approved navigation route.');
      try {
        const result=await adapters.openNavigation(args);
        Object.assign(receipt,result,{id:receipt.id,tool:'open_navigation',status:result.status==='FAILED'?'FAILED':'UNVERIFIED',verification:'Navigation preparation is not independent evidence of destination arrival.'});
        await persist();await graph.recordAction(mission,receipt);
        trace(mission,'action','In-app directions prepared',receipt.summary,{tool:'open_navigation',status:receipt.status,source:'Action adapter'});
        await transition(mission,receipt.status==='FAILED'?'FAILED_RETRYABLE':'VERIFYING',receipt.status==='FAILED'?'The in-app guidance failed. Review the receipt before replanning.':'Navigation is ready. I am waiting for actual arrival evidence; your mission is not complete.');
      }catch(e){receipt.status='UNKNOWN';receipt.summary=e.message;await transition(mission,'UNKNOWN','The action result is uncertain. I will not repeat it automatically.');}
      await refreshGraph(mission);await persist();return getState();
    });},
    resume(id){return serialize(async()=>{const mission=find(id);if(['RESOLVED','VERIFYING','UNKNOWN'].includes(mission.state))return getState();await investigate(mission);return getState();});},
    observeRoutes(id){
      if(routePolls.has(id))return routePolls.get(id);
      const work=serialize(async()=>{
        const mission=find(id,false);
        if(mission.kind!=='travel')throw errorWithStatus('Route observation requires a travel mission.',400);
        if(!['VERIFYING','AWAITING_APPROVAL','BLOCKED'].includes(mission.state))return getState();
        if(Date.now()-(mission.lastRouteObservation||0)<60000)return getState();
        mission.lastRouteObservation=Date.now();await persist();
        const previous=mission.plans,previousState=mission.state,selectedId=mission.selectedPlanId;
        try{
          if(!mission.origin||!mission.destination)throw new Error('Route observation needs current location and a resolved destination.');
          const routes=await withBudget(adapters.calculateRoutes({origin:mission.origin,destination:mission.destination,deadline:mission.deadline,maxCost:mission.constraints.maxCost}),Date.now()+20000);
          mission.plans=Array.isArray(routes)?routes:routes.routes||[];
          mission.needsRouteRefresh=false;
          const observations=[];
          for(const plan of mission.plans){const old=previous.find(p=>p.id===plan.id);if(old&&old.durationMinutes!==plan.durationMinutes)observations.push({id:randomUUID(),type:'route_update',at:Date.parse(plan.observedAt),source:plan.source,evidenceKind:'calculated_estimate',value:{planId:plan.id,durationMinutes:plan.durationMinutes,previousDurationMinutes:old.durationMinutes}});}
          mission.observations.push(...observations);
          await graph.seed(mission);
          for(const event of observations)await captureImpact(mission,event);
          const evaluation=await graph.evaluate(mission);recordEvaluation(mission,evaluation);
          trace(mission,'source','Visible mission route observation',`Refreshed ${mission.plans.length} route estimates. Source capabilities determine whether traffic is included.`,{tool:'calculate_routes',source:mission.plans[0]?.source||'Configured route adapter'});
          const stillFeasible=mission.plans.some(p=>p.id===selectedId&&p.feasible);
          if(!stillFeasible){mission.revision++;mission.selectedPlanId=null;await transition(mission,'REPLANNING','New route evidence no longer supports the selected plan. Finding a feasible alternative.');await investigate(mission);}
          else{
            if(previousState==='AWAITING_APPROVAL'&&observations.length)mission.revision++;
            await graph.recordDecision(mission);await refreshGraph(mission);await persist();
          }
        }catch(error){trace(mission,'error','Route observation unavailable',error.message,{source:'Configured route adapter',status:'UNKNOWN'});await persist();}
        return getState();
      });
      routePolls.set(id,work);work.finally(()=>routePolls.delete(id)).catch(()=>{});return work;
    },
    acknowledge(id,input){return serialize(async()=>{
      const mission=find(id);
      if(mission.state==='RESOLVED')throw errorWithStatus('This mission is resolved.',409);
      const receipt=mission.receipts.find(r=>r.id===input.receiptId);
      if(!receipt)throw errorWithStatus('Receipt not found',404);
      if(receipt.tool!=='open_navigation')throw errorWithStatus('Only in-app guidances can be acknowledged.',409);
      if(receipt.revision!==mission.revision)throw errorWithStatus('This receipt belongs to a stale revision. Review and approve the current plan.',409);
      if(mission.state!=='VERIFYING'||receipt.status!=='UNVERIFIED')throw errorWithStatus('The current mission phase does not permit this navigation acknowledgement.',409);
      if(!['opened','failed'].includes(input.outcome))throw errorWithStatus('Invalid handoff outcome');
      receipt.status=input.outcome==='failed'?'FAILED':'UNVERIFIED';
      receipt.verification=`Browser reports ${input.outcome}; destination arrival remains unverified.`;
      trace(mission,'verification','Handoff report received',receipt.verification,{tool:receipt.tool,status:receipt.status,source:'Browser acknowledgement'});
      await graph.recordAction(mission,receipt);
      await transition(mission,input.outcome==='failed'?'FAILED_RETRYABLE':'VERIFYING',receipt.verification);
      await refreshGraph(mission);await persist();return getState();
    });},
    setLocation(input){return serialize(async()=>{
      if(!Number.isFinite(input.latitude)||Math.abs(input.latitude)>90||!Number.isFinite(input.longitude)||Math.abs(input.longitude)>180)throw errorWithStatus('Invalid geographic coordinates');
      const timestamp=typeof input.timestamp==='number'?input.timestamp:Date.parse(input.timestamp);
      if(!Number.isFinite(timestamp))throw errorWithStatus('Location requires a valid source timestamp.');
      if(timestamp>Date.now()+5000||Date.now()-timestamp>120000)throw errorWithStatus('Location timestamp is stale or in the future; a fresh position is required.');
      location={latitude:input.latitude,longitude:input.longitude,accuracy:Number.isFinite(input.accuracy)?input.accuracy:null,timestamp,observedAt:new Date(timestamp).toISOString(),source:typeof input.source==='string'?input.source.slice(0,200):'Authorized device geolocation',evidenceKind:input.evidenceKind||'observed',...(input.deviceId!=null?{deviceId:input.deviceId}:{}),...(input.positionId!=null?{positionId:input.positionId}:{})};
      const mission=current();
      let awayFromNamedRoute=false;
      if(mission&&mission.kind==='travel'){
        mission.deviceLocation=location;
        const distance=distanceToRoute(location,mission);
        awayFromNamedRoute=Boolean(mission.intent?.originQuery&&mission.state==='VERIFYING'&&distance>1000);
        mission.routePositionStatus=distance<=1000?'near':'away';
        if(awayFromNamedRoute){
          mission.summary='The device position is away from the requested route. The named starting place is retained; route progress is not confirmed.';
          if(mission.locationMismatchRevision!==mission.revision){trace(mission,'source','Device position differs from requested route',mission.summary,{source:location.source,evidenceKind:location.evidenceKind});mission.locationMismatchRevision=mission.revision;}
        }
      }
      if(mission&&mission.kind==='travel'&&mission.state!=='RESOLVED'&&(!mission.intent?.originQuery||(mission.state==='VERIFYING'&&!awayFromNamedRoute))){
        const old=mission.origin;
        mission.origin=location;
        if(!old||Math.abs(old.latitude-input.latitude)+Math.abs(old.longitude-input.longitude)>.001){
          mission.needsRouteRefresh=true;
          const event={id:`location-${mission.id}`,type:'location',at:timestamp,source:location.source,evidenceKind:location.evidenceKind,value:location};
          const existing=mission.observations.findIndex(o=>o.id===event.id);
          if(existing>=0)mission.observations[existing]=event;else if(mission.observations.length<24)mission.observations.push(event);
          if(existing>=0||mission.observations.some(o=>o.id===event.id)){
            try{await graph.seed(mission);await captureImpact(mission,event);await refreshGraph(mission);}
            catch(error){trace(mission,'error','Position graph update unavailable',error.message,{source:location.source,status:'UNKNOWN'});}
          }
        }
      }
      if(mission&&mission.kind==='travel'&&mission.state==='VERIFYING'&&mission.destination?.latitude!=null){
        const rad=n=>n*Math.PI/180;
        const dest=mission.destination;
        const distance=6371000*2*Math.asin(Math.sqrt(Math.sin(rad(dest.latitude-input.latitude)/2)**2+Math.cos(rad(input.latitude))*Math.cos(rad(dest.latitude))*Math.sin(rad(dest.longitude-input.longitude)/2)**2));
        if(distance<=500&&location.accuracy>0&&location.accuracy<=100&&location.evidenceKind==='observed'){const event={id:randomUUID(),type:'arrival',at:timestamp,source:location.source,evidenceKind:location.evidenceKind,value:{distance,accuracy:location.accuracy,deviceId:location.deviceId??null,positionId:location.positionId??null}};mission.observations.push(event);await graph.seed(mission);await captureImpact(mission,event);await resolveArrival(mission,event);}
        else if(distance<=500&&!(location.accuracy>0&&location.accuracy<=100)){mission.summary='A position is near the destination, but its accuracy is unknown or insufficient. Arrival remains unverified.';}
      }
      await persist();return getState();
    });},
  };
}
