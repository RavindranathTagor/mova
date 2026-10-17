import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FalkorDB } from 'falkordb';
import { createWorkGraph } from '../server/work-graph.mjs';

const url = process.env.FALKORDB_TEST_URL;
const mission = () => ({ id: randomUUID(), kind: 'work', title: 'Compare primary sources', createdAt: new Date().toISOString(), work: {
  steps: [{ id: 'research', title: 'Read a source', tool: 'read_web_page', args: {}, dependsOn: [], status: 'completed' }, { id: 'compare', title: 'Compare sources', tool: 'read_web_page', args: {}, dependsOn: ['research'], status: 'pending' }, { id: 'write', title: 'Write report', tool: 'save_artifact', args: {}, dependsOn: ['compare'], status: 'pending' }],
  evidence: [{ id: 'source', title: 'Primary-source result', stepId: 'research', source: 'Official documentation', summary: 'Observed documentation response', url: 'https://example.org/docs', observedAt: new Date().toISOString() }], artifacts: [],
} });

test('work graphs fail closed without a database and validate plans before writes', async () => {
  const graph = createWorkGraph({ url: '' });
  await assert.rejects(graph.sync(mission()), /unavailable/);
  await assert.rejects(graph.sync({ ...mission(), id: '../unsafe' }), /identifier/);
  const cycle = mission(); cycle.work.steps[0].dependsOn = ['write'];
  await assert.rejects(graph.sync(cycle), /cycle/);
  const missing = mission(); missing.work.steps[1].dependsOn = ['missing'];
  await assert.rejects(graph.sync(missing), /Unknown work dependency/);
  const orphan = mission(); orphan.work.evidence[0].stepId = 'missing';
  await assert.rejects(graph.sync(orphan), /Active evidence .* references unknown work step missing/);
  const staleOrphan = mission(); staleOrphan.work.evidence[0].stepId = 'old-plan'; staleOrphan.work.evidence[0].stale = true;
  await assert.rejects(graph.sync(staleOrphan), /unavailable/, 'explicitly stale evidence is retained without graph attachment');
  const deep = mission(); deep.work.steps = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, title: `Step ${i}`, tool: 'read_web_page', args: {}, dependsOn: i ? [`s${i - 1}`] : [], status: 'pending' })); deep.work.evidence = [];
  await assert.rejects(graph.sync(deep), /depth/);
  assert.throws(() => createWorkGraph({ prefix: 'unsafe:prefix' }), /prefix/);
  await graph.close();
});

test('real FalkorDB evidence and dependencies control work execution', { skip: !url }, async t => {
  const prefix = `test_work_${randomUUID().replaceAll('-', '')}_`;
  const graph = createWorkGraph({ url, prefix });
  const db = await FalkorDB.connect({ url });
  const m = mission();
  t.after(async () => { await db.selectGraph(`${prefix}${m.id}`).delete(); await graph.close(); await db.close(); });
  await graph.sync(m);
  assert.deepEqual((await graph.ready(m)).stepIds, ['compare']);
  m.work.evidence[0].evidenceKind = 'inferred';
  await graph.sync(m);
  assert.deepEqual((await graph.ready(m)).stepIds, [], 'Inferred-only support cannot establish tool completion');
  m.work.evidence[0].evidenceKind = 'observed';
  await graph.sync(m);
  assert.deepEqual((await graph.ready(m)).stepIds, ['compare']);
  const physical = db.selectGraph(`${prefix}${m.id}`);
  await physical.query('MATCH (e:Evidence {id:$id}) DETACH DELETE e', { params: { id: 'evidence:source' } });
  assert.deepEqual((await graph.ready(m)).stepIds, [], 'Missing actual evidence blocks dependencies despite completed JavaScript state');
  await graph.sync(m);
  assert.deepEqual((await graph.ready(m)).stepIds, ['compare']);
  await physical.query('MATCH (s:Step {id:$id})-[r:DEPENDS_ON]->() DELETE r', { params: { id: 'step:write' } });
  assert.deepEqual((await graph.ready(m)).stepIds, ['compare', 'write'], 'Actual edge removal changes ready work without changing in-memory mission');
  await graph.sync(m);
  assert.deepEqual((await graph.ready(m)).stepIds, ['compare'], 'Resync restores requested dependency');
  m.work.steps[1].status = 'completed';
  m.work.evidence.push({ id: 'comparison', title: 'Comparison response', summary: 'Comparison observed', stepId: 'compare', source: 'Read tool', observedAt: new Date().toISOString() });
  m.work.steps[0].status = 'blocked';
  await graph.sync(m);
  assert.deepEqual((await graph.ready(m)).stepIds, [], 'A blocked transitive dependency blocks downstream work');
  m.work.steps[0].status = 'completed'; await graph.sync(m);
  assert.deepEqual((await graph.ready(m)).stepIds, ['write']);
  const ready = await graph.ready(m); assert.match(ready.query, /DEPENDS_ON\*1\.\.6/); assert.match(ready.query, /LIMIT 12/); assert.equal(ready.timeoutMs, 1000);
});

test('real work graphs replace stale links, preserve provenance and isolate missions', { skip: !url }, async t => {
  const prefix = `test_work_${randomUUID().replaceAll('-', '')}_`;
  const graph = createWorkGraph({ url, prefix }); const db = await FalkorDB.connect({ url });
  const one = mission(), two = mission();
  t.after(async () => { for (const m of [one,two]) await db.selectGraph(`${prefix}${m.id}`).delete(); await graph.close(); await db.close(); });
  one.work.artifacts = [{ id: 'report', title: 'Report', content: '# Report\nSource-supported content.', sourceIds: ['source'], verifiedAt: new Date().toISOString() }];
  await graph.sync(one); await graph.sync(two);
  const before = await graph.snapshot(one);
  assert.ok(before.edges.some(e => e.label === 'DERIVED_FROM' && e.evidenceKind === 'inferred'));
  assert.ok(before.edges.filter(e => e.label === 'DEPENDS_ON').every(e => e.evidenceKind === 'inferred'));
  assert.equal(before.nodes.find(n => n.id === 'evidence:source').source, 'Official documentation');
  one.work.artifacts = []; one.work.evidence = []; one.work.steps[1].dependsOn = [];
  await graph.sync(one); await graph.sync(one);
  const after = await graph.snapshot(one);
  assert.ok(!after.nodes.some(n => ['Evidence','Artifact'].includes(n.type)));
  assert.ok(!after.edges.some(e => e.source === 'step:compare' && e.label === 'DEPENDS_ON'));
  assert.equal(new Set(after.nodes.map(n => n.id)).size, after.nodes.length);
  assert.equal(new Set(after.edges.map(e => e.id)).size, after.edges.length);
  assert.deepEqual((await graph.ready(one)).stepIds, ['compare']);
  assert.deepEqual((await graph.ready(two)).stepIds, ['compare']);
  assert.ok((await graph.snapshot(two)).nodes.some(n => n.id === 'evidence:source'));
});
