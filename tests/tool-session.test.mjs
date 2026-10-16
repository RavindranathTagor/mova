import test from 'node:test';
import assert from 'node:assert/strict';
test('mission tools negotiate MCP, validate arguments and return observed tool results',async()=>{
  const {createToolSession}=await import('../server/tool-session.mjs');
  let calls=0;
  const session=await createToolSession([{name:'get_mission_constraints',description:'Read mission constraints',inputSchema:{type:'object',properties:{},additionalProperties:false}}],async()=>{calls++;return{deadline:42};});
  try{assert.equal((await session.list()).tools[0].name,'get_mission_constraints');assert.deepEqual(await session.call('get_mission_constraints',{}),{deadline:42});await assert.rejects(()=>session.call('arbitrary_query',{cypher:'DELETE'}));await assert.rejects(()=>session.call('get_mission_constraints',{extra:true}));assert.equal(calls,1);}finally{await session.close();}
});
