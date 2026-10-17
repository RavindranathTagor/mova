import { FalkorDB } from 'falkordb';
import { randomUUID } from 'node:crypto';

const READY_QUERY = `MATCH (m:WorkItem:Mission {id:$missionNodeId, ready:true})-[:HAS_STEP]->(s:Step {status:'pending'})
OPTIONAL MATCH (s)-[:DEPENDS_ON*1..6]->(d:Step)
OPTIONAL MATCH (d)-[:SUPPORTED_BY]->(e:Evidence)
WITH s, count(DISTINCT d) AS dependencyCount,
count(DISTINCT CASE WHEN d.status='completed' AND e.evidenceKind IN ['observed','user-provided','calculated_estimate'] THEN d END) AS supportedCompleteCount
WHERE dependencyCount=supportedCompleteCount
RETURN s.stepId AS stepId ORDER BY s.ordinal LIMIT 12`;
const IMPACT_RANK_QUERY = `MATCH p=(m:WorkItem:Mission {id:$missionNodeId, ready:true})-[:HAS_STEP|DEPENDS_ON|SUPPORTED_BY|GATES|PRODUCED|PROPOSES|DERIVED_FROM*1..8]->(n:WorkItem)
WITH n, min(length(p)) AS nearestHop, count(DISTINCT p) AS pathCount
OPTIONAL MATCH (n)-[r]-(:WorkItem)
WITH n, nearestHop, pathCount, count(DISTINCT r) AS degree
RETURN n.id AS nodeId, n.payload AS payload, nearestHop, pathCount, degree
ORDER BY pathCount DESC, degree DESC, nearestHop ASC LIMIT 20`;
const NODE_LABELS = new Set(['Mission', 'Mention', 'Decision', 'Step', 'Evidence', 'Artifact', 'ActionProposal']);
const RELATIONSHIPS = new Set(['HAS_STEP', 'DEPENDS_ON', 'SUPPORTED_BY', 'DERIVED_FROM', 'PRODUCED', 'PROPOSES', 'TRIGGERED_BY', 'GATES']);
const STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'blocked']);
const text = (value, field, limit = 1000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`Invalid work graph ${field}`);
  return value;
};
const date = (value, field) => { if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid work graph ${field}`); return new Date(value).toISOString(); };

function materialize(mission) {
  if (!mission || !/^[a-zA-Z0-9_-]{1,100}$/.test(mission.id)) throw new Error('Invalid work mission identifier');
  if (mission.kind !== 'work' || !mission.work) throw new Error('Work graph requires a work mission');
  const { steps = [], evidence = [], artifacts = [], proposals = [] } = mission.work;
  if (!Array.isArray(steps) || !Array.isArray(evidence) || !Array.isArray(artifacts) || !Array.isArray(proposals) || steps.length > 36 || evidence.length > 80 || artifacts.length > 24 || proposals.length > 24) throw new Error('Work graph budget exceeded (36 steps, 80 evidence records, 24 artifacts, 24 action proposals)');
  const stepsById = new Map();
  for (const step of steps) {
    text(step.id, 'step identifier', 100); text(step.title, 'step title'); text(step.tool, 'step tool', 100);
    if (stepsById.has(step.id) || !STATUSES.has(step.status) || !Array.isArray(step.dependsOn) || new Set(step.dependsOn).size !== step.dependsOn.length) throw new Error('Invalid or duplicate work step');
    if (JSON.stringify(step.args || {}).length > 20000) throw new Error('Work step arguments exceed budget');
    stepsById.set(step.id, step);
  }
  const visit = (id, path = []) => {
    if (path.includes(id)) throw new Error('Work dependency cycle');
    if (path.length > 6) throw new Error('Work dependency depth exceeds six');
    const step = stepsById.get(id);
    if (!step) throw new Error('Unknown work dependency');
    for (const dependency of step.dependsOn) visit(dependency, [...path, id]);
  };
  for (const id of stepsById.keys()) visit(id);
  const at = new Date().toISOString();
  const nodes = [], edges = [];
  const addNode = (id, label, type, status, source, evidenceKind, observedAt, properties) => nodes.push({ id, label, type, status, source, observedAt, evidenceKind, properties });
  const addEdge = (source, target, label, provenance, evidenceKind, observedAt = at) => edges.push({ id: `${source}:${label}:${target}`, source, target, label, status: 'healthy', provenance, observedAt, evidenceKind, explanation: `${source} ${label.toLowerCase().replaceAll('_', ' ')} ${target}` });
  addNode('mission', text(mission.title || mission.goal, 'mission title'), 'Mission', mission.state || 'active', mission.trigger?.source || 'User request', mission.trigger ? 'observed' : 'user-provided', mission.createdAt ? date(mission.createdAt, 'mission date') : at, { missionId: mission.id, kind: 'work' });
  if (mission.trigger) {
    const trigger = mission.trigger;
    const service = text(trigger.service, 'mention service', 100);
    const channelOrThread = text(trigger.channelId || trigger.repository || 'connected source', 'mention location', 300);
    const observedAt = date(trigger.observedAt || mission.createdAt || at, 'mention timestamp');
    addNode('mention:trigger', `${service} mention`, 'Mention', 'observed', `${service} ${channelOrThread}`, 'observed', observedAt, { service, channelId: trigger.channelId || null, repository: trigger.repository || null, issueNumber: trigger.issueNumber || null, eventId: String(trigger.eventId || '').slice(0, 200), authorId: String(trigger.authorId || '').slice(0, 200), content: String(trigger.content || '').slice(0, 4000) });
    addEdge('mission', 'mention:trigger', 'TRIGGERED_BY', `${service} connector event`, 'observed', observedAt);
  }
  addNode('decision:dispatch', 'FalkorDB tool dispatch gate', 'Decision', 'graph-controlled', 'FalkorDB dependency traversal', 'calculated_estimate', at, { cypher: READY_QUERY, rule: 'Run a pending tool only when every dependency has completed evidence.' });
  addEdge('mission', 'decision:dispatch', 'PRODUCED', 'FalkorDB execution policy', 'calculated_estimate');
  steps.forEach((step, ordinal) => {
    addNode(`step:${step.id}`, step.title, 'Step', step.status, 'Model work plan', 'inferred', at, { stepId: step.id, tool: step.tool, args: step.args || {}, draftSourceIds: Array.isArray(step.draftSourceIds)?step.draftSourceIds:[], ordinal, summary: String(step.summary || '').slice(0,4000) });
    addEdge('mission', `step:${step.id}`, 'HAS_STEP', 'Model work plan', 'inferred');
    addEdge('decision:dispatch', `step:${step.id}`, 'GATES', 'FalkorDB dependency-ready query', 'calculated_estimate');
    for (const dependency of step.dependsOn) addEdge(`step:${step.id}`, `step:${dependency}`, 'DEPENDS_ON', 'Model-proposed dependency', 'inferred');
  });
  // Evidence from an earlier plan is retained in mission history as stale. It
  // must not be attached to a new plan whose step IDs may have changed. Also
  // collapse retry duplicates by stable evidence ID before making graph nodes.
  const currentEvidence = new Map();
  for (const item of evidence) {
    if (item.stale) continue;
    if (!stepsById.has(item.stepId)) throw new Error(`Active evidence ${item.id} references unknown work step ${item.stepId}`);
    text(item.id, 'evidence identifier', 100);
    const previous = currentEvidence.get(item.id);
    if (previous && previous.stepId !== item.stepId) throw new Error(`Evidence identifier ${item.id} is reused across work steps`);
    if (!previous) currentEvidence.set(item.id, item);
  }
  const evidenceIds = new Set();
  for (const item of currentEvidence.values()) {
    evidenceIds.add(item.id);
    const observedAt = date(item.observedAt, 'evidence timestamp');
    const source = text(item.source, 'evidence source', 1000);
    const kind = item.evidenceKind || 'observed';
    if (!['observed', 'calculated_estimate', 'inferred', 'user-provided'].includes(kind)) throw new Error('Invalid evidence kind');
    addNode(`evidence:${item.id}`, text(item.title, 'evidence title'), 'Evidence', 'observed', source, kind, observedAt, { evidenceId: item.id, summary: text(item.summary || item.title, 'evidence summary', 20000), ...(item.url ? { url: text(item.url, 'evidence URL', 2000) } : {}) });
    addEdge(`step:${item.stepId}`, `evidence:${item.id}`, 'SUPPORTED_BY', source, kind, observedAt);
  }
  const artifactIds = new Set();
  for (const artifact of artifacts) {
    if (artifact.stale || !Array.isArray(artifact.sourceIds) || artifact.sourceIds.some(id => !evidenceIds.has(id))) continue;
    text(artifact.id, 'artifact identifier', 100);
    if (artifactIds.has(artifact.id) || !Array.isArray(artifact.sourceIds) || artifact.sourceIds.some(id => !evidenceIds.has(id))) throw new Error('Duplicate artifact or unknown artifact source');
    artifactIds.add(artifact.id);
    const verifiedAt = artifact.verifiedAt ? date(artifact.verifiedAt, 'artifact verification time') : null;
    addNode(`artifact:${artifact.id}`, text(artifact.title, 'artifact title'), 'Artifact', verifiedAt ? 'verified' : 'unverified', 'Work artifact', verifiedAt ? 'observed' : 'inferred', verifiedAt || at, { artifactId: artifact.id, content: text(artifact.content, 'artifact content', 100000), sourceIds: artifact.sourceIds, verifiedAt });
    addEdge('mission', `artifact:${artifact.id}`, 'PRODUCED', verifiedAt ? 'Artifact readback' : 'Unverified artifact proposal', verifiedAt ? 'observed' : 'inferred', verifiedAt || at);
    for (const sourceId of artifact.sourceIds) addEdge(`artifact:${artifact.id}`, `evidence:${sourceId}`, 'DERIVED_FROM', 'Artifact source attribution', 'inferred', verifiedAt || at);
  }
  const proposalIds = new Set();
  for (const proposal of proposals) {
    if (!stepsById.has(proposal.stepId)) continue;
    text(proposal.id, 'proposal identifier', 100);
    if (proposalIds.has(proposal.id) || !stepsById.has(proposal.stepId)) throw new Error('Duplicate action proposal or unknown proposal step');
    proposalIds.add(proposal.id);
    const status = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'VERIFIED', 'FAILED', 'UNKNOWN', 'STALE'].includes(proposal.status) ? proposal.status : 'UNKNOWN';
    const createdAt = proposal.createdAt ? date(proposal.createdAt, 'proposal creation time') : at;
    const label = proposal.operation === 'comment_on_pull_request' ? `Comment on ${text(proposal.repository, 'proposal repository', 200)} #${proposal.pullNumber}` : proposal.operation === 'comment_on_issue' ? `Reply on ${text(proposal.repository, 'proposal repository', 200)} #${proposal.issueNumber}` : proposal.operation === 'create_issue' ? `Create issue in ${text(proposal.repository, 'proposal repository', 200)}` : proposal.operation === 'create_commit' ? `Commit ${Array.isArray(proposal.files)?proposal.files.length:0} file(s) to ${text(proposal.repository, 'proposal repository', 200)}` : `Post to ${text(proposal.service, 'proposal service', 100)} channel`;
    addNode(`proposal:${proposal.id}`, label, 'ActionProposal', status, text(proposal.service, 'proposal service', 100), 'inferred', createdAt, { proposalId: proposal.id, operation: proposal.operation, service: proposal.service, channelId: proposal.channelId || null, repository: proposal.repository || null, pullNumber: proposal.pullNumber || null, issueNumber: proposal.issueNumber || null, summary: String(proposal.body || proposal.text || '').slice(0, 5000), revision: proposal.revision || null });
    addEdge('mission', `proposal:${proposal.id}`, 'PROPOSES', 'Agent action proposal', 'inferred', createdAt);
    addEdge(`proposal:${proposal.id}`, `step:${proposal.stepId}`, 'DERIVED_FROM', 'Graph-ready investigative step', 'inferred', createdAt);
  }
  if (JSON.stringify({ nodes, edges }).length > 2000000) throw new Error('Work graph payload exceeds budget');
  return { nodes, edges };
}

