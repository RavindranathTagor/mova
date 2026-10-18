export function attentionEventKey(mission,kind='blocked'){
  if(!mission?.id)return '';
  const input=mission.inputRequest;
  const failedStep=mission.work?.steps?.find(step=>['failed','blocked'].includes(String(step.status).toLowerCase()));
  const eventId=kind==='clarification'
    ?[input?.id||'',failedStep?.id||'',input?.question?.trim()||''].join(':')
    :kind==='proposal'
      ?mission.work?.proposals?.find(item=>item.status==='PENDING_APPROVAL')?.id
      :failedStep?.id||mission.summary?.trim();
  return JSON.stringify([kind,mission.id,eventId||'unidentified']);
}

export function contextPayload(value){
  if(typeof value!=='string'||!value.trim())return null;
  return {text:value.trim()};
}

export function resumeRequest(missionId){
  if(typeof missionId!=='string'||!missionId.trim())return null;
  return {path:`/api/missions/${encodeURIComponent(missionId)}/resume`,body:{}};
}

export function missingIssueInputRequest(mission){
  if(mission?.kind!=='work'||mission.state!=='BLOCKED'||Number(mission.clarificationCount||0)>=1)return null;
  const step=mission.work?.steps?.find(item=>item.status==='blocked'&&item.tool==='propose_github_issue'&&/No matching GitHub issue evidence was retrieved/i.test(item.summary||''));
  if(!step)return null;
  const question='Which open GitHub issues should MOVA compare?';
  return {
    id:`missing-issues:${step.id}`,
    question,
    options:['Provide the two issue URLs or numbers.','Correct the repository owner/name and provide the issue URLs or numbers.'],
    placeholder:'Paste the GitHub issue URLs or owner/repository and issue numbers.',
    reason:step.summary,
  };
}

export function workFailureDetail(mission){
  const step=mission?.work?.steps?.find(item=>item.status==='failed');
  if(!step)return '';
  const notes=mission.work?.lookupNotes;
  return (Array.isArray(notes)?[...notes].reverse().find(note=>typeof note==='string'&&note.startsWith(`Skipped ${step.title}:`)):null)||step.summary||'';
}

export function alternativeSourceInstruction(mission){
  const step=mission?.work?.steps?.find(item=>item.status==='failed');
  if(!step)return 'Revise the plan to use a different evidence source. If the requested source is unavailable, finish with the verified evidence and clearly state the remaining evidence gap.';
  const target=typeof step.args?.url==='string'?step.args.url:typeof step.args?.path==='string'?step.args.path:'';
  const failure=workFailureDetail(mission);
  return `Do not repeat failed step "${step.title}" (${step.tool}${target?` ${target.slice(0,300)}`:''})${failure?`: ${failure.slice(0,500)}`:''}. Use a different verified evidence source; if unavailable, finish with the current verified evidence and clearly state the evidence gap.`.slice(0,1800);
}

export function readAttentionDrafts(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return {};
  return Object.fromEntries(Object.entries(value).filter(([key,text])=>typeof key==='string'&&typeof text==='string').map(([key,text])=>[key,text.slice(0,2000)]));
}

export function isInvalidWorkArgumentsError(value){
  return typeof value==='string'&&(/Invalid arguments\.content for work step [\w-]+: (?:must contain at least \d+ characters|synthesized content is missing|must contain non-whitespace content)\.?/i.test(value.trim())||/The synthesized answer content (?:is missing|is empty or contains only whitespace)\.?/i.test(value.trim()));
}
