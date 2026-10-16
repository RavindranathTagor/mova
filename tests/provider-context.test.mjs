import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../server/provider.mjs';

test('planner compaction retains exact graph paths and edge identity while excluding route geometry', async () => {
  let payload;
  const provider = createProvider({ env: { GROQ_API_KEY: 'test' }, fetchImpl: async (_, init) => {
    payload = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ selectedPlanId: 'route', summary: 'The graph supports this route.' }) } }] }) };
  } });
  const path = { nodeIds: ['mission', 'route', 'road'], edgeIds: ['considers-route', 'uses-road'] };
  const geometry = Array.from({ length: 10000 }, () => [72.123, 19.456]);
  await provider.next({ mission: { id: 'mission', goal: 'Arrive', plans: [{ id: 'route', feasible: true, coordinates: geometry, decisionPaths: [path] }] }, results: [{ tool: 'find_mission_dependencies', result: { paths: [path], graph: { nodes: [], edges: [{ id: 'uses-road', source: 'route', target: 'road', label: 'USES' }] } } }] });
  const context = JSON.parse(payload.messages[1].content);
  assert.deepEqual(context.results[0].result.paths[0], path);
  assert.deepEqual(context.mission.plans[0].decisionPaths[0], path);
  assert.equal(context.results[0].result.evidenceGraph.edges[0].id, 'uses-road');
  assert.equal(context.compaction.omittedRouteCoordinateCount, 10000);
  assert.equal(JSON.stringify(payload).includes('72.123'), false);
  assert.ok(JSON.stringify(payload).length < 12000);
});

test('oversized essential evidence is rejected before contacting the model', async () => {
  let called = false;
  const provider = createProvider({ env: { GROQ_API_KEY: 'test' }, fetchImpl: async () => { called = true; } });
  await assert.rejects(provider.next({ mission: { goal: 'Arrive', constraints: { reason: 'x'.repeat(15000) }, plans: [] } }), /local provider limit/);
  assert.equal(called, false);
});

for(const deadline of [null,0,-1,1.5,10081])test(`intent deadline ${deadline} is ${deadline===null?'absent':'invalid'}`,async()=>{
 const output={kind:'travel',destinationQuery:'India Gate, New Delhi',goal:'Reach India Gate',summary:'Destination identified',deadlineMinutes:deadline};
 const provider=createProvider({env:{GROQ_API_KEY:'test'},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(output)}}]})})});
 if(deadline===null){const intent=await provider.compileIntent({text:'Reach India Gate, New Delhi'});assert.equal(Object.hasOwn(intent,'deadlineMinutes'),false);}
 else await assert.rejects(provider.compileIntent({text:'Reach India Gate, New Delhi'}),/deadline/);
});
