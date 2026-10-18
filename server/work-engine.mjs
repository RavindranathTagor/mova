import {createHash} from 'node:crypto';
import {createToolSession} from './tool-session.mjs';
import {toolService} from './workflows.mjs';

const allowed = new Set(['web_search','read_web_page','read_github_repository','read_github_repository_tree','read_github_repository_snapshot','analyze_github_blast_radius','read_github_code','read_github_commits','read_github_issues','read_slack_channel','read_discord_channel','analyze_falkordb_impact','propose_github_pr_comment','propose_github_issue_comment','propose_github_issue','propose_github_commit','propose_slack_message','propose_discord_message','save_artifact','list_artifacts','get_calendar_events']);
const proposalTools = new Set(['propose_github_pr_comment','propose_github_issue_comment','propose_github_issue','propose_github_commit','propose_slack_message','propose_discord_message']);
const deferredPlanProperties = new Map([
  ['propose_github_pr_comment',['body']],
  ['propose_github_issue_comment',['body']],
  ['propose_github_issue',['title','body']],
  ['propose_github_commit',['message','files']],
  ['propose_slack_message',['text']],
  ['propose_discord_message',['text']],
  ['save_artifact',['content']],
]);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function validateToolArguments(step, tool, deferredProperties=new Set()) {
  const schema=tool?.inputSchema||{};
  const args=step.args;
  const fail=(path,reason)=>{throw new Error(`Invalid ${path} for work step ${step.id}: ${reason}.`);};
  const check=(value,rule,path)=>{
    if(!rule||typeof rule!=='object')return;
    const types=Array.isArray(rule.type)?rule.type:[rule.type];
    if(types[0]){
      const valid=types.some(type=>{
        switch(String(type).toLowerCase()){
          case 'null':return value===null;
          case 'string':return typeof value==='string';
          case 'integer':return Number.isSafeInteger(value);
          case 'number':return typeof value==='number'&&Number.isFinite(value);
          case 'boolean':return typeof value==='boolean';
          case 'object':return value!==null&&typeof value==='object'&&!Array.isArray(value);
          case 'array':return Array.isArray(value);
          default:return true;
        }
      });
      if(!valid)throw new Error(`Invalid argument type for ${path.replace(/^arguments\.?/,'')} in work step ${step.id}.`);
    }
    if(Array.isArray(rule.enum)&&!rule.enum.some(item=>JSON.stringify(item)===JSON.stringify(value)))throw new Error(`Invalid argument value for ${path.replace(/^arguments\.?/,'')} in work step ${step.id}.`);
    if(Object.hasOwn(rule,'const')&&JSON.stringify(rule.const)!==JSON.stringify(value))fail(path,'value does not match the required constant');
    if(typeof value==='string'){
      if(Number.isInteger(rule.minLength)&&value.length<rule.minLength)fail(path,`must contain at least ${rule.minLength} characters`);
      if(Number.isInteger(rule.maxLength)&&value.length>rule.maxLength)fail(path,`must contain at most ${rule.maxLength} characters`);
    }
    if(typeof value==='number'){
      if(typeof rule.minimum==='number'&&value<rule.minimum)fail(path,`must be at least ${rule.minimum}`);
      if(typeof rule.maximum==='number'&&value>rule.maximum)fail(path,`must be at most ${rule.maximum}`);
      if(typeof rule.exclusiveMinimum==='number'&&value<=rule.exclusiveMinimum)fail(path,`must be greater than ${rule.exclusiveMinimum}`);
      if(typeof rule.exclusiveMaximum==='number'&&value>=rule.exclusiveMaximum)fail(path,`must be less than ${rule.exclusiveMaximum}`);
    }
    if(Array.isArray(value)){
      if(Number.isInteger(rule.minItems)&&value.length<rule.minItems)fail(path,`must contain at least ${rule.minItems} items`);
      if(Number.isInteger(rule.maxItems)&&value.length>rule.maxItems)fail(path,`must contain at most ${rule.maxItems} items`);
      if(rule.items)value.forEach((item,index)=>check(item,rule.items,`${path}[${index}]`));
    }
    if(value!==null&&typeof value==='object'&&!Array.isArray(value)){
      const properties=rule.properties||{};
      for(const key of rule.required||[])if(!Object.hasOwn(value,key)||value[key]===undefined)fail(`${path}.${key}`,'required property is missing');
      for(const [key,item] of Object.entries(value)){
        if(Object.hasOwn(properties,key))check(item,properties[key],`${path}.${key}`);
        else if(rule.additionalProperties===false)fail(`${path}.${key}`,'property is not allowed');
        else if(rule.additionalProperties&&typeof rule.additionalProperties==='object')check(item,rule.additionalProperties,`${path}.${key}`);
      }
    }
  };
  for(const key of schema.required||[])if(!deferredProperties.has(key)&&(!Object.hasOwn(args,key)||args[key]===undefined))throw new Error(`Missing required argument ${key} for work step ${step.id}.`);
  if(schema.additionalProperties===false&&Object.keys(args).some(key=>!Object.hasOwn(schema.properties||{},key)))throw new Error(`Unexpected argument for work step ${step.id}.`);
  const properties=Object.fromEntries(Object.entries(schema.properties||{}).filter(([key])=>!deferredProperties.has(key)));
  const checkedArgs=Object.fromEntries(Object.entries(args).filter(([key])=>!deferredProperties.has(key)));
  check(checkedArgs,{...schema,properties,required:(schema.required||[]).filter(key=>!deferredProperties.has(key))},'arguments');
}

export async function approveWorkProposal({mission,proposalId,revision,reject=false,execute}) {
  if(!mission?.work?.proposals||revision!==mission.revision)throw new Error('The action proposal belongs to a different mission revision.');
  const proposal=mission.work.proposals.find(item=>item.id===proposalId);
  if(!proposal||proposal.status!=='PENDING_APPROVAL'||proposal.revision!==revision)throw new Error('This action proposal is no longer pending approval.');
  if(reject){proposal.status='REJECTED';proposal.resolvedAt=new Date().toISOString();return {status:'REJECTED',proposalId};}
  if(typeof execute!=='function')throw new Error('No action executor is available.');
  proposal.status='APPROVED';proposal.approvedAt=new Date().toISOString();
  try{
    const result=await execute({...proposal,status:'PENDING_APPROVAL'});
    proposal.status=result?.status==='VERIFIED'?'VERIFIED':'UNKNOWN';proposal.result={source:result?.source||null,remoteId:result?.remoteId||null,url:result?.url||null};proposal.resolvedAt=new Date().toISOString();
    return {...result,status:proposal.status,proposalId};
  }catch(error){proposal.status='UNKNOWN';proposal.resolvedAt=new Date().toISOString();proposal.error='The approved external action did not return a confirmed result.';throw error;}
}

