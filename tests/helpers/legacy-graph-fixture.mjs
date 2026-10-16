const CANDIDATE_QUERY = `MATCH (p:Item {type:'RouteOption', active:true})
OPTIONAL MATCH path=(p)-[:USES|DEPENDS_ON*1..3]->(d:Item)
OPTIONAL MATCH (o:Item {type:'Observation'})-[:AFFECTS]->(d)
WHERE o.active = true AND o.blocked = true
RETURN p.id AS planId, collect(DISTINCT o.id) AS blockers,
collect(DISTINCT d.id) AS dependencies LIMIT 100`;
const IMPACT_QUERY=`MATCH path=(o:Item {id:$eventId})-[:AFFECTS]->(d:Item)<-[:DEPENDS_ON|USES*1..3]-(p:Item {type:'RouteOption',active:true})<-[:CONSIDERS]-(m:Item {id:$missionId})
WHERE o.active=true
RETURN [n IN nodes(path) | n.id] AS nodeIds, [r IN relationships(path) | r.id] AS edgeIds LIMIT 100`;
const DEPENDENCY_QUERY=`MATCH path=(m:Item {id:$missionId})-[:CONSIDERS|CONSTRAINS|USES|DEPENDS_ON*1..4]->(d:Item)
WHERE all(n IN nodes(path) WHERE n.type <> 'RouteOption' OR n.active=true)
RETURN [n IN nodes(path) | n.id] AS nodeIds, [r IN relationships(path) | r.id] AS edgeIds LIMIT 100`;

export function demoPlans() {
  const source = 'Demo route fixture · not live traffic';
  const observedAt = new Date().toISOString();
  return [
    { id:'expressway', name:'Airport expressway', mode:'DRIVE', durationMinutes:45, cost:650, reliability:.88, coordinates:[[77.2167,28.6315],[77.197,28.621],[77.165,28.604],[77.126,28.564],[77.085,28.556],[77.101,28.5562]], source, observedAt },
    { id:'metro', name:'Airport Express metro', mode:'TRANSIT', durationMinutes:54, cost:60, reliability:.96, coordinates:[[77.2167,28.6315],[77.22,28.643],[77.19,28.637],[77.145,28.603],[77.12,28.58],[77.101,28.5562]], source, observedAt },
    { id:'ring-road', name:'Ring Road alternative', mode:'DRIVE', durationMinutes:68, cost:820, reliability:.8, coordinates:[[77.2167,28.6315],[77.235,28.611],[77.208,28.576],[77.159,28.552],[77.123,28.545],[77.101,28.5562]], source, observedAt },
  ];
}

