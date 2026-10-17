import {FalkorDB} from 'falkordb';
import {createHash} from 'node:crypto';

const relatedQuery=`MATCH p=(r:CustomerReport {repository:$repository,fingerprint:$fingerprint})-[:REPORTS]->(i:Incident)-[:TRACKED_BY]->(g:GitHubIssue)
RETURN g.number AS issueNumber,g.url AS url,[n IN nodes(p) | n.id] AS nodeIds LIMIT 5`;
const blastRadiusQuery=`MATCH (r:Repository {id:$repositoryId})-[:CONTAINS]->(changed:RepositoryFile {path:$path})
MATCH (r)-[:CONTAINS]->(affected:RepositoryFile)
OPTIONAL MATCH p=(affected)-[:IMPORTS*1..8]->(changed)
WITH changed,affected,p
WHERE p IS NOT NULL OR affected=changed
RETURN changed.path AS changedPath,affected.path AS path,
CASE WHEN affected=changed THEN 0 ELSE min(length(p)) END AS hopCount,
CASE WHEN affected=changed THEN 1 ELSE count(DISTINCT p) END AS pathCount
ORDER BY hopCount ASC,pathCount DESC,path ASC LIMIT 80`;
const clean=value=>String(value||'').trim();
const repositoryValid=value=>/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value||'');
const sourcePathValid=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/.test(value)&&!value.includes('..')&&!value.includes('//');
const supportedSource=/\.(?:[cm]?[jt]sx?|vue|svelte|py|rb|php|java|kt|go|rs|cs|cpp|c|h)$/i;
const sourcePath=value=>{
 const segments=[];
 for(const segment of String(value||'').split('/')){if(!segment||segment==='.')continue;if(segment==='..')segments.pop();else segments.push(segment);}
 return segments.join('/');
};
const importedPaths=(path,content,available)=>{
 if(!supportedSource.test(path)||typeof content!=='string')return [];
 const base=path.split('/').slice(0,-1);const links=new Set();
 const matcher=/(?:from\s*|import\s*\()(['\"])([^'\"]+)\1/g;
 for(const match of content.matchAll(matcher)){
  const specifier=match[2];if(!specifier.startsWith('.'))continue;
  const raw=sourcePath([...base,...specifier.split('/')].join('/'));
  const candidates=[raw,...['.ts','.tsx','.js','.jsx','.mjs','.cjs','.vue','.svelte'].map(extension=>raw+extension),...['index.ts','index.tsx','index.js','index.jsx','index.mjs','index.cjs','index.vue','index.svelte'].map(name=>`${raw}/${name}`)];
  const target=candidates.find(candidate=>available.has(candidate));if(target)links.add(target);
 }
 return [...links];
};
const reportValid=report=>{
  for(const key of ['id','channelId','repository','fingerprint','summary','observedAt'])if(!clean(report[key]))throw new Error(`Invalid customer report ${key}.`);
  if(!Number.isFinite(Date.parse(report.observedAt)))throw new Error('Invalid customer report observedAt.');
};

export function createOperationsGraph({url=process.env.FALKORDB_URL||'',name='mova_operations'}={}){
  let client,connecting;
  const reports=new Map(),issues=new Map(),reportIssue=new Map(),snapshots=new Map();
  const graph=async()=>{
    if(!url)return null;
    if(client)return client.selectGraph(name);
    if(!connecting)connecting=FalkorDB.connect({url,socket:{connectTimeout:2000,reconnectStrategy:false}}).then(value=>{client=value;return value;}).finally(()=>{connecting=null;});
    return (await connecting).selectGraph(name);
  };
  const write=async(query,params)=>{const active=await graph();if(active)await active.query(query,{params,TIMEOUT:1000});};
  const read=async(query,params)=>{const active=await graph();return active?active.roQuery(query,{params,TIMEOUT:1000}):null;};
  const reportById=async id=>{
    if(reports.has(id))return reports.get(id);
    const result=await read('MATCH (r:CustomerReport {id:$id}) RETURN r.repository AS repository,r.fingerprint AS fingerprint LIMIT 1',{id});
    const row=result?.data?.[0];if(row){const report={id,...row};reports.set(id,report);return report;}
    return null;
  };
  return {
    async init(){
      const active=await graph();
      if(active){
        await active.query('CREATE INDEX FOR (n:AgentMemory) ON (n.id)',{params:{},TIMEOUT:1000}).catch(()=>{});
        await active.query('CREATE INDEX FOR (n:ConnectedResource) ON (n.id)',{params:{},TIMEOUT:1000}).catch(()=>{});
        await active.query('CREATE INDEX FOR (n:CustomerReport) ON (n.id)',{params:{},TIMEOUT:1000}).catch(()=>{});
        await active.query('CREATE INDEX FOR (n:GitHubIssue) ON (n.id)',{params:{},TIMEOUT:1000}).catch(()=>{});
        await active.query('CREATE INDEX FOR (n:RepositoryFile) ON (n.id)',{params:{},TIMEOUT:1000}).catch(()=>{});
      }
      return {connected:Boolean(active),backend:active?'falkordb':'memory'};
    },
    async rememberMission(mission){
      const resources=Object.entries(mission.connectedResources||{}).flatMap(([service,ids])=>ids.map(id=>`${service}:${id}`));
      const evidence=(mission.work?.evidence||[]).filter(e=>!e.stale).slice(-20).map(e=>({id:`${mission.id}:${e.id}`,source:e.source,url:e.url||'',summary:String(e.summary||'').slice(0,1500)}));
      const params={id:mission.id,goal:String(mission.goal).slice(0,3000),answer:String(mission.work?.answer||'').slice(0,4000),state:mission.state,updatedAt:new Date().toISOString(),resources,evidence};
      await write(`MERGE (m:AgentMemory {id:$id}) SET m.goal=$goal,m.answer=$answer,m.state=$state,m.updatedAt=$updatedAt,m.resources=$resources`,params);
      if(mission.workflow){
        const version=createHash('sha256').update(JSON.stringify(mission.workflow)).digest('hex').slice(0,16);
        await write(`MATCH (m:AgentMemory {id:$id}) MERGE (w:WorkflowTemplate {id:$workflowId}) SET w.name=$name,w.summary=$name,w.instructions=$instructions,w.tools=$tools MERGE (m)-[:RUN_OF]->(w)`,{id:mission.id,workflowId:`workflow:${mission.workflow.id}:${version}`,name:mission.workflow.name,instructions:mission.workflow.instructions||'',tools:mission.workflow.tools||[]});
      }
      if(resources.length)await write(`MATCH (m:AgentMemory {id:$id}) UNWIND $resources AS resource MERGE (r:ConnectedResource {id:resource}) MERGE (m)-[:IN_RESOURCE_SCOPE]->(r)`,params);
      if(evidence.length)await write(`MATCH (m:AgentMemory {id:$id}) UNWIND $evidence AS item MERGE (e:MemoryEvidence {id:item.id}) SET e.source=item.source,e.url=item.url,e.summary=item.summary MERGE (m)-[:SUPPORTED_BY]->(e)`,params);
    },
    async recallMissions({excludeId,resources}){
      const ids=Object.entries(resources||{}).flatMap(([service,values])=>values.map(id=>`${service}:${id}`));
      const query=`MATCH (r:ConnectedResource)<-[:IN_RESOURCE_SCOPE]-(m:AgentMemory)
WHERE r.id IN $resources AND m.id <> $excludeId AND all(resource IN m.resources WHERE resource IN $resources)
WITH DISTINCT m ORDER BY m.updatedAt DESC LIMIT 5
OPTIONAL MATCH (m)-[:SUPPORTED_BY]->(e:MemoryEvidence)
RETURN m.id AS id,m.goal AS goal,m.answer AS answer,m.state AS state,m.updatedAt AS updatedAt,collect(e.source) AS sources`;
      const result=await read(query,{excludeId,resources:ids});
      return {memories:result?.data||[],query};
    },
    async snapshot(){
      const rows=await read('MATCH (n) WHERE n.id IS NOT NULL RETURN n.id AS id,labels(n)[0] AS type,properties(n) AS properties ORDER BY n.id LIMIT 120',{});
      const nodes=(rows?.data||[]).map(row=>({id:row.id,type:row.type,label:String(row.properties?.goal||row.properties?.summary||row.properties?.repository||row.id).slice(0,160),properties:row.properties||{},source:'FalkorDB workspace memory',observedAt:row.properties?.updatedAt||row.properties?.observedAt||'',evidenceKind:'observed',status:'healthy'}));
      const relationships=nodes.length?await read('MATCH (a)-[r]->(b) WHERE a.id IN $ids AND b.id IN $ids RETURN a.id AS source,b.id AS target,type(r) AS label LIMIT 300',{ids:nodes.map(n=>n.id)}):null;
      const edges=(relationships?.data||[]).map(row=>({...row,id:`${row.source}:${row.label}:${row.target}`,status:'healthy',provenance:'Persisted FalkorDB relationship',observedAt:'',evidenceKind:'observed',explanation:`${row.source} ${row.label} ${row.target}`}));
      return {nodes,edges,backend:'falkordb',limit:120};
    },
    async upsertReport(report){
      reportValid(report);reports.set(report.id,{...report});
      const incident=`incident:${report.repository}:${report.fingerprint}`;
      await write(`MERGE (r:CustomerReport {id:$id}) SET r.channelId=$channelId,r.repository=$repository,r.fingerprint=$fingerprint,r.summary=$summary,r.observedAt=$observedAt
MERGE (i:Incident {id:$incident}) SET i.repository=$repository,i.fingerprint=$fingerprint
MERGE (r)-[:REPORTS]->(i)`,{...report,incident});
      return {id:report.id,incident};
    },
    async recordIssueReceipt(receipt){
      for(const key of ['reportId','repository','issueNumber','url','idempotencyKey'])if(receipt[key]===undefined||receipt[key]===null||clean(receipt[key])==='')throw new Error(`Invalid issue receipt ${key}.`);
      const report=await reportById(receipt.reportId);if(!report)throw new Error('Customer report must exist before an issue receipt.');
      const id=`issue:${receipt.repository}:${receipt.issueNumber}`;issues.set(id,{...receipt,id});reportIssue.set(receipt.reportId,id);
      const incident=`incident:${report.repository}:${report.fingerprint}`;
      await write(`MATCH (r:CustomerReport {id:$reportId})-[:REPORTS]->(i:Incident {id:$incident})
MERGE (g:GitHubIssue {id:$id}) SET g.number=$issueNumber,g.repository=$repository,g.url=$url,g.idempotencyKey=$idempotencyKey
MERGE (i)-[:TRACKED_BY]->(g)
MERGE (a:ActionReceipt {id:$idempotencyKey}) SET a.url=$url,a.status='VERIFIED'
MERGE (g)-[:CREATED_BY]->(a)`,{...receipt,id,incident});
      return {id};
    },
    async findRelated({repository,fingerprint}){
      const remote=await read(relatedQuery,{repository,fingerprint});
      if(remote?.data?.length){
        const entries=remote.data.map(row=>({issueNumber:Number(row.issueNumber),url:row.url,nodeIds:Array.isArray(row.nodeIds)?row.nodeIds:[]})).filter(row=>Number.isInteger(row.issueNumber));
        return {issueNumbers:entries.map(row=>row.issueNumber),paths:entries};
      }
      const matchingReports=[...reports.values()].filter(report=>report.repository===repository&&report.fingerprint===fingerprint).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));
      const current=matchingReports[0];const matches=[];
      for(const [reportId,id] of reportIssue){const report=reports.get(reportId),issue=issues.get(id);if(report?.repository===repository&&report.fingerprint===fingerprint&&issue)matches.push({issueNumber:Number(issue.issueNumber),url:issue.url,nodeIds:[`report:${current?.id||report.id}`,`incident:${repository}:${fingerprint}`,`issue:${repository}:${issue.issueNumber}`]});}
      const unique=[...new Map(matches.map(item=>[item.issueNumber,item])).values()].slice(0,5);
      return {issueNumbers:unique.map(item=>item.issueNumber),paths:unique};
    },
    async recordNotificationReceipt(receipt){
      const report=await reportById(receipt.reportId);if(!report)throw new Error('Customer report must exist before a notification receipt.');
      await write(`MATCH (r:CustomerReport {id:$reportId}) MERGE (a:ActionReceipt {id:$id}) SET a.status='VERIFIED',a.url=$url MERGE (r)-[:NOTIFIED_BY]->(a)`,receipt);
    },
    async indexRepositorySnapshot({repository,commitSha,files}){
      if(!repositoryValid(repository))throw new Error('Invalid snapshot repository.');
      if(typeof commitSha!=='string'||!/^[a-f0-9]{7,64}$/i.test(commitSha))throw new Error('Invalid snapshot commit identity.');
      if(!Array.isArray(files)||files.length>500)throw new Error('Repository snapshot file budget exceeded.');
      let bytes=0;const unique=new Map();
      for(const file of files){
        if(!file||!sourcePathValid(file.path)||typeof file.content!=='string')throw new Error('Invalid repository snapshot file.');
        bytes+=Buffer.byteLength(file.content,'utf8');if(bytes>5000000)throw new Error('Repository snapshot byte budget exceeded.');
        unique.set(file.path,{path:file.path,content:file.content,sha:typeof file.sha==='string'?file.sha:''});
      }
      const available=new Set(unique.keys());const repositoryId=`repo:${repository}`;
      const records=[...unique.values()].map(file=>({id:`file:${repository}:${file.path}`,path:file.path,sha:file.sha,bytes:Buffer.byteLength(file.content,'utf8'),imports:importedPaths(file.path,file.content,available)}));
      const indexedAt=new Date().toISOString();snapshots.set(repository,{repository,commitSha,files:new Map(records.map(file=>[file.path,file])),indexedAt});
      const params={repositoryId,repository,commitSha,indexedAt,fileIds:records.map(file=>file.id),files:records};
      await write(`MERGE (r:Repository {id:$repositoryId}) SET r.repository=$repository,r.commitSha=$commitSha,r.indexedAt=$indexedAt
WITH r OPTIONAL MATCH (r)-[:CONTAINS]->(obsolete:RepositoryFile) WHERE NOT obsolete.id IN $fileIds
DETACH DELETE obsolete`,params);
      if(records.length){
        await write(`UNWIND $files AS file MATCH (r:Repository {id:$repositoryId})
MERGE (f:RepositoryFile {id:file.id}) SET f.path=file.path,f.sha=file.sha,f.bytes=file.bytes,f.repository=$repository,f.commitSha=$commitSha,f.indexedAt=$indexedAt
MERGE (r)-[:CONTAINS]->(f)`,params);
        await write(`MATCH (r:Repository {id:$repositoryId})-[:CONTAINS]->(source:RepositoryFile)-[edge:IMPORTS]->(target:RepositoryFile)<-[:CONTAINS]-(r) DELETE edge`,params);
        const imports=records.flatMap(file=>file.imports.map(path=>({from:`file:${repository}:${file.path}`,to:`file:${repository}:${path}`})));
        if(imports.length)await write(`UNWIND $imports AS item MATCH (source:RepositoryFile {id:item.from}),(target:RepositoryFile {id:item.to}) MERGE (source)-[:IMPORTS]->(target)`,{imports});
      }
      return {repository,commitSha,indexedFiles:records.length,importEdges:records.reduce((total,file)=>total+file.imports.length,0),source:'FalkorDB repository dependency graph',observedAt:indexedAt};
    },
    async repositoryBlastRadius({repository,path}){
      if(!repositoryValid(repository)||!sourcePathValid(path))throw new Error('Invalid repository blast-radius target.');
      const repositoryId=`repo:${repository}`;const remote=await read(blastRadiusQuery,{repositoryId,path});
      let rows=remote?.data;
      if(!rows){
        const snapshot=snapshots.get(repository);const changed=snapshot?.files.get(path);
        if(!changed)throw new Error('No complete indexed repository snapshot contains this file. Read the repository snapshot before calculating its blast radius.');
        const reverse=new Map();for(const file of snapshot.files.values())for(const target of file.imports){const dependents=reverse.get(target)||[];dependents.push(file.path);reverse.set(target,dependents);}
        const impact=new Map([[path,{hopCount:0,pathCount:1}]]);const queue=[path];
        for(let cursor=0;cursor<queue.length;cursor++){
          const target=queue[cursor],current=impact.get(target);if(current.hopCount>=8)continue;
          for(const dependent of reverse.get(target)||[]){const nextHop=current.hopCount+1,existing=impact.get(dependent);if(!existing||nextHop<existing.hopCount){impact.set(dependent,{hopCount:nextHop,pathCount:current.pathCount});queue.push(dependent);}else if(nextHop===existing.hopCount)existing.pathCount+=current.pathCount;}
        }
        rows=[...impact.entries()].map(([item,value])=>({changedPath:path,path:item,...value}));
      }
      const results=(rows||[]).map(row=>({id:`${repository}:${row.path}`,title:row.path,path:row.path,nodeType:'RepositoryFile',hopCount:Number(row.hopCount)||0,pathCount:Number(row.pathCount)||1,summary:row.path===path?`Changed source file ${path}.`:`${row.path} depends on ${path} across ${Number(row.hopCount)||0} import hop(s).`}));
      if(!results.length)throw new Error('No complete indexed repository snapshot contains this file. Read the repository snapshot before calculating its blast radius.');
      return {complete:true,repository,path,results,source:'FalkorDB repository dependency blast-radius query',observedAt:new Date().toISOString(),evidenceKind:'calculated_estimate',query:blastRadiusQuery,params:{repositoryId,path}};
    },
    async close(){if(connecting)await connecting.catch(()=>{});if(client)await client.close();client=null;},
  };
}
