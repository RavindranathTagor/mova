import { createGraph as legacyGraph, demoPlans } from './legacy-graph-fixture.mjs';
export const testRoutes = (duration=45) => demoPlans().map((p,i)=>({...p,id:i===0?'expressway':i===1?'metro':'ring-road',durationMinutes:i===0?duration:p.durationMinutes,source:'Route adapter test fixture',observedAt:new Date().toISOString()}));
export function testGraph(){
 const inner=legacyGraph({url:''});
 return {...inner,status:()=>({connected:true,backend:'test',detail:'Graph contract test double'}),recordApproval:async()=>{},...Object.fromEntries(['seed','evaluate','snapshot','observe','recordAction','recordDecision','findDependencies','findImpactCone'].map(key=>[key,(mission,...args)=>inner[key]({...mission,mode:'demo'},...args)]))};
}
