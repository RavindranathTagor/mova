import {createStore} from './store.mjs';

const keys={discord:'DISCORD_ALLOWED_CHANNEL_IDS',github:'GITHUB_ALLOWED_REPOSITORIES',slack:'SLACK_ALLOWED_CHANNEL_IDS'};
const split=value=>[...new Set(String(value||'').split(',').map(v=>v.trim()).filter(Boolean))];
export const connectedResources=(env=process.env)=>Object.fromEntries(Object.entries(keys).map(([service,key])=>[service,split(env[key])]));

export function createResourceRegistry({env=process.env,path='.data/resources.json'}={}){
  const store=createStore({path});let saved={};let queue=Promise.resolve();
  return {
    async init(){const data=await store.load();saved=data.resources||{};for(const [service,values] of Object.entries(saved))if(keys[service]&&Array.isArray(values))env[keys[service]]=values.join(',');},
    list:()=>connectedResources(env),
    update(service,values){
      const task=queue.then(async()=>{
        if(!keys[service]||!Array.isArray(values)||values.length>30||values.some(v=>typeof v!=='string'))throw Object.assign(new Error('Invalid resource list.'),{status:400});
        const next=[...new Set(values.map(v=>v.trim()))];
        const pattern=service==='github'?/^[\w.-]+\/[\w.-]+$/:service==='discord'?/^\d{15,22}$/:/^[A-Z0-9]{6,30}$/;
        if(next.some(v=>!pattern.test(v)))throw Object.assign(new Error(service==='github'?'Use owner/repository.':'Use a valid channel ID.'),{status:400});
        const updated={...saved,[service]:next};
        await store.save({version:1,resources:updated});saved=updated;env[keys[service]]=next.join(',');
        return connectedResources(env);
      });queue=task.catch(()=>{});return task;
    },
  };
}