export function validateWorkPlan(plan, tools) {
  if(plan?.status==='blocked')throw new Error(String(plan.summary||'The requested outcome needs an unavailable capability.').slice(0,500));
  if(plan?.status!=='ready'||!Array.isArray(plan.steps)||plan.steps.length<1||plan.steps.length>7)throw new Error('The model returned an invalid bounded work plan.');
  const names=new Set(tools.map(t=>t.name));const ids=new Set();
  for(const step of plan.steps){
    if(typeof step.id!=='string'||!/^[a-zA-Z0-9_-]{1,40}$/.test(step.id)||ids.has(step.id))throw new Error('Work step IDs must be unique and bounded.');ids.add(step.id);
    if((!allowed.has(step.tool)&&step.tool!=='recall_agent_memory'&&!step.tool.startsWith('mcp_'))||!names.has(step.tool))throw new Error('The work plan requested an unavailable tool: '+step.tool);
    if(typeof step.title!=='string'||!step.title.trim()||step.title.length>160||!step.args||Array.isArray(step.args)||typeof step.args!=='object'||!Array.isArray(step.dependsOn))throw new Error('Invalid typed work step.');
    const deferredProperties=step.tool==='save_artifact'||step.dependsOn.length?deferredPlanProperties.get(step.tool)||[]:[];
    validateToolArguments(step,tools.find(tool=>tool.name===step.tool),new Set(deferredProperties));
  }
  const visit=(id,stack=new Set())=>{if(stack.has(id))throw new Error('Work dependencies contain a cycle.');const step=plan.steps.find(s=>s.id===id);if(!step)throw new Error('Work dependency is missing.');for(const dependency of step.dependsOn)visit(dependency,new Set([...stack,id]));};
  for(const id of ids)visit(id);
  const saves=plan.steps.filter(s=>s.tool==='save_artifact');
  if(saves.length>1)throw new Error('One artifact write is allowed per work revision.');
  if(saves.length&&!names.has('list_artifacts'))throw new Error('Artifact persistence requires a readback tool.');
  if(saves.length){const save=saves[0];save.dependsOn=plan.steps.filter(s=>s!==save).map(s=>s.id);if(plan.steps.some(s=>s!==save&&s.dependsOn.includes(save.id)))throw new Error('Source reads cannot depend on artifact writes.');}
  return plan.steps.map(s=>({...s,status:'pending',summary:''}));
}

function requireGraphImpact(plan,catalog){
  if(!catalog.some(tool=>tool.name==='analyze_falkordb_impact')||!Array.isArray(plan?.steps)||plan.steps.some(step=>step.tool==='analyze_falkordb_impact'))return plan;
  const evidenceSteps=plan.steps.filter(step=>step.tool==='web_search'||step.tool==='recall_agent_memory'||step.tool.startsWith('read_')||step.tool.startsWith('mcp_'));
  if(!evidenceSteps.length||plan.steps.length>=7)return plan;
  let id='graph_impact';let suffix=1;while(plan.steps.some(step=>step.id===id)){id=`graph_impact_${suffix++}`;}
  const impact={id,title:'Rank multi-hop evidence impact in FalkorDB',tool:'analyze_falkordb_impact',args:{},dependsOn:evidenceSteps.map(step=>step.id)};
  for(const step of plan.steps)if(proposalTools.has(step.tool)||step.tool==='save_artifact')step.dependsOn=[...new Set([...step.dependsOn,id])];
  return {...plan,steps:[...plan.steps,impact]};
}

