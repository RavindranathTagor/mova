import { useEffect, useRef, useState } from 'react';
import { LocateFixed, Plus, Minus, Route, Maximize2, Navigation } from 'lucide-react';
import type { Mission } from '../types';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './MissionMap.css';

type Position = { latitude:number; longitude:number; accuracy?:number; fixTime?:string };
export default function MissionMap({mission,selectedPlan,onSelect,onLocate,mapsProvider='tomtom',tileUrl='https://tile.openstreetmap.org/{z}/{x}/{y}.png',trackingPosition}:{mission:Mission;selectedPlan?:string;onSelect:(id:string)=>void;mapsKey?:string;onLocate:()=>void;mapsProvider?:string;tileUrl?:string;trackingPosition?:Position|null}) {
  const host=useRef<HTMLDivElement>(null);
  const map=useRef<L.Map|null>(null);
  const routes=useRef<L.LayerGroup|null>(null);
  const locations=useRef<L.LayerGroup|null>(null);
  const bounds=useRef(L.latLngBounds([]));
  const fittedMission=useRef('');
  const select=useRef(onSelect); select.current=onSelect;
  const [error,setError]=useState('');
  const selected=mission.plans.find(p=>p.id===selectedPlan);
  const receipt=[...mission.receipts].reverse().find(r=>r.tool==='open_navigation' && r.status==='UNVERIFIED');
  const guidanceActive=Boolean(receipt && (!receipt.navigationTarget?.planId || receipt.navigationTarget.planId===selected?.id));
  const fit=()=>{if(bounds.current.isValid())map.current?.fitBounds(bounds.current,{padding:[45,65],maxZoom:16,animate:false});};

  useEffect(()=>{
    if(!host.current)return;
    const instance=L.map(host.current,{zoomControl:false,attributionControl:true,zoomAnimation:false}).setView([20.6,78.9],5);
    map.current=instance;
    L.tileLayer(tileUrl,{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Routes: '+(mapsProvider==='tomtom'?'<a href="https://www.tomtom.com">TomTom</a>':'OSRM')}).addTo(instance).on('tileerror',()=>setError('Some map tiles could not load. Route estimates and directions remain available.'));
    routes.current=L.layerGroup().addTo(instance);
    locations.current=L.layerGroup().addTo(instance);
    const resize=new ResizeObserver(()=>instance.invalidateSize({pan:false}));resize.observe(host.current);
    fittedMission.current='';
    return()=>{resize.disconnect();instance.remove();map.current=null;routes.current=null;locations.current=null;};
  },[tileUrl,mapsProvider]);

  useEffect(()=>{
    const layer=routes.current;if(!layer)return;
    layer.clearLayers();bounds.current=L.latLngBounds([]);
    const plans=mission.mode==='live' ? mission.plans : [];
    plans.forEach(plan=>{
      const path=plan.coordinates.map(([lng,lat])=>L.latLng(lat,lng));path.forEach(p=>bounds.current.extend(p));
      const active=plan.id===selectedPlan;
      const line=L.polyline(path,{color:active?'#3467c9':'#8b9fb7',weight:active?7:4,opacity:active?1:.65}).addTo(layer);
      line.on('click',()=>select.current(plan.id));
      const label=document.createElement('span');label.textContent=`${plan.name} · ${plan.durationMinutes} min estimate`;line.bindTooltip(label);
      if(active) {
        line.bringToFront();
        for(const section of plan.trafficSections || []) {
          if(section.delaySeconds===null || section.delaySeconds<=0)continue;
          const traffic=L.polyline(path.slice(section.startPointIndex,section.endPointIndex+1),{color:'#d16830',weight:8,opacity:1}).addTo(layer);
          const detail=document.createElement('span');detail.textContent=`${section.category} · ${Math.ceil(section.delaySeconds/60)} min delay · TomTom`;traffic.bindTooltip(detail);
        }
      }
    });
    [mission.origin,mission.destination].forEach(p=>{if(p)bounds.current.extend([p.latitude,p.longitude]);});
    if(bounds.current.isValid() && fittedMission.current!==mission.id){fit();if(plans.length)fittedMission.current=mission.id;}
  },[mission.id,mission.mode,mission.plans,mission.origin,mission.destination,selectedPlan,tileUrl,mapsProvider]);

  useEffect(()=>{
    const layer=locations.current;if(!layer)return;layer.clearLayers();
    if(mission.mode!=='live')return;
    [mission.origin,mission.destination,trackingPosition].forEach((p,index)=>{
      if(!p)return;const coordinate=L.latLng(p.latitude,p.longitude);
      if(index===2 && trackingPosition?.accuracy && trackingPosition.accuracy>0)L.circle(coordinate,{radius:trackingPosition.accuracy,color:'#3467c9',weight:1,fillOpacity:.08}).addTo(layer);
      const marker=L.circleMarker(coordinate,{radius:index===1?8:7,color:'white',weight:3,fillColor:index===1?'#192b41':index===2?'#3467c9':'#67877c',fillOpacity:1}).addTo(layer);
      const label=document.createElement('span');label.textContent=index===1?'Destination':index===2?'Latest reported phone location':'Route starting point';marker.bindPopup(label);
    });
  },[mission.origin,mission.destination,mission.mode,trackingPosition,tileUrl,mapsProvider]);

  return <div className="mova-map-shell">
    <div className="mission-map mova-real-map">
      <div className="google-map" ref={host}/>
      {error&&<div className="map-error">{error}</div>}
      <div className="map-topline"><span className="map-label"><span className="dot green"/>OpenStreetMap · {mapsProvider==='tomtom'?'TomTom traffic-aware routes':'Road routes'}</span><button className="icon-button" title="Use my location" aria-label="Use my location" onClick={onLocate}><LocateFixed size={17}/></button></div>
      <div className="mova-map-tools"><button aria-label="Fit route" title="Fit route" onClick={fit}><Maximize2 size={17}/></button><button aria-label="Zoom in" onClick={()=>map.current?.zoomIn()}><Plus size={17}/></button><button aria-label="Zoom out" onClick={()=>map.current?.zoomOut()}><Minus size={17}/></button></div>
      {selected&&mission.mode==='live'&&<div className="map-route-pill"><Route size={15}/><strong>{selected.name}</strong><span>{selected.durationMinutes} min estimate</span></div>}
      {mission.mode!=='live'&&<div className="mova-map-empty">Start a live mission to see real routes.</div>}
    </div>
    {selected&&mission.mode==='live'&&<div className="mova-route-evidence"><span>{selected.source} · {new Date(selected.observedAt).toLocaleTimeString()}</span><span>{selected.trafficDelaySeconds==null?'Traffic delay unavailable':`${Math.ceil(selected.trafficDelaySeconds/60)} min reported traffic delay`}</span>{(selected.trafficSections||[]).some(s=>(s.delaySeconds||0)>0)&&<span className="mova-traffic-key">Orange: reported route delay</span>}</div>}
    {guidanceActive&&selected&&<section className="mova-guidance" aria-label="In-page route directions"><header><Navigation size={18}/><div><strong>Directions to your destination</strong><p>Stay in MOVA · Route estimate, arrival unverified</p></div></header>{selected.maneuvers?.length?<ol>{selected.maneuvers.map((step,index)=><li key={`${index}-${step.distanceMeters}`}><span className="mova-step-number">{index+1}</span><div><strong>{step.instruction}</strong><small>{step.distanceMeters===null?'Distance unavailable':`${(step.distanceMeters/1000).toFixed(1)} km from start`}{step.travelTimeSeconds!==null?` · ${Math.ceil(step.travelTimeSeconds/60)} min from start`:''}</small></div>{step.point&&<button aria-label={`Show direction ${index+1} on map`} onClick={()=>map.current?.setView([step.point!.latitude,step.point!.longitude],17,{animate:false})}><LocateFixed size={16}/></button>}</li>)}</ol>:<p className="mova-no-guidance">This provider returned no turn instructions. The selected route remains visible on the map.</p>}</section>}
  </div>;
}
