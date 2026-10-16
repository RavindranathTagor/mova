import { LocateFixed, Radio, RefreshCw, ExternalLink, Pause, Play, ShieldCheck } from 'lucide-react';
import type { Tracking } from '../types';
export default function TrackingPanel({tracking,onRefresh,onToggle}:{tracking?:Tracking;onRefresh:()=>void;onToggle:()=>void}){
  if(!tracking)return null;
  const fix=tracking.position;
  const fresh=fix&&Date.now()-fix.timestamp<=120000;
  return <section className="tracking-panel" aria-label="Live device tracking"><span className="tracking-icon"><LocateFixed size={19}/></span><div className="tracking-copy"><strong>Traccar <span>SELF-HOSTED TRACKING</span></strong><p>{tracking.error||(!tracking.configured?'Connect your phone to your own tracking server.':!tracking.enabled?'Tracking is paused.':fix?`${fresh?'Fresh position':'Stale position'} · ${new Date(fix.timestamp).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})} · ${fix.accuracy?`±${Math.round(fix.accuracy)} m`:'accuracy unknown'}`:'Waiting for the first device position.')}</p></div>{tracking.configured?<div className="tracking-actions"><button title="Refresh device position" aria-label="Refresh device position" onClick={onRefresh}><RefreshCw size={15}/></button><button onClick={onToggle}>{tracking.enabled?<Pause size={13}/>:<Play size={13}/>}<span>{tracking.enabled?'Pause':'Resume'}</span></button></div>:<a className="tracking-link" href={tracking.serverUrl} target="_blank" rel="noreferrer">Open server<ExternalLink size={13}/></a>}<span className={`dot ${tracking.configured&&fresh&&tracking.enabled?'green':'amber'}`}/></section>;
}
