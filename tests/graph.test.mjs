import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createGraph} from '../server/graph.mjs';
import {testRoutes} from './helpers/mission-fixture.mjs';
const makeMission=()=>({id:randomUUID(),mode:'live',title:'Travel test',deadline:Date.now()+90*60000,constraints:{bufferMinutes:15,maxCost:null},plans:testRoutes(),observations:[],receipts:[]});
const url=process.env.FALKORDB_TEST_URL;
test('disconnected graphs reject all decisions and invalid identifiers',async()=>{const graph=createGraph({url:''});await graph.init();assert.equal(graph.status().backend,'unavailable');await assert.rejects(graph.seed(makeMission()),/unavailable/);await assert.rejects(graph.seed({...makeMission(),id:'../bad'}),/identifier/);});
test('actual FalkorDB dependencies and edge removal determine feasible plans',{skip:!url},async t=>{
 const graph=createGraph({url});t.after(()=>graph.close());await graph.init();assert.equal(graph.status().connected,true);const mission=makeMission();await graph.seed(mission);assert.equal((await graph.evaluate(mission)).plans.find(p=>p.feasible).id,'expressway');
 const observation={id:randomUUID(),type:'route_update',at:Date.now(),source:'Route adapter fixture',evidenceKind:'calculated_estimate',value:{planId:'expressway',durationMinutes:150}};
 await graph.observe(mission,observation);const changed=await graph.evaluate(mission);assert.equal(changed.plans.find(p=>p.feasible).id,'metro');const flatWithoutConnectedEvidence=[...mission.plans].sort((a,b)=>a.durationMinutes-b.durationMinutes)[0];assert.equal(flatWithoutConnectedEvidence.id,'expressway','Flat duration ranking misses the new multi-hop blocking evidence');assert.notEqual(changed.plans.find(p=>p.feasible).id,flatWithoutConnectedEvidence.id);const impact=await graph.findImpactCone(mission,observation.id);assert.ok(impact.paths.some(p=>p.nodeIds.join(',')===`${observation.id},route-service-expressway,expressway-connection,expressway,mission`));assert.ok(impact.paths.every(p=>p.edgeIds.length===p.nodeIds.length-1));
 const {FalkorDB}=await import('falkordb');const db=await FalkorDB.connect({url});t.after(()=>db.close());await db.selectGraph(`mova_mission_${mission.id}`).query('MATCH (a:Item {id:$id})-[r:USES]->() DELETE r',{params:{id:'metro'}});assert.equal((await graph.evaluate(mission)).plans.find(p=>p.feasible).id,'ring-road');
 const isolated=makeMission();await graph.seed(isolated);assert.equal((await graph.evaluate(isolated)).plans.find(p=>p.feasible).id,'expressway');assert.deepEqual((await graph.findImpactCone(isolated,observation.id)).paths,[]);
 await assert.rejects(graph.seed({...mission,plans:Array(13).fill(mission.plans[0])}),/budget/);
});
test('actual graph rejects stale evidence and records explicit approval provenance',{skip:!url},async t=>{
 const graph=createGraph({url});t.after(()=>graph.close());await graph.init();const mission=makeMission();mission.plans=mission.plans.map(p=>({...p,observedAt:'2020-01-01T00:00:00Z'}));await graph.seed(mission);assert.ok((await graph.evaluate(mission)).plans.every(p=>!p.feasible));mission.plans=testRoutes();await graph.seed(mission);mission.plans=(await graph.evaluate(mission)).plans;mission.revision=1;await graph.recordApproval(mission,{planId:'expressway',revision:1,at:new Date().toISOString()});assert.ok((await graph.snapshot(mission)).edges.some(e=>e.label==='AUTHORIZES'&&e.target==='expressway'));
});
