import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, nearbyPlaceRequest } from '../server/provider.mjs';

test('nearby place intent is recognized locally and fixes category and radius without another question',async()=>{
  const classification=nearbyPlaceRequest('Find nearby restaurants and shops within 2 km');
  assert.deepEqual(classification,{placeQuery:'restaurants, shops',radiusMeters:2000});
  let payload;
  const provider=createProvider({env:{GROQ_API_KEY:'test'},fetchImpl:async(_,init)=>{payload=JSON.parse(init.body);return{ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({kind:'unsupported',destinationQuery:'',goal:'Find nearby places',summary:'Search local places'})}}]})};}});
  const intent=await provider.compileIntent({text:'Find nearby restaurants and shops within 2 km',origin:{latitude:28.6,longitude:77.2}});
  assert.equal(intent.kind,'nearby_places');assert.equal(intent.placeQuery,'restaurants, shops');assert.equal(intent.radiusMeters,2000);assert.equal(intent.destinationQuery,'');
  assert.deepEqual(JSON.parse(payload.messages[1].content).origin,{latitude:28.6,longitude:77.2});
  assert.equal(nearbyPlaceRequest('Research restaurant trends'),null);
});

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

test('approval-gated GitHub and Discord requests remain supported work when model labels them unsupported',async()=>{
 const output={kind:'unsupported',destinationQuery:'',goal:'Create a GitHub issue and send a Discord message',summary:'Unapproved external writes are unsupported.'};let payload;
 const provider=createProvider({env:{GROQ_API_KEY:'test'},fetchImpl:async(_,init)=>{payload=JSON.parse(init.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(output)}}]})};}});
 const intent=await provider.compileIntent({text:'Create GitHub issues and send an unapproved Discord message'});
 assert.equal(intent.kind,'work');assert.match(intent.summary,/explicit approval/);assert.equal(intent.goal,output.goal);
 assert.match(payload.messages[0].content,/prepare an approval-gated proposal/i);
});
test('GitHub issue drafts use the user supplied feature scope and remain approval gated',async()=>{
 let payload;const provider=createProvider({env:{GROQ_API_KEY:'test'},fetchImpl:async(_,init)=>{payload=JSON.parse(init.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({content:'Describe the requested architecture design. Agree implementation details during team review.',sourceIds:['repo-evidence']})}}]})};}});
 const evidence=[{id:'repo-evidence',title:'GitHub repository overview',source:'GitHub API',observedAt:new Date().toISOString(),summary:'The Agents Playground repository contains agent examples.'}];
 const draft=await provider.draftAction({text:'Create an issue for feature 1 system architecture design.',action:'propose_github_issue',target:{repository:'owner/agents-playground'},evidence});
 assert.equal(draft.content,'Describe the requested architecture design. Agree implementation details during team review.');assert.deepEqual(draft.sourceIds,['repo-evidence']);assert.match(payload.messages[0].content,/reviewable proposal that remains pending approval/i);assert.match(payload.messages[0].content,/Do not add invented technical requirements/i);
});