export function createGraph({ url = process.env.FALKORDB_URL || '' } = {}) {
  let client;
  let error;
  const local = new Map();
  const status = () => ({ connected: Boolean(client), backend: client ? 'falkordb' : 'simulator', detail: client ? 'FalkorDB connected · bounded graph queries' : error || 'FalkorDB is not configured; simulator is demo-only' });
  const name = mission => `mova_mission_${mission.id}`;
  const requireGraph = mission => {
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(mission.id))throw new Error('Invalid mission graph identifier');
    if (!client && mission.mode !== 'demo') throw new Error('FalkorDB is unavailable. Live missions cannot use the simulator.');
  };
  const graphFor = mission => client.selectGraph(name(mission));
  const query = async (mission, q, params = {}, write = false) => {
    requireGraph(mission);
    if (!client) return null;
    return graphFor(mission)[write ? 'query' : 'roQuery'](q, { params, TIMEOUT: 1000 });
  };
  async function putNode(mission,node) {
    local.get(mission.id).nodes.set(node.id, node);
    await query(mission, `MERGE (n:Item {id:$id}) SET n.type=$type, n.label=$label, n.payload=$payload, n.active=$active, n.blocked=$blocked`, { id:node.id, type:node.type, label:node.label, payload:JSON.stringify(node), active:node.properties?.active ?? node.type==='RouteOption', blocked:node.properties?.blocked ?? false }, true);
  }
  const relationships = new Set(['TARGETS','CONSTRAINS','CONSIDERS','USES','DEPENDS_ON','AFFECTS','EXECUTED','VERIFIED_BY','SUPPORTED_BY','SELECTS']);
  async function putEdge(mission, edge) {
    if (!relationships.has(edge.label)) throw new Error('Unsupported graph relationship');
    local.get(mission.id).edges.set(edge.id, edge);
    await query(mission, `MATCH (a:Item {id:$from}), (b:Item {id:$to}) MERGE (a)-[r:${edge.label} {id:$id}]->(b) SET r.payload=$payload`, {from:edge.source,to:edge.target,id:edge.id,payload:JSON.stringify(edge)},true);
  }
  const baseNode = (id,label,type,source,evidenceKind,properties={}) => ({id,label,type,status:'healthy',source,evidenceKind,observedAt:new Date().toISOString(),properties});
  const baseEdge = (source,target,label,provenance,evidenceKind='calculated') => ({id:`${source}:${label}:${target}`,source,target,label,status:'healthy',provenance,evidenceKind,observedAt:new Date().toISOString(),explanation:`${source} ${label.toLowerCase().replaceAll('_',' ')} ${target}`});

  async function seed(mission) {
    requireGraph(mission);
    if(mission.plans.length>12||(mission.observations||[]).length>25||(mission.receipts||[]).length>30)throw new Error('Mission graph budget reached (12 routes, 25 observations, 30 receipts). Start a new mission.');
    local.set(mission.id,{nodes:new Map(),edges:new Map()});
    if (client) {
      const indexes = await query(mission,'CALL db.indexes()',{},true);
      if (!indexes?.data?.length) await query(mission,'CREATE INDEX FOR (n:Item) ON (n.id)',{},true);
      await query(mission,"MATCH (n:Item {type:'RouteOption'}) SET n.active=false",{},true);
    }
    const kind = mission.mode === 'demo' ? 'simulated' : 'observed';
    await putNode(mission,baseNode('mission',mission.title,'Mission','User mission','user-provided',{deadline:mission.deadline}));
    await putNode(mission,baseNode('airport',mission.destination?.label||(mission.mode==='demo'?'Delhi Airport · Terminal 3':'Mission destination'),'Place',mission.mode === 'demo' ? 'Demo fixture' : mission.destination?.source||'User destination',kind,mission.destination||{}));
    await putNode(mission,baseNode('deadline','Arrival deadline','Constraint','User mission','user-provided',{deadline:mission.deadline,bufferMinutes:mission.constraints.bufferMinutes}));
    await putEdge(mission,baseEdge('mission','airport','TARGETS','User mission'));
    await putEdge(mission,baseEdge('mission','deadline','CONSTRAINS','User mission'));
    if(mission.origin){await putNode(mission,{...baseNode('origin','Current position','Place',mission.origin.source||'User location',mission.origin.evidenceKind||'user-provided',mission.origin),observedAt:mission.origin.observedAt||(mission.origin.timestamp?new Date(mission.origin.timestamp).toISOString():null)});}
    for (const plan of mission.plans) {
      await putNode(mission,{...baseNode(plan.id,plan.name,'RouteOption',plan.source,mission.mode==='demo'?kind:'calculated_estimate',{durationMinutes:plan.durationMinutes,cost:plan.cost,trafficDelaySeconds:plan.trafficDelaySeconds??null,noTrafficDurationSeconds:plan.noTrafficDurationSeconds??null,liveTrafficDurationSeconds:plan.liveTrafficDurationSeconds??null}),observedAt:plan.observedAt||null});
      await putEdge(mission,{...baseEdge('mission',plan.id,'CONSIDERS',plan.source,kind),observedAt:plan.observedAt||null});
      if(mission.origin)await putEdge(mission,{...baseEdge(plan.id,'origin','USES',mission.origin.source||'User location',mission.origin.evidenceKind||'user-provided'),observedAt:mission.origin.observedAt||null});
      // Google routes do not expose transit service health. Only the demo creates those fixtures.
      const service = mission.mode === 'demo' ? (plan.id === 'metro' ? 'metro-service' : plan.id === 'expressway' ? 'road-service' : 'ring-service') : `route-service-${plan.id}`;
      const segment = `${plan.id}-connection`;
      const dependencyKind=mission.mode==='demo'?kind:'inferred';
      await putNode(mission,{...baseNode(segment,plan.id === 'metro' ? 'New Delhi transfer' : `${plan.name} connection`,'Entity',plan.source,dependencyKind),observedAt:plan.observedAt||null});
      await putNode(mission,{...baseNode(service,service === 'metro-service' ? 'Airport Express service' : service === 'road-service' ? 'Expressway access' : service === 'ring-service' ? 'Ring Road access' : 'Route availability','Capability',plan.source,dependencyKind),observedAt:plan.observedAt||null});
      await putEdge(mission,{...baseEdge(plan.id,segment,'USES',plan.source,dependencyKind),observedAt:plan.observedAt||null});
      await putEdge(mission,{...baseEdge(segment,service,'DEPENDS_ON',plan.source,dependencyKind),observedAt:plan.observedAt||null});
    }
    for (const observation of mission.observations || []) await observe(mission,observation);
    for (const receipt of mission.receipts || []) await recordAction(mission,receipt);
    if (mission.selectedPlanId) await recordDecision(mission);
  }
  async function observe(mission,event) {
    requireGraph(mission);
    if((mission.observations||[]).length>25)throw new Error('Mission observation budget reached. Start a new mission.');
    if (!local.has(mission.id)) throw new Error('Mission graph must be seeded');
    if (event.type === 'clear') {
      for (const node of local.get(mission.id).nodes.values()) if (node.type === 'Observation') { node.properties.active = false; await putNode(mission,node); }
      await query(mission,`MATCH (o:Item {type:'Observation'}) SET o.active=false`,{},true);
    }
    const routeUpdate=event.type==='route_update';
    if(routeUpdate){
      if(!mission.plans.some(p=>p.id===event.value?.planId)||!Number.isFinite(event.value?.durationMinutes)||event.value.durationMinutes<=0)throw new Error('Invalid route update evidence');
      for(const existing of local.get(mission.id).nodes.values())if(existing.type==='Observation'&&existing.properties.kind==='route_update'&&existing.properties.value?.planId===event.value.planId){existing.properties.active=false;await putNode(mission,existing);}
    }
    const availableMinutes=(new Date(mission.deadline).getTime()-new Date(event.at).getTime())/60000-mission.constraints.bufferMinutes;
    const blocked = ['traffic','closure'].includes(event.type)||(routeUpdate&&event.value.durationMinutes>availableMinutes);
    const label=event.type==='traffic'?'Expressway traffic disruption':event.type==='arrival'?'Arrival observation':event.type==='location'?'Updated device position':event.type==='closure'?'Service closure':routeUpdate?'Updated route estimate':event.type==='weather'?'Weather evidence':event.type==='calendar'?'Calendar evidence':'Conditions cleared';
    const node = baseNode(event.id,label,'Observation',event.source,event.evidenceKind,{kind:event.type,active:true,blocked,value:event.value??null});
    node.observedAt = new Date(event.at).toISOString();
    node.status = blocked ? 'threatened' : 'healthy';
    await putNode(mission,node);
    const targets = event.type==='location'?['origin']:routeUpdate?[`route-service-${event.value.planId}`]:event.type === 'traffic' ? ['road-service'] : event.type === 'closure' ? (event.value === 'all' ? ['road-service','metro-service','ring-service'] : [event.value === 'ring-road' ? 'ring-service' : event.value === 'expressway' ? 'road-service' : 'metro-service']) : ['airport'];
    for (const target of targets) {
      const edge = baseEdge(event.id,target,'AFFECTS',event.source,event.evidenceKind);
      edge.status=blocked?'threatened':'healthy';
      edge.observedAt=node.observedAt;
      edge.explanation=routeUpdate?`Source estimates ${event.value.durationMinutes} minutes; ${Math.floor(availableMinutes)} minutes remain before protected arrival.`:blocked?'New evidence makes this connected dependency unavailable.':'Observation about mission destination or changed conditions.';
      await putEdge(mission,edge);
    }
  }
  async function evaluate(mission) {
    requireGraph(mission);
    if (!local.has(mission.id)) await seed(mission);
    let rows;
    if (client) rows = (await query(mission,CANDIDATE_QUERY)).data;
    else {
      const {nodes,edges}=local.get(mission.id);
      rows=mission.plans.map(plan=>{
        const dependencies=[];
        const visit=(id,depth)=>{if(depth>=3)return; for(const e of edges.values()) if(e.source===id && ['USES','DEPENDS_ON'].includes(e.label)){dependencies.push(e.target);visit(e.target,depth+1);}};
        visit(plan.id,0);
        const blockers=[...edges.values()].filter(e=>e.label==='AFFECTS'&&dependencies.includes(e.target)&&nodes.get(e.source)?.properties.active&&nodes.get(e.source)?.properties.blocked).map(e=>e.source);
        return {planId:plan.id,dependencies,blockers};
      });
    }
    const dependencyResult=await findDependencies(mission);
    const plans=mission.plans.map(plan=>{
      const row=rows?.find(r=>r.planId===plan.id);
      const blockers=(row?.blockers||[]).filter(Boolean);
      const remaining=(new Date(mission.deadline).getTime()-Date.now())/60000-mission.constraints.bufferMinutes;
      const slackMinutes=Math.floor(remaining-plan.durationMinutes);
      const budget=mission.constraints.maxCost;
      const age=Date.now()-Date.parse(plan.observedAt);
      const fresh=mission.mode==='demo'||(Number.isFinite(age)&&age>=-60000&&age<=300000);
      const feasible=fresh&&Boolean(row)&&blockers.length===0&&slackMinutes>=0&&(budget==null||(plan.cost!=null&&plan.cost<=budget));
      const reason=!fresh?'Route evidence is stale or missing; refresh the source':!row?'No connected graph evidence':blockers.length?'Connected dependency disrupted':slackMinutes<0?'Arrival would miss the protected deadline':budget!=null&&plan.cost==null?'Cost is unknown; budget cannot be verified':budget!=null&&plan.cost>budget?'Exceeds your budget':`${slackMinutes} min before the protected arrival deadline`;
      const decisionPaths=dependencyResult.paths.filter(p=>p.nodeIds.includes(plan.id)||p.nodeIds.includes('deadline'));
      const evidencePaths=(mission.impactPaths||[]).filter(p=>p.nodeIds.includes(plan.id));
      return {...plan,feasible,slackMinutes,reason,blockers,decisionPaths:[...decisionPaths,...evidencePaths],path:[...new Set([...decisionPaths,...evidencePaths].flatMap(p=>p.nodeIds))],score:feasible?slackMinutes+(plan.reliability||0)*10:-10000};
    }).sort((a,b)=>b.score-a.score);
    return {plans,paths:plans.map(p=>p.path),backend:client?'falkordb':'simulator',query:CANDIDATE_QUERY,params:{},source:client?'FalkorDB connected dependencies':'Explicit demo graph simulator'};
  }
  async function snapshot(mission) {
    requireGraph(mission);
    if (!local.has(mission.id)) await seed(mission);
    if (client) {
      const n=await query(mission,"MATCH (n:Item) WHERE n.type <> 'RouteOption' OR n.active=true RETURN n.payload AS payload LIMIT 100");
      const e=await query(mission,"MATCH (a)-[r]->(b) WHERE (a.type <> 'RouteOption' OR a.active=true) AND (b.type <> 'RouteOption' OR b.active=true) RETURN r.payload AS payload LIMIT 100");
      return {nodes:(n.data||[]).map(r=>JSON.parse(r.payload)),edges:(e.data||[]).map(r=>JSON.parse(r.payload)),backend:'falkordb'};
    }
    return {...Object.fromEntries(Object.entries(local.get(mission.id)).map(([key,map])=>[key,[...map.values()]])),backend:'simulator'};
  }
  async function recordAction(mission,receipt) {
    if(!local.has(mission.id))await seed(mission);
    const node=baseNode(receipt.id,receipt.tool,'ActionReceipt','Action executor','observed',{status:receipt.status,verification:receipt.verification||null});
    node.status=receipt.status==='VERIFIED'?'verified':'selected';
    await putNode(mission,node);
    await putEdge(mission,baseEdge('mission',receipt.id,'EXECUTED','Action ledger','observed'));
    if(receipt.verification?.observationId)await putEdge(mission,baseEdge(receipt.id,receipt.verification.observationId,'VERIFIED_BY',receipt.verification.source,receipt.verification.evidenceKind));
  }
  async function recordDecision(mission) {
    const working=local.get(mission.id);
    working.nodes.delete('decision');
    for(const [id,edge]of working.edges)if(edge.source==='decision'||edge.target==='decision')working.edges.delete(id);
    await query(mission,'MATCH (d:Item {id:$id}) DETACH DELETE d',{id:'decision'},true);
    const plan=mission.plans.find(p=>p.id===mission.selectedPlanId);
    if(!plan)return;
    const kind=mission.mode==='demo'?'simulated':'inferred';
    await putNode(mission,baseNode('decision',`Choose ${plan.name}`,'Decision',mission.mode==='demo'?'Demo selection policy':'Model choice over graph results',kind,{revision:mission.revision,planId:plan.id,reason:plan.reason}));
    await putEdge(mission,baseEdge('decision',plan.id,'SELECTS','Constraint-validated decision',kind));
    for(const id of ['deadline',...(plan.path||[])])await putEdge(mission,baseEdge('decision',id,'SUPPORTED_BY','Connected graph evidence',kind));
  }
  async function findDependencies(mission){
    requireGraph(mission);if(!local.has(mission.id))await seed(mission);
    const params={missionId:'mission'};
    let paths;
    if(client)paths=(await query(mission,DEPENDENCY_QUERY,params)).data||[];
    else{
      paths=[];const {edges}=local.get(mission.id);
      const walk=(nodeIds,edgeIds)=>{if(edgeIds.length>=4||paths.length>=100)return;for(const edge of edges.values())if(edge.source===nodeIds.at(-1)&&['CONSIDERS','CONSTRAINS','USES','DEPENDS_ON'].includes(edge.label)&&!nodeIds.includes(edge.target)){
        const path={nodeIds:[...nodeIds,edge.target],edgeIds:[...edgeIds,edge.id]};paths.push(path);walk(path.nodeIds,path.edgeIds);if(paths.length>=100)return;
      }};
      walk(['mission'],[]);
    }
    return {paths:paths.slice(0,100),query:DEPENDENCY_QUERY,params,timeoutMs:1000,backend:client?'falkordb':'simulator',source:client?'FalkorDB dependency traversal':'Explicit demo graph simulator'};
  }
  async function findImpactCone(mission,eventId){
    requireGraph(mission);if(!local.has(mission.id))await seed(mission);
    if(typeof eventId!=='string'||!eventId||eventId.length>100)throw new Error('Invalid observation identifier');
    const params={eventId,missionId:'mission'};
    let paths;
    if(client)paths=(await query(mission,IMPACT_QUERY,params)).data||[];
    else{
      paths=[];const {nodes,edges}=local.get(mission.id);
      if(nodes.get(eventId)?.properties.active){
        const reverse=(nodeIds,edgeIds,depth)=>{
          const last=nodeIds.at(-1);
          if(nodes.get(last)?.type==='RouteOption')for(const edge of edges.values())if(edge.target===last&&edge.label==='CONSIDERS'&&edge.source==='mission')paths.push({nodeIds:[...nodeIds,'mission'],edgeIds:[...edgeIds,edge.id]});
          if(depth>=3||paths.length>=100)return;
          for(const edge of edges.values())if(edge.target===last&&['USES','DEPENDS_ON'].includes(edge.label)&&!nodeIds.includes(edge.source))reverse([...nodeIds,edge.source],[...edgeIds,edge.id],depth+1);
        };
        for(const edge of edges.values())if(edge.source===eventId&&edge.label==='AFFECTS')reverse([eventId,edge.target],[edge.id],0);
      }
    }
    return {paths:paths.slice(0,100),query:IMPACT_QUERY,params,timeoutMs:1000,backend:client?'falkordb':'simulator',source:client?'FalkorDB Impact Cone':'Explicit demo graph simulator'};
  }
  return { status,seed,observe,evaluate,snapshot,recordAction,recordDecision,findImpactCone,findDependencies,
    async init() { if(!url)return status(); try {const {FalkorDB}=await import('falkordb');client=await FalkorDB.connect({url,socket:{connectTimeout:2000,reconnectStrategy:false}});await client.list();} catch(e){client=null;error='FalkorDB connection unavailable';} return status(); },
    async close(){if(client)await client.close();client=null;},
  };
}
