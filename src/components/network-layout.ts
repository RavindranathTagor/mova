export function networkLayout(ids:string[],edges:{source:string;target:string}[]){
  const count=ids.length,radius=Math.max(160,Math.sqrt(count)*100);
  const points=ids.map((id,i)=>({id,x:Math.cos(i*2*Math.PI/Math.max(1,count))*radius,y:Math.sin(i*2*Math.PI/Math.max(1,count))*radius}));
  const indexes=new Map(ids.map((id,i)=>[id,i]));
  const links=edges.flatMap(e=>{const a=indexes.get(e.source),b=indexes.get(e.target);return a===undefined||b===undefined?[]:[[a,b]];});
  for(let pass=0;pass<140;pass++){
    const force=points.map(p=>({x:-p.x*.005,y:-p.y*.005}));
    for(let i=0;i<count;i++)for(let j=i+1;j<count;j++){
      const dx=points[i].x-points[j].x,dy=points[i].y-points[j].y,d=Math.max(1,Math.hypot(dx,dy)),f=16000/(d*d);
      force[i].x+=dx/d*f;force[i].y+=dy/d*f;force[j].x-=dx/d*f;force[j].y-=dy/d*f;
    }
    for(const [a,b] of links){const dx=points[b].x-points[a].x,dy=points[b].y-points[a].y,d=Math.max(1,Math.hypot(dx,dy)),f=(d-210)*.018;force[a].x+=dx/d*f;force[a].y+=dy/d*f;force[b].x-=dx/d*f;force[b].y-=dy/d*f;}
    points.forEach((p,i)=>{p.x+=Math.max(-12,Math.min(12,force[i].x));p.y+=Math.max(-12,Math.min(12,force[i].y));});
  }
  return new Map(points.map(({id,x,y})=>[id,{x,y}]));
}