function ensureGithubIssueSearches(plan,resources,catalog,text){
  if(plan?.status!=='ready'||!Array.isArray(plan.steps)||/#\d+\b|\b(?:issue|ticket)\s*#?\d+\b/i.test(text))return plan;
  const comments=plan.steps.filter(step=>step.tool==='propose_github_issue_comment'&&!Number.isInteger(step.args?.issueNumber));
  const issueRequest=/\b(?:issue|feature request|feature|bug|rejected|declined|duplicate|previously requested)\b/i.test(text);
  const issueTool=catalog.find(tool=>tool.name==='read_github_issues');
  const repositories=[...new Set((resources?.github||[]).filter(repository=>typeof repository==='string'&&repository.trim()))];
  if((!comments.length&&!issueRequest)||!issueTool||!repositories.length)return plan;
  const query=String(text).replace(/\s+/g,' ').trim().slice(0,180);
  const steps=plan.steps.map(step=>({...step,args:{...step.args},dependsOn:[...step.dependsOn]}));
  const reads=[];
  for(const repository of repositories){
    let read=steps.find(step=>step.tool==='read_github_issues'&&step.args.repository===repository);
    if(!read){
      if(steps.length>=7)continue;
      let id=`issue_search_${reads.length+1}`,suffix=1;while(steps.some(step=>step.id===id))id=`issue_search_${reads.length+1}_${suffix++}`;
      read={id,title:`Search ${repository} issues for a matching target`,tool:'read_github_issues',args:{repository,query},dependsOn:[]};steps.push(read);
    }else{delete read.args.issueNumber;read.args={...read.args,repository,query};}
    reads.push(read);
  }
  if(!reads.length)return plan;
  for(const comment of comments){
    const target=steps.find(step=>step.id===comment.id);
    target.dependsOn=[...new Set([...target.dependsOn,...reads.map(step=>step.id)])];
  }
  return {...plan,steps};
}

function githubEvidenceFallback(resources,catalog,text){
  const issueTool=catalog.find(tool=>tool.name==='read_github_issues');
  const repositories=[...new Set((resources?.github||[]).filter(repository=>typeof repository==='string'&&repository.trim()))];
  if(!issueTool||!repositories.length||!(/\b(?:issue|feature request|feature|bug|rejected|declined|duplicate|previously requested)\b/i.test(text)))return null;
  const steps=[];const query=String(text).replace(/\s+/g,' ').trim().slice(0,180);
  for(const repository of repositories){
    if(steps.length>=7)break;
    steps.push({id:`issue_search_${steps.length+1}`,title:`Search ${repository} issues for relevant feature requests`,tool:'read_github_issues',args:{repository,query},dependsOn:[]});
  }
  for(const [tool,title] of [['read_github_repository','Read configured repository context'],['read_github_commits','Check recent repository changes']]){
    if(steps.length>=7)break;
    if(catalog.some(item=>item.name===tool))for(const repository of repositories){
      if(steps.length>=7)break;
      steps.push({id:`repo_evidence_${steps.length+1}`,title:`${title}: ${repository}`,tool,args:{repository},dependsOn:[]});
    }
  }
  return steps.length?{status:'ready',summary:'The planner could not complete its plan, so MOVA is checking configured GitHub issues and repository evidence before deciding what can be answered.',steps}:null;
}

function ensureActionEvidenceSteps(steps,resources,catalog,text){
  if(!steps.some(step=>proposalTools.has(step.tool)))return null;
  // Missing issue-number comment plans are handled by the repository-wide
  // issue search insertion below; do not add a duplicate search here.
  if(steps.some(step=>step.tool==='propose_github_issue_comment'))return null;
  const existingReads=steps.some(step=>{
    if(proposalTools.has(step.tool))return false;
    const tool=catalog.find(item=>item.name===step.tool);
    return tool?.effect==='read'||step.tool==='analyze_falkordb_impact'||step.tool==='recall_agent_memory';
  });
  if(existingReads)return null;
  const repos=[...(resources?.github||[])];
  const requestedRepo=repos.find(repo=>String(text).toLowerCase().includes(repo.toLowerCase())||String(text).toLowerCase().includes(repo.split('/').at(-1).toLowerCase()));
  const repository=requestedRepo||repos[0];
  if(!repository)return null;
  const reads=[];
  if(catalog.some(tool=>tool.name==='read_github_issues'))reads.push({id:'evidence_issue_search',title:`Search configured GitHub issues in ${repository}`,tool:'read_github_issues',args:{repository,query:String(text).replace(/\s+/g,' ').trim().slice(0,180)},dependsOn:[]});
  const repoTool=catalog.some(tool=>tool.name==='read_github_repository')?'read_github_repository':catalog.some(tool=>tool.name==='read_github_repository_tree')?'read_github_repository_tree':null;
  if(repoTool)reads.push({id:'evidence_repository',title:`Read configured repository evidence from ${repository}`,tool:repoTool,args:{repository},dependsOn:[]});
  if(!reads.length||steps.length+reads.length>6)return null;
  const ids=new Set(steps.map(step=>step.id));
  for(const read of reads){let base=read.id,suffix=1;while(ids.has(read.id))read.id=`${base}_${suffix++}`;ids.add(read.id);}
  const dependencies=reads.map(step=>step.id);
  return [...reads,...steps.map(step=>({...step,dependsOn:[...new Set([...step.dependsOn,...dependencies])]}))];
}

function sourceEvidence(output,step,revision){
  if(!output||typeof output.source!=='string'||!Number.isFinite(Date.parse(output.observedAt)))throw new Error('Tool returned no verifiable source and timestamp.');
  const rows=(Array.isArray(output.results)?output.results:Array.isArray(output.evidence)?output.evidence:[output]).filter(row=>{
    const content=row?.summary??row?.snippet??row?.content??row?.text;
    return typeof content!=='string'||content.trim().length>0;
  });
  return rows.slice(0,8).map((row,index)=>({
    id:`e-${revision}-${step.id}-${index}`,stepId:step.id,title:String(row.title||row.name||step.title).slice(0,160),
    ...(Number.isInteger(row.issueNumber)&&row.issueNumber>0?{issueNumber:row.issueNumber}:{}),...(typeof row.repository==='string'?{repository:row.repository}:{}),
    ...(row.url||output.url?{url:row.url||output.url}:{}),source:output.source,observedAt:output.observedAt,evidenceKind:row.evidenceKind||output.evidenceKind||'observed',
    summary:String(row.summary||row.snippet||row.content||row.text||JSON.stringify(row)).slice(0,3500),...(typeof row.nodeType==='string'?{nodeType:row.nodeType.slice(0,80)}:{}),...(Number.isFinite(row.pathCount)?{pathCount:Math.max(0,Number(row.pathCount))}:{}),...(Number.isFinite(row.degree)?{degree:Math.max(0,Number(row.degree))}:{}),...(Number.isFinite(row.hopCount)?{hopCount:Math.max(0,Number(row.hopCount))}:{}),stale:false,
  }));
}

function manifestDependency(mission,work){
  const request=String(mission.goal||mission.originalGoal||'');
  if(!/\b(?:dependenc(?:y|ies)|packages?|latest release|upgrade)\b/i.test(request))return null;
  const manifests=work.steps.filter(step=>step.tool==='read_github_code'&&typeof step.args?.path==='string'&&/(?:^|\/)package\.json$/i.test(step.args.path));
  const dependencies=[];
  for(const step of manifests){
    for(const item of work.evidence.filter(evidence=>!evidence.stale&&evidence.stepId===step.id)){
      try{
        const manifest=JSON.parse(item.summary);
        for(const section of ['dependencies','devDependencies']){
          if(manifest?.[section]&&typeof manifest[section]==='object'&&!Array.isArray(manifest[section])){
            for(const [name,version] of Object.entries(manifest[section])){
              if(typeof version==='string'&&version.length<=80&&/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,99}$/i.test(name))dependencies.push({name,version});
            }
          }
        }
      }catch(error){
        const note=`Could not derive a dependency search from ${step.args.path}: repository evidence was not valid package JSON.`;
        work.lookupNotes||=[];if(!work.lookupNotes.includes(note))work.lookupNotes.push(note);
      }
    }
  }
  if(!dependencies.length)return null;
  const named=dependencies.find(item=>request.toLowerCase().includes(item.name.toLowerCase()));
  const selected=named||dependencies.find(item=>item.name.toLowerCase()==='react')||dependencies[0];
  const note=`Dependency research target: ${selected.name} at declared range ${selected.version}, read from package.json dependencies. Do not treat package.json.name as a dependency or package.json.private as repository privacy. Only state release and issue claims supported by evidence specific to ${selected.name}; otherwise report the evidence gap.`;
  work.lookupNotes||=[];if(!work.lookupNotes.includes(note))work.lookupNotes.push(note);
  return selected;
}

function dependencySearchQuery(mission,work){
  const dependency=manifestDependency(mission,work);
  return dependency?`${dependency.name} ${dependency.version} latest release official documentation release notes known issues`:null;
}

function sourceSearchQuery(mission,work,step){
  const dependencyQuery=dependencySearchQuery(mission,work);
  return dependencyQuery||`Official sources for ${step.title}: ${String(mission.originalGoal||mission.goal).slice(0,300)}`;
}

function unverifiedPageSearchQuery(mission,work,step){
  const url=step.args?.url;
  const originalRequest=mission.originalGoal||(!mission.contextUpdates?.length?mission.goal:null);
  const userText=[originalRequest,mission.trigger?.content,...(mission.contextUpdates||[]).map(update=>update.text)].filter(value=>typeof value==='string');
  if(typeof url!=='string'||userText.some(text=>text.includes(url))||work.evidence.some(item=>!item.stale&&item.url===url))return null;
  return sourceSearchQuery(mission,work,step);
}


