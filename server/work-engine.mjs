import {createHash} from 'node:crypto';
import {createToolSession} from './tool-session.mjs';
import {toolService} from './workflows.mjs';

const allowed = new Set(['web_search','read_web_page','read_github_repository','read_github_repository_tree','read_github_repository_snapshot','analyze_github_blast_radius','read_github_code','read_github_commits','read_github_issues','read_slack_channel','read_discord_channel','analyze_falkordb_impact','propose_github_pr_comment','propose_github_issue_comment','propose_github_issue','propose_github_commit','propose_slack_message','propose_discord_message','save_artifact','list_artifacts','get_calendar_events']);
const proposalTools = new Set(['propose_github_pr_comment','propose_github_issue_comment','propose_github_issue','propose_github_commit','propose_slack_message','propose_discord_message']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

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

function sourceEvidence(output,step,revision){
  if(!output||typeof output.source!=='string'||!Number.isFinite(Date.parse(output.observedAt)))throw new Error('Tool returned no verifiable source and timestamp.');
  const rows=(Array.isArray(output.results)?output.results:Array.isArray(output.evidence)?output.evidence:[output]).filter(row=>{
    const content=row?.summary??row?.snippet??row?.content??row?.text;
    return typeof content!=='string'||content.trim().length>0;
  });
  return rows.slice(0,8).map((row,index)=>({
    id:`e-${revision}-${step.id}-${index}`,stepId:step.id,title:String(row.title||row.name||step.title).slice(0,160),
    ...(row.url||output.url?{url:row.url||output.url}:{}),source:output.source,observedAt:output.observedAt,evidenceKind:row.evidenceKind||output.evidenceKind||'observed',
    summary:String(row.summary||row.snippet||row.content||row.text||JSON.stringify(row)).slice(0,3500),...(typeof row.nodeType==='string'?{nodeType:row.nodeType.slice(0,80)}:{}),...(Number.isFinite(row.pathCount)?{pathCount:Math.max(0,Number(row.pathCount))}:{}),...(Number.isFinite(row.degree)?{degree:Math.max(0,Number(row.degree))}:{}),...(Number.isFinite(row.hopCount)?{hopCount:Math.max(0,Number(row.hopCount))}:{}),stale:false,
  }));
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
  const work=mission.work;
  work.proposals||=[];
  const sync=async()=>{await bounded(workGraph.sync(mission));mission.graph=await bounded(workGraph.snapshot(mission));await persist();};
  if(!work.steps.length){
    await transition(mission,'PLANNING',`${provider.name||'The model'} is planning a bounded sequence of connected tools.`);
    const plan=await bounded(provider.planWork({text:mission.goal,tools:catalog,evidence:work.evidence,operationalContext:mission.operationalContext||null,connectedResources:mission.connectedResources||{},previousContext:mission.previousContext||[],contextUpdates:mission.contextUpdates||[],workflow:mission.workflow||null}));
    if(plan?.status==='blocked'){
      const question=typeof plan.question==='string'&&plan.question.trim()?plan.question.trim().slice(0,500):String(plan.summary||'What information should MOVA use to continue?').slice(0,500);
      const options=Array.isArray(plan.options)?[...new Set(plan.options.filter(option=>typeof option==='string'&&option.trim()).map(option=>option.trim().slice(0,160)))].slice(0,3):[];
      const placeholder=typeof plan.inputHint==='string'&&plan.inputHint.trim()?plan.inputHint.trim().slice(0,300):question;
      mission.inputRequest={question,options,placeholder,reason:String(plan.summary||question).slice(0,500)};
      trace(mission,'agent','MOVA needs a decision',question,{source:'Model structured plan'});
      await sync();await transition(mission,'BLOCKED',String(plan.summary||question).slice(0,500));return;
    }
    work.steps=validateWorkPlan(requireGraphImpact(plan,catalog),catalog);work.planRevision=mission.revision;await sync();
    trace(mission,'agent','Work plan created',String(plan.summary||'Tool dependencies planned.').slice(0,500),{source:'Model structured plan'});
  }
  for(const step of work.steps)if(step.status==='running'||step.status==='failed')step.status='pending';
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
    const answer=await bounded(provider.synthesizeWork({text:mission.goal,evidence:current}));
    if(typeof answer.answer!=='string'||!answer.answer.trim()||answer.answer.length>6000||typeof answer.title!=='string'||!Array.isArray(answer.sourceIds)||!answer.sourceIds.length||answer.sourceIds.some(id=>!current.some(e=>e.id===id)))throw new Error('The model returned an answer without valid current evidence references.');
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
    if(Object.values(target).some(value=>value===undefined||value===null||value===''))throw new Error('The planned external reply is missing its destination. Add the channel, repository, or discussion number.');
    await transition(mission,'PLANNING',`${provider.name||'The model'} is drafting ${step.tool==='propose_github_commit'?'a bounded code change':'a reply'} from current evidence for your review.`);
    const draft=step.tool==='propose_github_commit'
      ? await bounded(provider.draftCodeChange({text:mission.goal,target,evidence}))
      : await bounded(provider.draftAction({text:mission.goal,action:step.tool,target,evidence}));
    if(step.tool==='propose_github_commit'){
      if(typeof draft.message!=='string'||!draft.message.trim()||!Array.isArray(draft.files)||!draft.files.length)throw new Error('The model returned an invalid evidence-backed code change.');
      step.args={...step.args,...target,message:draft.message,files:draft.files};
    }else{
      const key=step.tool==='propose_slack_message'||step.tool==='propose_discord_message'?'text':'body';
      step.args={...step.args,...target,[key]:draft.content};
    }
    step.draftSourceIds=draft.sourceIds;
    if(step.tool==='propose_github_issue'&&!step.args.title)step.args.title=mission.goal.replace(/\s+/g,' ').slice(0,120);
    trace(mission,'agent','Reply drafted from evidence',`Prepared a reviewable ${step.tool.replace(/^propose_/,'').replaceAll('_',' ')} proposal from ${draft.sourceIds.length} current source record${draft.sourceIds.length===1?'':'s'}.`,{source:'Model evidence-backed draft',evidenceIds:draft.sourceIds});
    await sync();
  };
  try{
    for(let round=0;round<12&&work.steps.some(s=>s.status!=='completed');round++){
      const ready=await bounded(workGraph.ready(mission));
      const step=work.steps.find(s=>s.status==='pending'&&ready.stepIds?.includes(s.id));
      trace(mission,'graph',step?`Dispatch gate before ${step.title}`:'Dependency-ready tools queried',step?`FalkorDB released this step after checking ${step.dependsOn.length} dependency${step.dependsOn.length===1?'':'ies'} and their evidence.`:`${ready.stepIds?.length||0} steps are ready from persisted graph dependencies.`,{tool:'work_graph_ready',query:ready.query,params:ready.params,source:'FalkorDB',result:{readyStepIds:ready.stepIds||[],releasedStepId:step?.id||null,dependencyStepIds:step?.dependsOn||[]}});
      if(!step)throw new Error('No pending step is graph-ready. Resolve its missing or failed dependencies before resuming.');
      activeStep=step;
      if(step.tool==='save_artifact'){
        const result=await synthesize();step.args={title:result.title,content:result.answer,sourceIds:result.sourceIds};
      }
      if(proposalTools.has(step.tool))await draftProposal(step);
      step.status='running';await sync();await transition(mission,'EXECUTING',step.title);
      const idempotencyKey=`${mission.id}:${work.planRevision}:${step.id}`;
      let output;
      if(step.tool==='save_artifact'){
        const listing=await bounded(session.call('list_artifacts',{}));
        output=(listing.artifacts||[]).find(a=>a.idempotencyKey===idempotencyKey);
      }
      output||=await bounded(session.call(step.tool,step.args));
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
        work.evidence.push(...evidence);if(work.evidence.length>60)work.evidence=work.evidence.slice(-60);
        step.summary=`Retrieved ${evidence.length} source record${evidence.length===1?'':'s'}.`;
      }
      step.status='completed';step.completedAt=new Date().toISOString();
      mission.receipts.push({id:`work-${mission.revision}-${step.id}`,tool:step.tool,status:'VERIFIED',at:step.completedAt,summary:step.summary,idempotencyKey,revision:mission.revision,verification:{source:output.source||'Persisted artifact readback',stepId:step.id}});
      trace(mission,'tool',step.title,step.summary,{tool:step.tool,source:output.source||'Persisted artifact',status:'VERIFIED',...(output.query?{query:output.query,params:output.params}: {})});await sync();
    }
    if(work.steps.some(s=>s.status!=='completed'))throw new Error('The bounded work-step budget was reached. Resume to continue.');
    const result=await synthesize(true);work.answer=result.answer;work.sourceIds=result.sourceIds;work.completedAt=new Date().toISOString();
    await sync();await transition(mission,'RESOLVED','The requested research or local deliverable is complete and backed by retrieved evidence.');
  }catch(error){if(activeStep?.status==='running'){activeStep.status='failed';activeStep.summary=error.message;await sync();}throw error;}
  finally{await session.close();}
}