export function createWorkGraph({ url = process.env.FALKORDB_URL || '', prefix = 'mova_work_' } = {}) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,60}$/.test(prefix)) throw new Error('Invalid work graph prefix');
  let client, connecting;
  const queues = new Map(), initialized = new Set();
  const name = mission => { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(mission?.id)) throw new Error('Invalid work mission identifier'); return `${prefix}${mission.id}`; };
  const connect = async () => {
    if (client) return client;
    if (!url) throw new Error('FalkorDB work graph is unavailable');
    if (!connecting) connecting = FalkorDB.connect({ url, socket: { connectTimeout: 2000, reconnectStrategy: false } }).then(value => { client = value; return value; }).catch(() => { throw new Error('FalkorDB work graph is unavailable'); }).finally(() => { connecting = null; });
    return connecting;
  };
  const serialize = (mission, operation) => {
    const graphName = name(mission);
    const previous = queues.get(graphName) || Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    queues.set(graphName, result);
    return result.finally(() => { if (queues.get(graphName) === result) queues.delete(graphName); });
  };
  const query = async (mission, cypher, params = {}, write = false) => {
    const graph = (await connect()).selectGraph(name(mission));
    return graph[write ? 'query' : 'roQuery'](cypher, { params, TIMEOUT: 1000 });
  };
  async function readSnapshot(mission) {
    const rows = await query(mission, 'MATCH (:WorkItem:Mission {id:$id,ready:true}) MATCH (n:WorkItem) RETURN n.payload AS payload,n.status AS status,n.evidenceKind AS evidenceKind LIMIT 141', { id: 'mission' });
    if (!rows.data?.length) return { nodes: [], edges: [] };
    const relationships = await query(mission, 'MATCH (:WorkItem:Mission {id:$id,ready:true}) MATCH (:WorkItem)-[r]->(:WorkItem) RETURN r.payload AS payload LIMIT 3000', { id: 'mission' });
    return { nodes: rows.data.map(row => ({ ...JSON.parse(row.payload), status: row.status, evidenceKind: row.evidenceKind })), edges: (relationships.data || []).map(row => JSON.parse(row.payload)) };
  }
  return {
    status: () => ({ connected: Boolean(client), backend: client ? 'falkordb' : 'unavailable' }),
    async init() { await connect(); return { connected: true, backend: 'falkordb' }; },
    sync(mission) {
      let model; try { model = materialize(mission); } catch (error) { return Promise.reject(error); }
      return serialize(mission, async () => {
        const graphName = name(mission);
        if (!initialized.has(graphName)) {
          const indexes = await query(mission, 'CALL db.indexes()', {}, true);
          if (!indexes.data?.length) await query(mission, 'CREATE INDEX FOR (n:WorkItem) ON (n.id)', {}, true);
          initialized.add(graphName);
        }
        const revision = randomUUID();
        await query(mission, 'MERGE (m:WorkItem:Mission {id:$id}) SET m.ready=false', { id: 'mission' }, true);
        for (const type of NODE_LABELS) {
          const rows = model.nodes.filter(node => node.type === type).map(node => ({ id: node.id, payload: JSON.stringify(node), status: node.status, evidenceKind: node.evidenceKind, stepId: node.properties.stepId || '', ordinal: node.properties.ordinal ?? -1 }));
          if (rows.length) await query(mission, `UNWIND $rows AS row MERGE (n:WorkItem:${type} {id:row.id}) SET n.payload=row.payload,n.status=row.status,n.evidenceKind=row.evidenceKind,n.stepId=row.stepId,n.ordinal=row.ordinal,n.revision=$revision`, { rows, revision }, true);
        }
        await query(mission, 'MATCH (n:WorkItem) WHERE n.revision<>$revision DETACH DELETE n', { revision }, true);
        await query(mission, 'MATCH (:WorkItem)-[r]->(:WorkItem) DELETE r', {}, true);
        for (const type of RELATIONSHIPS) {
          const rows = model.edges.filter(edge => edge.label === type).map(edge => ({ id: edge.id, from: edge.source, to: edge.target, payload: JSON.stringify(edge) }));
          if (rows.length) await query(mission, `UNWIND $rows AS row MATCH (a:WorkItem {id:row.from}),(b:WorkItem {id:row.to}) MERGE (a)-[r:${type} {id:row.id}]->(b) SET r.payload=row.payload`, { rows }, true);
        }
        await query(mission, 'MATCH (m:Mission {id:$id}) SET m.ready=true', { id: 'mission' }, true);
        return readSnapshot(mission);
      });
    },
    ready(mission) { return serialize(mission, async () => { const params = { missionNodeId: 'mission' }; const result = await query(mission, READY_QUERY, params); return { stepIds: (result.data || []).map(row => row.stepId), query: READY_QUERY, params, source: 'FalkorDB work dependency traversal', timeoutMs: 1000 }; }); },
    analyzeImpact(mission) { return serialize(mission, async () => { const params={missionNodeId:'mission'};const result=await query(mission,IMPACT_RANK_QUERY,params);const results=(result.data||[]).map((row,index)=>{let payload={};try{payload=JSON.parse(row.payload||'{}');}catch{}const label=typeof payload.label==='string'?payload.label:row.nodeId;return {id:String(row.nodeId||index),title:label.slice(0,160),nodeType:typeof payload.type==='string'?payload.type:'WorkItem',summary:`FalkorDB ranked this node across ${Number(row.pathCount)||0} multi-hop path${Number(row.pathCount)===1?'':'s'}; degree ${Number(row.degree)||0}; nearest mission path ${Number(row.nearestHop)||0} hop${Number(row.nearestHop)===1?'':'s'}.`,evidenceKind:'calculated_estimate',hopCount:Number(row.nearestHop)||0,pathCount:Number(row.pathCount)||0,degree:Number(row.degree)||0};});return {results,source:'FalkorDB multi-hop impact ranking',observedAt:new Date().toISOString(),evidenceKind:'calculated_estimate',query:IMPACT_RANK_QUERY,params,algorithm:'Evidence-Constrained Dispatch impact ranking'};}); },
    snapshot(mission) { return serialize(mission, () => readSnapshot(mission)); },
    async close() { await Promise.allSettled([...queues.values()]); if (connecting) await connecting.catch(() => {}); if (client) await client.close(); client = null; initialized.clear(); },
  };
}