export async function runWorkMission({mission,provider,workTools,workGraph,persist,transition,trace}){
  if(!workTools?.list||!workTools?.call||!workGraph?.sync||!workGraph?.ready||!workGraph?.snapshot)throw new Error('Connect the work tools and FalkorDB work graph before running this task.');
  if(!provider?.planWork||!provider?.synthesizeWork)throw new Error('The configured model does not support structured work planning.');
  const end=Date.now()+180000;
  const bounded=async operation=>{const remaining=end-Date.now();if(remaining<=0)throw new Error('The work-cycle time budget is exhausted. Resume to continue.');let timer;return Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The work-cycle time budget is exhausted. Resume to continue.')),remaining);})]).finally(()=>clearTimeout(timer));};
  const graphImpactTool={name:'analyze_falkordb_impact',description:'Run a FalkorDB multi-hop impact ranking over this mission graph. Use after relevant reads to identify connected evidence paths and the highest-impact decision nodes.',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},effect:'read'};
  const catalog=[...(await workTools.list()).filter(t=>(allowed.has(t.name)||t.name.startsWith('mcp_'))&&(!mission.workflow||mission.workflow.tools.includes(t.name)&&mission.workflow.connectors.includes(toolService(t.name)))),...(typeof workGraph.analyzeImpact==='function'?[graphImpactTool]:[])];
  if(Array.isArray(mission.previousContext))catalog.push({name:'recall_agent_memory',description:'Read persisted previous mission decisions and answers for the currently connected resources. Historical records are not proof of current external state.',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},effect:'read'});
  mission.work||={steps:[],evidence:[],artifacts:[],proposals:[]};
  mission.clarificationCount=Number.isInteger(mission.clarificationCount)?mission.clarificationCount:(mission.inputRequest?1:0);
  // A prior blocker belongs to the previous execution attempt. Clear it as
  // soon as a resume starts so stale clarification UI cannot survive progress.
  delete mission.inputRequest;
  const work=mission.work;
  work.proposals||=[];
  // Recover approvals recorded by earlier versions, which stored the action
  // receipt but did not attach it as evidence to the proposal's work step.
  for(const proposal of work.proposals.filter(item=>item.status==='VERIFIED'&&item.revision===mission.revision)){
    const step=work.steps.find(item=>item.id===proposal.stepId);
    const result=proposal.result||{};
    const evidenceId=`e-${mission.revision}-approved-${proposal.id}`;
    if(step&&!work.evidence.some(item=>item.id===evidenceId)){
      const issueNumber=proposal.operation==='create_issue'?(Number(result.remoteId||0)||Number(String(result.url||'').match(/\/issues\/(\d+)/)?.[1])||undefined):undefined;
      work.evidence.push({id:evidenceId,stepId:step.id,title:`${proposal.operation.replaceAll('_',' ')} verified`,...(issueNumber?{issueNumber}:{}),...(proposal.repository?{repository:proposal.repository}:{}),...(result.url?{url:result.url}:{}),source:result.source||`${proposal.service} action receipt`,observedAt:Number.isFinite(Date.parse(proposal.resolvedAt))?new Date(proposal.resolvedAt).toISOString():new Date().toISOString(),evidenceKind:'observed',summary:`The user-approved ${proposal.operation.replaceAll('_',' ')} was confirmed by ${proposal.service}.${result.remoteId?` Remote ID: ${result.remoteId}.`:''}${result.url?` Receipt: ${result.url}`:''}`,stale:false});
    }
  }
  const cited=(work.synthesis?.sourceIds||work.sourceIds||[]).map(id=>work.evidence.find(item=>item.id===id&&!item.stale)).filter(Boolean);
  const primaryRepositoryEvidence=work.evidence.some(item=>!item.stale&&/github\.com|github/i.test(item.source||'')&&!/discord|slack/i.test(item.source||''));
  if(cited.length&&cited.every(item=>/discord|slack/i.test(item.source||''))&&primaryRepositoryEvidence){
    work.supersededSyntheses||=[];
    work.supersededSyntheses.push({synthesis:work.synthesis?structuredClone(work.synthesis):null,answer:work.answer||null,sourceIds:work.sourceIds||[],at:new Date().toISOString(),reason:'Rebuilt because repository claims cited chat reports despite available GitHub evidence.'});
    if(work.supersededSyntheses.length>5)work.supersededSyntheses=work.supersededSyntheses.slice(-5);
    delete work.synthesis;delete work.answer;delete work.sourceIds;delete work.completedAt;delete work.synthesisLimited;
    for(const artifact of work.artifacts||[])artifact.stale=true;
    trace(mission,'agent','Rechecking chat-reported claims','The saved answer cited chat reports while current GitHub evidence is available. MOVA is rebuilding the answer from the primary repository source.');
  }
  const reconcileGraphReferences=()=>{
    const stepIds=new Set(work.steps.map(step=>step.id));
    const currentById=new Map();
    for(const item of work.evidence){
      if(item.stale)continue;
      if(!stepIds.has(item.stepId))throw new Error(`Active evidence ${item.id} references unknown work step ${item.stepId}.`);
      const previous=currentById.get(item.id);
      if(previous&&previous.stepId!==item.stepId)throw new Error(`Evidence identifier ${item.id} is reused across work steps.`);
      if(previous){item.stale=true;continue;}
      currentById.set(item.id,item);
    }
    const evidenceIds=new Set(currentById.keys());
    for(const artifact of work.artifacts||[])if(artifact.stale||!Array.isArray(artifact.sourceIds)||artifact.sourceIds.some(id=>!evidenceIds.has(id)))artifact.stale=true;
  };
  const sync=async()=>{reconcileGraphReferences();await bounded(workGraph.sync(mission));mission.graph=await bounded(workGraph.snapshot(mission));await persist();};
  if(!work.steps.length){
    await transition(mission,'PLANNING',`${provider.name||'The model'} is planning a bounded sequence of connected tools.`);
    const plan=await bounded(provider.planWork({text:mission.goal,tools:catalog,evidence:work.evidence,operationalContext:mission.operationalContext||null,connectedResources:mission.connectedResources||{},previousContext:mission.previousContext||[],contextUpdates:mission.contextUpdates||[],workflow:mission.workflow||null}));
    if(plan?.status==='blocked'){
      const fallback=githubEvidenceFallback(mission.connectedResources,catalog,mission.goal);
      if(fallback){
        trace(mission,'agent','Continuing with connected GitHub evidence',fallback.summary,{source:'Configured repository search'});
        work.steps=validateWorkPlan(fallback,catalog);work.planRevision=mission.revision;await sync();
      }else{
      const summary=String(plan.summary||'The requested outcome is blocked by an unavailable capability.').slice(0,500);
      if(plan.requiresUserInput===true&&Number(mission.clarificationCount||0)<1&&typeof plan.question==='string'&&plan.question.trim()){
        const question=plan.question.trim().slice(0,500);
        const options=Array.isArray(plan.options)?[...new Set(plan.options.filter(option=>typeof option==='string'&&option.trim()).map(option=>option.trim().slice(0,160)))].slice(0,3):[];
        mission.clarificationCount=1;
        mission.inputRequest={question,options,placeholder:typeof plan.inputHint==='string'&&plan.inputHint.trim()?plan.inputHint.trim().slice(0,300):question,reason:summary};
        trace(mission,'agent','MOVA needs one essential decision',question,{source:'Model structured plan'});
      }else{
        delete mission.inputRequest;
        trace(mission,'agent','Investigation limitation',summary,{source:'Model structured plan',alternative:String(plan.alternative||'Use the available connected evidence to produce a bounded partial result.').slice(0,500)});
      }
      await sync();await transition(mission,'BLOCKED',summary);return;
      }
    }
    if(!work.steps.length){
      const issueAwarePlan=ensureGithubIssueSearches(plan,mission.connectedResources,catalog,mission.goal);
      work.steps=validateWorkPlan(requireGraphImpact(issueAwarePlan,catalog),catalog);work.planRevision=mission.revision;await sync();
      trace(mission,'agent','Work plan created',String(plan.summary||'Tool dependencies planned.').slice(0,500),{source:'Model structured plan'});
    }
  }
  const recoveredEvidencePlan=ensureActionEvidenceSteps(work.steps,mission.connectedResources,catalog,mission.goal);
  if(recoveredEvidencePlan){
    work.steps=validateWorkPlan(requireGraphImpact({status:'ready',summary:'Added repository-scoped evidence reads before approval-gated actions.',steps:recoveredEvidencePlan},catalog),catalog);
    work.planRevision=mission.revision;
    trace(mission,'agent','Added evidence reads before proposed actions','The saved plan contained external action proposals without evidence reads. MOVA inserted repository-scoped reads before drafting any action.',{source:'Work-plan validation'});
    await sync();
  }
  const resumedBlockedStepIds=new Set();
  const hasVerifiedDependencyEvidence=id=>work.evidence.some(item=>!item.stale&&item.stepId===id&&['observed','user-provided','calculated_estimate'].includes(item.evidenceKind||'observed'));
  const reactivateVerifiedBlockedSteps=()=>{
    let changed=false;
    for(const step of work.steps){
      if(step.status==='blocked'&&step.retryable!==false&&step.dependsOn.every(id=>work.steps.find(item=>item.id===id)?.status==='completed'&&hasVerifiedDependencyEvidence(id))){
        step.status='pending';resumedBlockedStepIds.add(step.id);changed=true;
      }
    }
    return changed;
  };
  for(const step of work.steps)if(step.status==='running'||step.status==='failed')step.status='pending';
  const resumedBlockedSteps=reactivateVerifiedBlockedSteps();
  if(resumedBlockedSteps){delete work.synthesis;delete work.answer;delete work.completedAt;delete work.synthesisLimited;}
  await sync();
  let activeStep;
  const session=await createToolSession(catalog,async(name,args)=>{
    if(!activeStep||name!==activeStep.tool&&name!=='list_artifacts')throw new Error('Tool is not active in the graph-ready step.');
    if(name==='analyze_falkordb_impact')return workGraph.analyzeImpact(mission);
    if(name==='recall_agent_memory')return {source:'FalkorDB persistent mission memory',observedAt:new Date().toISOString(),evidenceKind:'observed',results:mission.previousContext.length?mission.previousContext.map(item=>({id:item.id,title:'Previous mission: '+String(item.goal).slice(0,120),summary:JSON.stringify({goal:item.goal,answer:item.answer,state:item.state,recordedAt:item.updatedAt,sources:item.sources}),observedAt:item.updatedAt})): [{id:'no-memory',title:'Persistent memory checked',summary:'No previous missions were found for these connected resources.'}]};
    if(mission.workflow){
      const service=toolService(name),ids=mission.connectedResources?.[service]||[];
      if(args.repository&&!ids.includes(args.repository))throw new Error('Repository is outside the selected workflow resources.');
      if(args.channelId&&!ids.includes(args.channelId))throw new Error('Channel is outside the selected workflow resources.');
    }
    return workTools.call(name,args,{missionId:mission.id,stepId:activeStep.id,idempotencyKey:`${mission.id}:${work.planRevision}:${activeStep.id}`});
  });
  const synthesize=async(final=false)=>{
    if(final)await transition(mission,'VERIFYING',`${provider.name||'The model'} is verifying the result against retrieved evidence.`);
    if(work.synthesis)return work.synthesis;
    const current=work.evidence.filter(e=>!e.stale);
    if(!current.length)throw new Error('No current source evidence was returned; an answer cannot be verified.');
    if(!final)await transition(mission,'PLANNING',`${provider.name||'The model'} is drafting the result from retrieved evidence.`);
    let answer=await bounded(provider.synthesizeWork({text:mission.goal,evidence:current,notes:work.lookupNotes||[]}));
    const cited=new Set(Array.isArray(answer?.sourceIds)?answer.sourceIds:[]);
    const repositoryClaim=/\b(?:github|repositories|repository|repos?|commits?|issues?|issue\s*#?\d+)\b/i.test(String(answer?.answer||''));
    let primary=current.filter(item=>/github\.com|github/i.test(item.source||'')&&!/discord|slack/i.test(item.source||''));
    let citesPrimary=current.some(item=>cited.has(item.id)&&/github\.com|github/i.test(item.source||'')&&!/discord|slack/i.test(item.source||''));
    if(repositoryClaim&&!citesPrimary){
      if(primary.length){
        const notes=[...(work.lookupNotes||[]),'Repository claims must be supported by the supplied GitHub evidence below. Chat messages are reports only and cannot verify issue numbers, commits, or repository state.'];
        answer=await bounded(provider.synthesizeWork({text:mission.goal,evidence:primary,notes}));
        citesPrimary=primary.some(item=>Array.isArray(answer?.sourceIds)&&answer.sourceIds.includes(item.id));
      }
    }
    if(typeof answer?.answer!=='string')throw new Error('The synthesized answer content is missing.');
    if(!answer.answer.trim())throw new Error('The synthesized answer content is empty or contains only whitespace.');
    const invalidCitations=!Array.isArray(answer.sourceIds)||!answer.sourceIds.length||answer.sourceIds.some(id=>!current.some(e=>e.id===id))||repositoryClaim&&!citesPrimary;
    if(invalidCitations&&primary.length){
      const sourceIds=primary.map(item=>item.id);
      const detail=primary.map(item=>`${item.title}${item.url?` (${item.url})`:''}`).join('; ').slice(0,1800);
      answer={answer:`MOVA could not verify a source-backed conclusion because the model did not return valid citations to current GitHub evidence. No repository or issue findings are asserted. The available primary-source records are: ${detail}. Review those records or revise the request before relying on a comparison or recommendation.`,title:'Partial result: source citations could not be verified',sourceIds};
      work.synthesisLimited=true;
      work.lookupNotes||=[];work.lookupNotes.push('The model did not provide valid citations to current GitHub evidence after one constrained synthesis retry. MOVA recorded a source-limited result and did not assert repository findings.');
      trace(mission,'decision','Source-limited result recorded','Citation verification failed after a constrained retry. MOVA retained a transparent limitation and did not claim unsupported repository findings.',{source:'Current GitHub evidence',evidenceIds:sourceIds});
    }
    if(answer.answer.length>6000||typeof answer.title!=='string'||!Array.isArray(answer.sourceIds)||!answer.sourceIds.length||answer.sourceIds.some(id=>!current.some(e=>e.id===id))||repositoryClaim&&!citesPrimary&&!work.synthesisLimited)throw new Error('The model returned an answer without valid current primary-source evidence references.');
    work.synthesis={answer:answer.answer,title:answer.title.slice(0,160),sourceIds:[...new Set(answer.sourceIds)]};await persist();return work.synthesis;
  };
  const draftProposal=async step=>{
    if(step.tool==='propose_github_commit'?!provider.draftCodeChange:!provider.draftAction)throw new Error(`The configured model cannot draft an evidence-backed ${step.tool==='propose_github_commit'?'code change':'external reply'}.`);
    const evidence=work.evidence.filter(item=>!item.stale);
    const target=step.tool==='propose_slack_message'||step.tool==='propose_discord_message'
      ? {channelId:step.args?.channelId}
      : step.tool==='propose_github_pr_comment'
        ? {repository:step.args?.repository,pullNumber:step.args?.pullNumber}
        : step.tool==='propose_github_issue'
          ? {repository:step.args?.repository}
          : step.tool==='propose_github_commit'
            ? {repository:step.args?.repository,branch:step.args?.branch}
          : {repository:step.args?.repository,issueNumber:step.args?.issueNumber};
    if(step.tool==='propose_github_issue_comment'&&!Number.isInteger(target.issueNumber)){
      if(typeof provider.resolveGithubIssue!=='function')throw new Error('MOVA cannot safely select a GitHub issue from connected evidence.');
      const candidates=evidence.filter(item=>(!target.repository||item.repository===target.repository)&&Number.isInteger(item.issueNumber)&&item.issueNumber>0);
      const match=await bounded(provider.resolveGithubIssue({text:mission.goal,evidence:candidates}));
      const selected=candidates.find(item=>item.id===match?.evidenceId);
      if(!selected){
        const alternatives=candidates.slice(0,3).map(item=>`${item.title}${item.url?` (${item.url})`:''}`);
        const note=`No exact GitHub issue match was found in ${target.repository||'the configured repository'}; MOVA did not prepare or post an issue comment.${alternatives.length?` Closest search results, not confirmed matches: ${alternatives.join('; ')}.`:' The repository search returned no usable issue candidates.'} Best alternative: present these linked candidates for manual selection, or prepare a standalone issue proposal if creating a new issue was requested.`;
        work.lookupNotes||=[];work.lookupNotes.push(note);
        step.status='completed';step.completedAt=new Date().toISOString();step.summary='No exact issue match; no comment was proposed.';
        trace(mission,'agent','No exact GitHub issue match',note,{source:'Repository-scoped GitHub issue search',evidenceIds:candidates.map(item=>item.id)});
        await sync();return false;
      }
      target.repository=selected.repository||target.repository;target.issueNumber=selected.issueNumber;step.args={...step.args,...target};
      trace(mission,'decision','GitHub issue selected from evidence',`Issue #${selected.issueNumber} was selected from a confident match in retrieved repository evidence.`,{source:selected.source,evidenceIds:[selected.id]});
    }
    if(Object.values(target).some(value=>value===undefined||value===null||value===''))throw new Error('The planned external reply is missing its destination. Add the channel, repository, or discussion number.');
    const requiresIssueFindings=step.tool==='propose_github_issue'&&/\b(?:compare|prioriti[sz]e|highest[- ]priority|impact and urgency|based on)\b/i.test(mission.goal)&&/\bissues?\b/i.test(mission.goal);
    const hasIssueEvidence=evidence.some(item=>Number.isInteger(item.issueNumber)&&item.issueNumber>0||/github\.com\/[^/]+\/[^/]+\/issues\/\d+/i.test(item.url||''));
    if(requiresIssueFindings&&!hasIssueEvidence){
      const reason='No matching GitHub issue evidence was retrieved, so MOVA cannot compare issues, recommend a priority, or draft a derived issue.';
      step.status='blocked';step.retryable=false;step.summary=reason;
      if(Number(mission.clarificationCount||0)<1){
        mission.clarificationCount=1;
        mission.inputRequest={
          id:`missing-issues:${step.id}`,
          question:'Which open GitHub issues should MOVA compare?',
          options:['Provide the two issue URLs or numbers.','Correct the repository owner/name and provide the issue URLs or numbers.'],
          placeholder:'Paste the GitHub issue URLs or owner/repository and issue numbers.',
          reason,
        };
      }
      work.lookupNotes||=[];work.lookupNotes.push(`${reason} No external action was created or sent.`);
      trace(mission,'decision','Issue proposal withheld',step.summary,{tool:step.tool,status:'BLOCKED',evidenceIds:evidence.map(item=>item.id)});
      await sync();return false;
    }
    await transition(mission,'PLANNING',`${provider.name||'The model'} is drafting ${step.tool==='propose_github_commit'?'a bounded code change':'a reply'} from current evidence for your review.`);
    let draft;
    try{
      draft=step.tool==='propose_github_commit'
        ? await bounded(provider.draftCodeChange({text:mission.goal,target,evidence}))
        : await bounded(provider.draftAction({text:mission.goal,action:step.tool,target,evidence}));
    }catch(error){
      const detail=String(error?.message||'The connected model did not return a draft.').slice(0,240);
      work.lookupNotes||=[];work.lookupNotes.push(`Could not prepare ${step.tool.replace(/^propose_/,'').replaceAll('_',' ')}: ${detail}. No external action was sent. Continue with the verified research and state that the draft remains unavailable.`);
      step.status='failed';step.summary='Proposal drafting failed; no external action was created or sent.';
      trace(mission,'tool','Action draft unavailable',step.summary,{tool:step.tool,status:'FAILED'});
      await sync();return false;
    }
    if(draft.status==='blocked'){
      const reason=draft.content.slice(0,1000);
      step.status='blocked';step.retryable=false;step.summary=`No external proposal was prepared: ${reason}`;
      work.lookupNotes||=[];work.lookupNotes.push(`${step.summary} No external action was created or sent.`);
      trace(mission,'decision','External proposal withheld',step.summary,{tool:step.tool,status:'BLOCKED',evidenceIds:draft.sourceIds});
      await sync();return false;
    }
    try{
      if(step.tool==='propose_github_commit'){
        if(typeof draft.message!=='string'||!draft.message.trim()||!Array.isArray(draft.files)||!draft.files.length)throw new Error('The model returned an invalid evidence-backed code change.');
        step.args={...step.args,...target,message:draft.message,files:draft.files};
      }else{
        if(typeof draft.content!=='string'||!draft.content.trim())throw new Error('The model returned empty or whitespace-only evidence-backed action content.');
        const key=step.tool==='propose_slack_message'||step.tool==='propose_discord_message'?'text':'body';
        step.args={...step.args,...target,[key]:draft.content};
      }
      step.draftSourceIds=draft.sourceIds;
      if(step.tool==='propose_github_issue'&&!step.args.title)step.args.title=mission.goal.replace(/\s+/g,' ').slice(0,120);
      validateToolArguments(step,catalog.find(tool=>tool.name===step.tool));
    }catch(error){
      const detail=String(error?.message||'The generated proposal did not meet the tool requirements.').slice(0,240);
      work.lookupNotes||=[];work.lookupNotes.push(`Could not prepare ${step.tool.replace(/^propose_/,'').replaceAll('_',' ')}: ${detail}. No external action was created or sent.`);
      step.status='failed';step.summary='Proposal validation failed; no external action was created or sent.';
      trace(mission,'tool','Action draft unavailable',step.summary,{tool:step.tool,status:'FAILED'});
      await sync();return false;
    }
    trace(mission,'agent','Reply drafted from evidence',`Prepared a reviewable ${step.tool.replace(/^propose_/,'').replaceAll('_',' ')} proposal from ${draft.sourceIds.length} current source record${draft.sourceIds.length===1?'':'s'}.`,{source:'Model evidence-backed draft',evidenceIds:draft.sourceIds});
    await sync();
    return true;
  };
  try{
    for(let round=0;round<12&&work.steps.some(s=>s.status==='pending'||s.status==='running');round++){
      const ready=await bounded(workGraph.ready(mission));
      const graphStep=work.steps.find(s=>s.status==='pending'&&ready.stepIds?.includes(s.id));
      const locallyVerifiedResumeStep=!graphStep&&work.steps.find(step=>step.status==='pending'&&resumedBlockedStepIds.has(step.id)&&step.dependsOn.every(id=>work.steps.find(item=>item.id===id)?.status==='completed'&&hasVerifiedDependencyEvidence(id)));
      const step=graphStep||locallyVerifiedResumeStep;
      trace(mission,'graph',step?locallyVerifiedResumeStep?'Revalidating saved dependency before resume':`Dispatch gate before ${step.title}`:'Dependency-ready tools queried',step?locallyVerifiedResumeStep?`FalkorDB did not release this saved step, so MOVA rechecked all ${step.dependsOn.length} direct dependencies and found current verified evidence before resuming it.`:`FalkorDB released this step after checking ${step.dependsOn.length} direct ${step.dependsOn.length===1?'dependency':'dependencies'} and their evidence.`:`${ready.stepIds?.length||0} steps are ready from persisted graph dependencies.`,{tool:'work_graph_ready',query:ready.query,params:ready.params,source:locallyVerifiedResumeStep?'Local dependency revalidation':'FalkorDB',result:{readyStepIds:ready.stepIds||[],releasedStepId:step?.id||null,dependencyStepIds:step?.dependsOn||[]}});
      if(!step){
        const blocked=work.steps.filter(item=>item.status==='pending');
        if(blocked.length&&!work.evidence.some(item=>!item.stale))throw new Error('No pending step is graph-ready. Resolve its missing or failed dependencies before resuming.');
        if(blocked.length){
          work.lookupNotes||=[];
          for(const item of blocked){item.status='blocked';item.summary='Skipped because a required step did not produce verified evidence.';work.lookupNotes.push(`Skipped ${item.title}: a required dependency did not produce verified evidence. Do not claim this step or its outcome succeeded.`);trace(mission,'tool','Dependent step skipped',item.summary,{tool:item.tool,status:'SKIPPED'});}
          await sync();
        }
        break;
      }
      activeStep=step;
      const dependency=step.tool==='web_search'?manifestDependency(mission,work):null;
      const groundedDependencyQuery=dependency?`${dependency.name} ${dependency.version} latest release official documentation release notes known issues`:null;
      if(groundedDependencyQuery&&(!String(step.args?.query||'').toLowerCase().includes(dependency.name.toLowerCase())||!String(step.args?.query||'').includes(dependency.version))){
        step.args={...step.args,query:groundedDependencyQuery};
        trace(mission,'agent','Search grounded in the repository manifest',`The search now targets ${dependency.name} at its declared version ${dependency.version}.`,{tool:step.tool,source:'Verified package.json evidence'});
        await sync();
      }
      const unverifiedPageQuery=step.tool==='read_web_page'?unverifiedPageSearchQuery(mission,work,step):null;
      if(unverifiedPageQuery){
        const plannedUrl=step.args.url;
        step.tool='web_search';step.title='Search for an evidence-backed official source';step.args={query:unverifiedPageQuery};
        work.lookupNotes||=[];work.lookupNotes.push(`The planned page ${plannedUrl} was not present in the request or current source evidence, so MOVA did not fetch it. MOVA searched for an evidence-backed source instead.`);
        trace(mission,'tool','Unverified page URL replaced with a source search','The planned webpage URL was neither requested nor returned by an earlier evidence step. MOVA searched for a supported source URL instead of fetching an invented or unverified address.',{tool:'web_search',source:'Source URL validation',query:unverifiedPageQuery});
        await sync();
      }
      if(step.tool==='save_artifact'){
        try{
          const result=await synthesize();
          step.args={title:result.title,content:result.answer.trim(),sourceIds:result.sourceIds};
          validateToolArguments(step,catalog.find(tool=>tool.name===step.tool));
        }catch(error){
          step.status='failed';step.summary=error.message;await sync();
          throw error;
        }
      }
      if(proposalTools.has(step.tool)&&await draftProposal(step)===false)continue;
      step.status='running';await sync();await transition(mission,'EXECUTING',step.title);
      const idempotencyKey=`${mission.id}:${work.planRevision}:${step.id}`;
      let output;
      if(step.tool==='save_artifact'){
        const listing=await bounded(session.call('list_artifacts',{}));
        output=(listing.artifacts||[]).find(a=>a.idempotencyKey===idempotencyKey);
      }
      if(!output){
        const effect=catalog.find(tool=>tool.name===step.tool)?.effect;
        const attempts=effect==='read'?2:1;
        let lastError;
        for(let attempt=0;attempt<attempts;attempt++){
          try{output=await bounded(session.call(step.tool,step.args));break;}
          catch(error){lastError=error;if(step.tool==='read_web_page'&&/\((?:403|404)\)/.test(String(error?.message||'')))break;if(attempt+1<attempts)trace(mission,'tool','Retrying read tool safely',`${step.title} failed; retrying the read once.`,{tool:step.tool,status:'RETRY'});}
        }
        if(!output&&step.tool==='read_web_page'&&/\((?:403|404)\)/.test(String(lastError?.message||''))){
          const query=sourceSearchQuery(mission,work,step);
          const failedUrl=step.args.url;step.tool='web_search';step.title='Search for an accessible source alternative';step.args={query};step.status='pending';step.summary='The webpage could not be read; searching for an alternative source without claiming its page content was verified.';
          work.lookupNotes||=[];work.lookupNotes.push(`The requested page ${failedUrl} could not be read (${String(lastError.message).slice(0,120)}). MOVA searched for an alternative and will not claim direct verification of that page.`);
          trace(mission,'tool','Webpage unavailable; searching alternative sources',`The source returned ${String(lastError.message).match(/\(\d{3}\)/)?.[0]||'an HTTP error'}. MOVA will continue with a targeted source search and preserve this limitation.`,{tool:'web_search',status:'FALLBACK',query});
          await sync();activeStep=undefined;continue;
        }
        if(!output&&/outside the selected workflow/i.test(String(lastError?.message||'')))throw lastError;
        if(!output&&step.tool==='read_github_repository_snapshot'&&/above the configured .*safety limit|exceeded the configured .*safety limit/i.test(String(lastError?.message||''))&&catalog.some(tool=>tool.name==='read_github_repository_tree')){
          step.tool='read_github_repository_tree';step.args={repository:step.args.repository,...(step.args.ref?{ref:step.args.ref}:{})};step.status='pending';step.summary='Full snapshot exceeded the configured safety limit; retrying with the complete repository tree.';
          trace(mission,'tool','Using bounded repository tree fallback',`${step.args.repository} snapshot exceeded the configured size limit. MOVA is retrieving the complete tree so targeted code reads can still be planned; no partial snapshot is claimed.`,{tool:'read_github_repository_tree',status:'RETRY'});
          await sync();activeStep=undefined;continue;
        }
        if(!output){
          const detail=String(lastError?.message||'The tool returned no result.').slice(0,240);
          step.status='failed';step.summary='Skipped because the tool did not return verified evidence.';
          work.lookupNotes||=[];work.lookupNotes.push(`Skipped ${step.title}: the connected tool failed${lastError?' ('+detail+')':''}. No evidence or successful outcome was recorded.`);
          trace(mission,'tool','Tool step skipped after failure',step.summary,{tool:step.tool,status:'SKIPPED'});
          await sync();activeStep=undefined;continue;
        }
      }
      if(step.tool==='save_artifact'){
        const artifact=output.artifact||output;
        const listing=await bounded(session.call('list_artifacts',{}));
        const saved=(listing.artifacts||[]).find(a=>a.id===artifact.id);
        if(!saved||saved.content!==step.args.content||digest(saved.sourceIds)!==digest(step.args.sourceIds)||!saved.verifiedAt)throw new Error('The saved artifact failed persisted readback verification.');
        if(!work.artifacts.some(a=>a.id===saved.id))work.artifacts.push({...saved,stepId:step.id});
        const evidenceId=`e-${mission.revision}-${step.id}-saved`;
        if(!work.evidence.some(e=>e.id===evidenceId))work.evidence.push({id:evidenceId,stepId:step.id,title:saved.title,source:'Persisted artifact readback',observedAt:saved.verifiedAt,evidenceKind:'observed',summary:'The artifact content and source references were read back and matched the requested write.',stale:false});
        step.summary='Artifact saved and verified by reading persisted content.';
      }else if(output?.proposal){
        const proposal=output.proposal;
        if(!proposal.id||proposal.status!=='PENDING_APPROVAL'||work.proposals.some(item=>item.id===proposal.id))throw new Error('The connector returned an invalid action proposal.');
        work.proposals.push({...proposal,stepId:step.id,revision:mission.revision});
        step.summary='Action proposal is ready for your approval. Nothing has been sent.';
      }else{
        const evidence=sourceEvidence(output,step,mission.revision);
        if(!evidence.length)throw new Error('The source returned no evidence for this step.');
        const evidenceById=new Map();
        for(const item of work.evidence){const previous=evidenceById.get(item.id);if(!previous||previous.stale&&!item.stale)evidenceById.set(item.id,item);}
        for(const item of evidence)evidenceById.set(item.id,item);
        work.evidence=[...evidenceById.values()];if(work.evidence.length>60)work.evidence=work.evidence.slice(-60);
        if(step.tool==='read_github_issues'&&evidence.some(item=>/no matching issues|issue search returned no matches/i.test(`${item.title} ${item.summary}`))){
          work.lookupNotes||=[];work.lookupNotes.push(`No matching issues were returned by the configured repository search for ${step.args.repository}. Use other retrieved repository evidence to explain what can be established and offer a useful alternative; do not invent an issue or treat absence from search as proof that none exists.`);
        }
        step.summary=`Retrieved ${evidence.length} source record${evidence.length===1?'':'s'}.`;
      }
      step.status='completed';step.completedAt=new Date().toISOString();
      mission.receipts.push({id:`work-${mission.revision}-${step.id}`,tool:step.tool,status:'VERIFIED',at:step.completedAt,summary:step.summary,idempotencyKey,revision:mission.revision,verification:{source:output.source||'Persisted artifact readback',stepId:step.id}});
      reactivateVerifiedBlockedSteps();
      trace(mission,'tool',step.title,step.summary,{tool:step.tool,source:output.source||'Persisted artifact',status:'VERIFIED',...(output.query?{query:output.query,params:output.params}: {})});await sync();
    }
    const unfinished=work.steps.filter(step=>step.status==='pending'||step.status==='running');
    if(unfinished.length){
      work.lookupNotes||=[];
      for(const step of unfinished){step.status='blocked';step.summary='Skipped because its dependency could not be verified within the work-step budget.';work.lookupNotes.push(`Skipped ${step.title}: its dependencies could not be verified within the work-step budget.`);}
      await sync();
    }
    if(!work.evidence.some(item=>!item.stale))throw new Error('No verified source evidence was available to answer this request. The investigation stopped without asking for unrelated clarification.');
    const result=await synthesize(true);work.answer=result.answer;work.sourceIds=result.sourceIds;work.completedAt=new Date().toISOString();
    await sync();
    const incomplete=work.synthesisLimited||work.steps.some(step=>step.status==='failed'||step.status==='blocked')||work.proposals.some(proposal=>proposal.status==='PENDING_APPROVAL');
    await transition(mission,incomplete?'BLOCKED':'RESOLVED',work.synthesisLimited?'A source-limited result is available. MOVA could not verify the model’s GitHub citations, so it made no repository findings. Review the cited records or revise the request.':incomplete?'A verified partial result is available, but one or more required steps failed, were skipped, or still need your approval. The limitation is recorded with the result.':'The requested research or local deliverable is complete and backed by retrieved evidence.');
  }catch(error){if(activeStep?.status==='running'){activeStep.status='failed';activeStep.summary=error.message;await sync();}throw error;}
  finally{await session.close();}
}
