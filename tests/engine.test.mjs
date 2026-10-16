import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEngine} from '../server/engine.mjs';
import {createStore} from '../server/store.mjs';
import {createGraph} from '../server/graph.mjs';
import {testRoutes,testGraph} from './helpers/mission-fixture.mjs';
const origin={latitude:28.63,longitude:77.21};
const destination={latitude:28.5562,longitude:77.101,label:'Airport'};
const input={text:'Arrive at the airport in 90 minutes',origin,destination};
async function fixture(t,options={}){
 const directory=await mkdtemp(join(tmpdir(),'mova-engine-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=createStore({path:join(directory,'state.json')});
 let calls=0;
 const adapters={getIntegrations:()=>[],calculateRoutes:async()=>testRoutes(),openNavigation:async({plan,destination})=>{calls++;return {status:'UNVERIFIED',navigationTarget:{planId:plan.id,destination,mode:plan.mode},summary:'In-app guidance ready.'};},...options.adapters};
 const provider={configured:true,compileIntent:async()=>({kind:'travel',destinationQuery:'Airport',deadlineMinutes:90,summary:'Airport arrival'}),next:async({mission})=>({selectedPlanId:mission.plans.find(p=>p.feasible)?.id,summary:'Use the feasible graph route'}),...options.provider};
 const graph=options.graph||testGraph();const engine=createEngine({store,graph,adapters,provider,workTools:options.workTools,workGraph:options.workGraph});await engine.init();return {engine,store,graph,adapters,provider,calls:()=>calls};
}
test('live is the default and unsupported modes and arbitrary events are unavailable',async t=>{
 const f=await fixture(t);const s=await f.engine.createMission(input);assert.equal(s.mission.mode,'live');assert.equal(s.mission.state,'AWAITING_APPROVAL');assert.equal(f.engine.injectEvent,undefined);await assert.rejects(f.engine.createMission({...input,mode:'demo'}),/Only live/);
});
test('navigation approval is idempotent and opened acknowledgement does not resolve arrival',async t=>{
 const f=await fixture(t);let s=await f.engine.createMission(input);await Promise.all([f.engine.approve(s.mission.id,s.mission.revision),f.engine.approve(s.mission.id,s.mission.revision)]);s=f.engine.getState();assert.equal(f.calls(),1);assert.equal(s.mission.state,'VERIFYING');assert.equal(s.mission.receipts[0].status,'UNVERIFIED');assert.ok(s.mission.receipts[0].navigationTarget);s=await f.engine.acknowledge(s.mission.id,{receiptId:s.mission.receipts[0].id,outcome:'opened'});assert.equal(s.mission.state,'VERIFYING');
 s=await f.engine.setLocation({...destination,accuracy:25,timestamp:Date.now()});assert.equal(s.mission.state,'RESOLVED');assert.ok(s.mission.graph.edges.some(e=>e.label==='VERIFIED_BY'));
});
test('changed route evidence replans and invalidates old approval',async t=>{
 let reads=0;const f=await fixture(t,{adapters:{calculateRoutes:async()=>testRoutes(++reads===1?45:150)}});let s=await f.engine.createMission(input);const old=s.mission.revision;s=await f.engine.observeRoutes(s.mission.id);assert.equal(s.mission.selectedPlanId,'metro');await assert.rejects(f.engine.approve(s.mission.id,old),/changed/);assert.equal(f.calls(),0);
});
test('restarts preserve verification and cannot duplicate effects',async t=>{
 const f=await fixture(t);let s=await f.engine.createMission(input);s=await f.engine.approve(s.mission.id,s.mission.revision);const restarted=createEngine({store:f.store,graph:testGraph(),adapters:f.adapters,provider:f.provider});await restarted.init();s=await restarted.resume(s.mission.id);assert.equal(s.mission.state,'VERIFYING');assert.equal(f.calls(),1);
});
test('retired missions are archived intact and hidden at startup',async t=>{
 const f=await fixture(t);const retired={id:'old',mode:'demo',state:'RESOLVED',receipts:[{id:'keep'}]};await f.store.save({version:1,currentId:'old',missions:[retired]});await f.engine.init();assert.equal(f.engine.getState().mission,null);assert.deepEqual(f.engine.getState().missions,[]);assert.deepEqual((await f.store.load()).archivedMissions,[retired]);
});
test('missing graph blocks instead of generating a fallback route',async t=>{
 const f=await fixture(t,{graph:createGraph({url:''})});const s=await f.engine.createMission(input);assert.equal(s.mission.state,'BLOCKED');assert.match(s.mission.summary,/FalkorDB/);assert.deepEqual(s.mission.plans,[]);
});
test('unknown and stale accuracy never become arrival proof',async t=>{
 const f=await fixture(t);let s=await f.engine.createMission(input);s=await f.engine.approve(s.mission.id,s.mission.revision);await assert.rejects(f.engine.setLocation({...destination,accuracy:20,timestamp:Date.now()-180000}),/stale/);s=await f.engine.setLocation({...destination,accuracy:0,timestamp:Date.now()});assert.equal(s.mission.state,'VERIFYING');
});
test('failed navigation acknowledgement stays failed and cannot be promoted',async t=>{
 const f=await fixture(t);let s=await f.engine.createMission(input);s=await f.engine.approve(s.mission.id,s.mission.revision);const receiptId=s.mission.receipts[0].id;s=await f.engine.acknowledge(s.mission.id,{receiptId,outcome:'failed'});assert.equal(s.mission.state,'FAILED_RETRYABLE');await assert.rejects(f.engine.acknowledge(s.mission.id,{receiptId,outcome:'opened'}),/phase/);assert.equal(f.calls(),1);
});
test('weather request completes from real adapter contract without a travel location',async t=>{
 const output={source:'Weather test fixture',observedAt:new Date().toISOString(),current:{temperature_2m:27},evidenceKind:'observed'};
 const f=await fixture(t,{provider:{compileIntent:async()=>({kind:'weather',destinationQuery:'Delhi',summary:'Read current weather'})},adapters:{searchPlaces:async()=>({places:[{location:destination}]}),getWeather:async()=>output}});
 const s=await f.engine.createMission({text:'Weather in Delhi'});assert.equal(s.mission.state,'RESOLVED');assert.equal(s.mission.kind,'weather');assert.deepEqual(s.mission.result,output);assert.equal(f.calls(),0);assert.ok(s.mission.graph.edges.some(e=>e.label==='VERIFIED_BY'));
});
test('calendar read uses authorized connector and unsupported actions are blocked',async t=>{
 const output={source:'Calendar test fixture',observedAt:new Date().toISOString(),events:[]};const f=await fixture(t,{provider:{compileIntent:async()=>({kind:'calendar_read',destinationQuery:'',summary:'Read calendar'})},adapters:{getCalendarEvents:async()=>output}});let s=await f.engine.createMission({text:'Read my upcoming meetings'});assert.equal(s.mission.state,'RESOLVED');assert.deepEqual(s.mission.result.events,[]);
 f.provider.compileIntent=async()=>({kind:'unsupported',summary:'Booking flights is not supported by connected tools.'});s=await f.engine.createMission({text:'Book a flight'});assert.equal(s.mission.state,'BLOCKED');assert.match(s.mission.summary,/not supported/);assert.equal(f.calls(),0);
});

test('late observed arrival cannot resolve an expired protected deadline',async t=>{
 const f=await fixture(t);let s=await f.engine.createMission(input);s=await f.engine.approve(s.mission.id,s.mission.revision);const saved=await f.store.load();saved.missions[0].deadline=new Date(Date.now()-1000).toISOString();await f.store.save(saved);await f.engine.init();s=await f.engine.setLocation({...destination,accuracy:20,timestamp:Date.now()});assert.equal(s.mission.state,'BLOCKED');assert.equal(s.mission.receipts.filter(r=>r.tool==='verify_mission_outcome').length,0);
});
test('interrupted actions become unknown on restart and legacy live missions gain travel kind',async t=>{
 const f=await fixture(t);let s=await f.engine.createMission(input);const saved=await f.store.load();const m=saved.missions[0];delete m.kind;m.state='EXECUTING';m.receipts=[{id:'pending',status:'PENDING'}];await f.store.save(saved);await f.engine.init();s=f.engine.getState();assert.equal(s.mission.kind,'travel');assert.equal(s.mission.state,'UNKNOWN');assert.equal(s.mission.receipts[0].status,'UNKNOWN');
});
test('fresh origin updates drive route observation and repeated reads are throttled',async t=>{
 let reads=0,latest;const f=await fixture(t,{adapters:{calculateRoutes:async({origin})=>{reads++;latest=origin;return testRoutes();}}});let s=await f.engine.createMission(input);s=await f.engine.approve(s.mission.id,s.mission.revision);await f.engine.setLocation({latitude:28.62,longitude:77.19,accuracy:20,timestamp:Date.now()});s=await f.engine.observeRoutes(s.mission.id);assert.equal(latest.latitude,28.62);assert.equal(s.mission.state,'VERIFYING');await f.engine.observeRoutes(s.mission.id);assert.equal(reads,2);
});
test('named starting places resolve without fabricating device observations',async t=>{
 const f=await fixture(t,{provider:{compileIntent:async()=>({kind:'travel',originQuery:'India Gate',destinationQuery:'Airport',deadlineMinutes:90,goal:'Reach airport on time',summary:'Named starting place'})},adapters:{searchPlaces:async()=>({places:[{location:origin,displayName:{text:'India Gate'}}],source:'Places fixture',observedAt:new Date().toISOString()})}});const s=await f.engine.createMission({text:'India Gate to airport in 90 minutes',destination});assert.equal(s.mission.state,'AWAITING_APPROVAL');assert.equal(s.mission.origin.evidenceKind,'user-provided');assert.equal(s.mission.title,'Reach airport on time');assert.equal(s.mission.receipts.length,0);
});

test('actual FalkorDB approval and device arrival survive an engine restart',{skip:!process.env.FALKORDB_TEST_URL},async t=>{
 const graph=createGraph({url:process.env.FALKORDB_TEST_URL});t.after(()=>graph.close());const f=await fixture(t,{graph});let s=await f.engine.createMission(input);assert.equal(s.mission.state,'AWAITING_APPROVAL');s=await f.engine.approve(s.mission.id,s.mission.revision);assert.ok(s.mission.graph.edges.some(e=>e.label==='AUTHORIZES'));const restarted=createEngine({store:f.store,graph,adapters:f.adapters,provider:f.provider});await restarted.init();s=await restarted.setLocation({...destination,accuracy:20,timestamp:Date.now()});assert.equal(s.mission.state,'RESOLVED');assert.ok(s.mission.graph.edges.some(e=>e.label==='VERIFIED_BY'));assert.equal(f.calls(),1);
});

test('explicit named origin overrides a different available device position',async t=>{
 const named={latitude:28.6129,longitude:77.2295};let routedOrigin;
 const f=await fixture(t,{provider:{compileIntent:async()=>({kind:'travel',originQuery:'India Gate',destinationQuery:'Airport',deadlineMinutes:90,summary:'Start at India Gate'})},adapters:{searchPlaces:async()=>({places:[{location:named,displayName:{text:'India Gate'}}],source:'Places fixture',observedAt:new Date().toISOString()}),calculateRoutes:async({origin})=>{routedOrigin=origin;return testRoutes();}}});
 await f.engine.setLocation({...origin,accuracy:20,timestamp:Date.now()});
 const s=await f.engine.createMission({text:'India Gate to airport in 90 minutes',destination});
 assert.equal(s.mission.state,'AWAITING_APPROVAL');assert.equal(routedOrigin.latitude,named.latitude);assert.equal(routedOrigin.longitude,named.longitude);assert.equal(s.mission.origin.evidenceKind,'user-provided');assert.equal(s.mission.origin.accuracy,undefined);
 await f.engine.setLocation({...origin,accuracy:20,timestamp:Date.now()});assert.equal(f.engine.getState().mission.origin.latitude,named.latitude);
});
test('unresolved explicit origin cannot silently use the available device position',async t=>{
 const f=await fixture(t,{provider:{compileIntent:async()=>({kind:'travel',originQuery:'Unresolved starting place',destinationQuery:'Airport',deadlineMinutes:90,summary:'Named origin'})},adapters:{searchPlaces:async()=>({places:[]})}});
 const s=await f.engine.createMission({...input,text:'Unresolved starting place to airport'});assert.equal(s.mission.state,'BLOCKED');assert.match(s.mission.summary,/starting place/);assert.equal(s.mission.plans.length,0);
});

for(const target of ['origin','destination','weather']){
 test(`ambiguous ${target} is blocked with candidate names`,async t=>{
  const places={source:'Places fixture',places:[{id:'wrong',displayName:{text:'India Gate Road'},location:origin},{id:'named',displayName:{text:'India Gate Monument'},location:destination}],resolution:{status:'ambiguous',candidateIds:['wrong','named'],query:'India Gate'}};
  const f=await fixture(t,{provider:{compileIntent:async()=>({kind:target==='weather'?'weather':'travel',...(target==='origin'?{originQuery:'India Gate'}:{}),destinationQuery:'India Gate',deadlineMinutes:90,summary:'Resolve requested place'})},adapters:{searchPlaces:async()=>places,getWeather:async()=>({source:'weather',observedAt:new Date().toISOString()})}});
  const s=await f.engine.createMission({text:'India Gate',origin});assert.equal(s.mission.state,'BLOCKED');assert.match(s.mission.summary,/India Gate Road/);assert.match(s.mission.summary,/more specific/i);assert.equal(s.mission.receipts.length,0);
 });
 test(`matched ${target} uses selectedPlaceId instead of the first result`,async t=>{
  const chosen={latitude:12,longitude:34};
  const places={source:'Places fixture',places:[{id:'wrong',displayName:{text:'Wrong'},location:origin},{id:'named',displayName:{text:'Selected'},location:chosen}],resolution:{status:'matched',selectedPlaceId:'named',candidateIds:['named'],query:'Selected'}};
  const f=await fixture(t,{provider:{compileIntent:async()=>({kind:target==='weather'?'weather':'travel',...(target==='origin'?{originQuery:'Selected'}:{}),destinationQuery:'Selected',deadlineMinutes:90,summary:'Resolve requested place'})},adapters:{searchPlaces:async()=>places,getWeather:async()=>({source:'weather',observedAt:new Date().toISOString()})}});
  const s=await f.engine.createMission({text:'Selected',origin});assert.notEqual(s.mission.state,'BLOCKED');assert.equal(s.mission[target==='origin'?'origin':'destination'].latitude,12);
 });
}

for(const target of ['origin','destination','weather'])test(`unresolved ${target} rejects an available first candidate`,async t=>{
 const f=await fixture(t,{provider:{compileIntent:async()=>({kind:target==='weather'?'weather':'travel',...(target==='origin'?{originQuery:'Missing'}:{}),destinationQuery:'Missing',deadlineMinutes:90,summary:'Resolve requested place'})},adapters:{searchPlaces:async()=>({places:[{id:'wrong',displayName:{text:'Unrelated candidate'},location:origin}],resolution:{status:'unresolved',candidateIds:['wrong']}}),getWeather:async()=>{throw new Error('Must not read weather');}}});
 const s=await f.engine.createMission({text:'Missing location',origin});assert.equal(s.mission.state,'BLOCKED');assert.match(s.mission.summary,/unresolved/);assert.match(s.mission.summary,/Unrelated candidate/);assert.equal(s.mission.receipts.length,0);
});

test('a distant phone fix cannot replace an approved named origin, while real arrival still verifies',async t=>{
 const named={latitude:28.6129,longitude:77.2295};
 const f=await fixture(t,{provider:{compileIntent:async()=>({kind:'travel',originQuery:'India Gate',destinationQuery:'Airport',deadlineMinutes:90,summary:'Named route'})},adapters:{searchPlaces:async()=>({places:[{location:named,displayName:{text:'India Gate'}}],source:'Places fixture',observedAt:new Date().toISOString()})}});
 let s=await f.engine.createMission({text:'India Gate to airport in 90 minutes',destination});s=await f.engine.approve(s.mission.id,s.mission.revision);const revision=s.mission.revision;
 const distant={latitude:12.9716,longitude:77.5946,accuracy:20,timestamp:Date.now(),source:'Actual tracked phone'};
 s=await f.engine.setLocation(distant);assert.equal(s.mission.origin.latitude,named.latitude);assert.equal(s.mission.deviceLocation.latitude,distant.latitude);assert.equal(s.mission.state,'VERIFYING');assert.equal(s.mission.revision,revision);assert.equal(s.mission.needsRouteRefresh,false);assert.match(s.mission.summary,/away from.*route/);
 s=await f.engine.setLocation({...distant,timestamp:Date.now()});assert.equal(s.mission.trace.filter(t=>t.title==='Device position differs from requested route').length,1);
 s=await f.engine.setLocation({...destination,accuracy:20,timestamp:Date.now()});assert.equal(s.mission.state,'RESOLVED');assert.equal(s.mission.deviceLocation.latitude,destination.latitude);
});

test('background observations of an older mission cannot steal the current mission',async t=>{
 const f=await fixture(t);const first=await f.engine.createMission(input);const second=await f.engine.createMission({...input,text:'A different current mission'});assert.notEqual(first.mission.id,second.mission.id);await f.engine.observeRoutes(first.mission.id);assert.equal(f.engine.getState().mission.id,second.mission.id);
});

test('selecting saved mission history changes focus without new reasoning or action',async t=>{
 let decisions=0;const f=await fixture(t,{provider:{next:async({mission})=>{decisions++;return {selectedPlanId:mission.plans.find(p=>p.feasible).id,summary:'Selected'};}}});const first=await f.engine.createMission(input);await f.engine.createMission({...input,text:'Second mission'});const s=await f.engine.selectMission(first.mission.id);assert.equal(s.mission.id,first.mission.id);assert.equal((await f.store.load()).currentId,first.mission.id);assert.equal(decisions,2);assert.equal(f.calls(),0);
});

test('work context updates invalidate old evidence and rerun only the revised plan',async t=>{
 let reads=0;const workTools={list:()=>[{name:'web_search',description:'Search',inputSchema:{type:'object',properties:{query:{type:'string'}}}}],call:async()=>({source:'Search fixture',observedAt:new Date().toISOString(),results:[{title:'Result '+(++reads),snippet:'Evidence from the current query'}]})};
 const workGraph={sync:async()=>{},snapshot:async()=>({nodes:[],edges:[]}),ready:async m=>({stepIds:m.work.steps.filter(s=>s.status==='pending').map(s=>s.id),query:'ready',params:{}})};
 const f=await fixture(t,{workTools,workGraph,provider:{compileIntent:async()=>({kind:'work',goal:'Research a topic',destinationQuery:'',summary:'Research'}),planWork:async()=>({status:'ready',summary:'Research',steps:[{id:'read',title:'Search',tool:'web_search',args:{query:'topic'},dependsOn:[]}]}),synthesizeWork:async({evidence})=>({answer:'Supported finding',title:'Research',sourceIds:[evidence[0].id]})}});
 let s=await f.engine.createMission({text:'Research a topic'});assert.equal(s.mission.kind,'work');assert.equal(s.mission.state,'RESOLVED');assert.equal(reads,1);s=await f.engine.updateWorkContext(s.mission.id,'Focus on a different constraint');assert.equal(s.mission.state,'RESOLVED');assert.equal(reads,2);assert.equal(s.mission.work.evidence[0].stale,true);assert.equal(s.mission.work.evidence.at(-1).stale,false);assert.equal(s.mission.revision,1);
});
