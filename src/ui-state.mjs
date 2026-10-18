const activeStates=new Set(['DETECTED','MISSION_CREATED','BUILDING_CONTEXT','INVESTIGATING','PLANNING','POLICY_CHECK','EXECUTING','REPLANNING']);
const readable=value=>String(value||'').toLowerCase().replaceAll('_',' ');

export function investigationStatus(mission,pending=false){
  if(pending)return {label:'Submitting your request…',active:true};
  if(!mission)return {label:'Waiting for an investigation',active:false};
  const approval=mission.state==='AWAITING_APPROVAL'||mission.work?.proposals?.some(item=>item.status==='PENDING_APPROVAL');
  if(approval)return {label:'Waiting for your approval',active:false};
  if(mission.state==='BLOCKED')return {label:mission.inputRequest?.question?'Needs your input':'Blocked · continue when ready',active:false};
  if(['FAILED_RETRYABLE','UNKNOWN'].includes(mission.state))return {label:'Needs recovery',active:false};
  if(mission.state==='RESOLVED')return {label:'Investigation complete',active:false};
  if(mission.state==='VERIFYING')return {label:mission.kind==='travel'?'Waiting for arrival evidence':'Verifying evidence',active:true};
  if(mission.state==='EXECUTING'){
    const current=mission.work?.steps?.find(step=>step.status==='running');
    return {label:current?`Waiting for ${current.title}`:'Waiting for tool results',active:true};
  }
  if(activeStates.has(mission.state))return {label:mission.summary||'Investigating…',active:true};
  return {label:readable(mission.state),active:false};
}

export function restoreMissionId(envelope,preferredId,freshRequest=false){
  if(freshRequest)return undefined;
  const preferred=envelope?.missions?.find(mission=>mission.id===preferredId);
  if(preferred&&activeStates.has(preferred.state))return preferred.id;
  const active=[...(envelope?.missions||[])].reverse().find(mission=>activeStates.has(mission.state));
  if(active)return active.id;
  return envelope?.mission?.id;
}

export function claimOnce(key,shown,storage){
  if(shown.has(key))return false;
  try{if(storage?.getItem(key)){shown.add(key);return false;}storage?.setItem(key,'1');}catch{}
  shown.add(key);return true;
}
