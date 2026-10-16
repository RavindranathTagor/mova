import { useEffect, useState } from 'react';
import { Check, ExternalLink, KeyRound, Plug, RefreshCw, Settings2 } from 'lucide-react';
import './connections.css';

type Connector = {
  id: string; name: string; purpose: string; configured: boolean; unsupported?: boolean; comingSoon?: boolean;
  status: 'connected' | 'unverified' | 'disconnected' | 'unavailable' | 'permission_required' | 'unsupported' | 'rate_limited';
  detail: string; checkedAt: string | null; lastSuccessAt: string | null; checking: boolean;
  keys: string[]; steps: string[]; links: { label: string; url: string }[];
  checkDescription: string; action?: { label: string; url: string }; retryAfterSeconds?: number;
};
const labels: Record<Connector['status'], string> = { connected: 'Verified', unverified: 'Not checked', disconnected: 'Not configured', unavailable: 'Needs attention', permission_required: 'Permission needed', unsupported: 'Not supported', rate_limited: 'Rate limited' };
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function Connections() {
  const [items, setItems] = useState<Connector[]>([]);
  const [busy, setBusy] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [drafts,setDrafts]=useState<Record<string,Record<string,string>>>({});
  useEffect(() => {
    const controller = new AbortController();
    const load = () => fetch('/api/connectors', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Could not load connections.');
      const data = await response.json(); setItems(data.connectors);
    }).catch(e => { if (e.name !== 'AbortError') setError('Could not load connections. Check that the MOVA server is running.'); });
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  const check = async (id: string) => {
    setBusy(current => [...current, id]); setError('');
    try {
      const response = await fetch(`/api/connectors/${encodeURIComponent(id)}/check`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mova-client': 'web' }, body: '{}' });
      if (!response.ok) throw new Error('Connection check failed.');
      const result: Connector = await response.json();
      setItems(current => current.map(item => item.id === id ? result : item));
    } catch { setError('The check could not finish. Check the MOVA server and try again.'); }
    finally { setBusy(current => current.filter(value => value !== id)); }
  };
  const configure=async(item:Connector)=>{
    const values=drafts[item.id]||{};
    setBusy(current=>[...current,item.id]);setError('');
    try{
      const response=await fetch(`/api/connectors/${encodeURIComponent(item.id)}/configure`,{method:'POST',headers:{'Content-Type':'application/json','x-mova-client':'web'},body:JSON.stringify({values})});
      const result:Connector=await response.json();if(!response.ok)throw new Error('Connection setup failed.');
      setItems(current=>current.map(value=>value.id===item.id?result:value));setDrafts(current=>({...current,[item.id]:{}}));
    }catch{setError('Connection setup could not be saved in this local session. Check every required value and try again.');}
    finally{setBusy(current=>current.filter(value=>value!==item.id));}
  };
  const coreIds=new Set(['web','github','slack','discord','calendar','weather','graph']);
  const upcoming=items.filter(item=>item.comingSoon);
  return <section className="mova-connections" aria-label="Connections">
    <header className="connections-intro"><div><span className="connections-eyebrow">YOUR SERVICES</span><h1>Connections</h1><p>Check what MOVA can use. Each check reports a real response and leaves your missions unchanged.</p></div><Plug size={25} aria-hidden="true" /></header>
    {error && <p className="connections-error" role="alert">{error}</p>}
    {!items.length && !error && <p role="status">Loading connections…</p>}
    <div className="connections-grid">{items.filter(item=>coreIds.has(item.id)).map(item => {
      const checking = busy.includes(item.id) || item.checking;
      const needsValues = !item.configured || item.id === 'github';
      const expired = item.status === 'connected' && item.checkedAt && Date.now() - Date.parse(item.checkedAt) > 300000;
      const status = expired ? 'unverified' : item.status;
      return <article className="connection-card" key={item.id}>
        <div className="connection-heading"><h3>{item.name}</h3><span className={`connection-status is-${status}`}>{status === 'connected' && <Check size={12} aria-hidden="true" />}{labels[status]}</span></div>
        <p className="connection-purpose">{item.purpose}</p>
        <p className="connection-detail" aria-live="polite">{checking ? 'Checking service access…' : expired ? 'Previous check expired. Check again for current access.' : item.detail}</p>
        <div className="connection-time">{item.checkedAt ? <>Checked {time(item.checkedAt)}{item.lastSuccessAt && item.lastSuccessAt !== item.checkedAt ? ` · Last success ${time(item.lastSuccessAt)}` : ''}</> : 'No check in this server session'}</div>
        <div className="connection-actions"><button type="button" disabled={checking || item.unsupported} onClick={() => void check(item.id)} title={item.checkDescription}><RefreshCw size={14} className={checking ? 'connection-spinning' : ''} aria-hidden="true" />{checking ? 'Checking…' : 'Check connection'}</button>{item.action && <a href={item.action.url} className="connection-oauth">{item.action.label}<ExternalLink size={13} aria-hidden="true" /></a>}</div>
        {item.retryAfterSeconds && <p className="connection-limit" role="status">Showing the recent result. A new check is available after {item.retryAfterSeconds} seconds.</p>}
        <details className="connection-setup"><summary title="Show setup steps, required permissions, and official setup links"><Settings2 size={14} aria-hidden="true" />Setup & troubleshooting</summary><p>{item.checkDescription}</p><ol>{item.steps.map(step => <li key={step}>{step}</li>)}</ol><p className="connection-env-label">Connection values</p><div className="connection-keys">{item.keys.map(key => <code key={key}>{key}</code>)}</div>{needsValues&&item.keys.length>0&&<form className="connection-configure" onSubmit={event=>{event.preventDefault();void configure(item);}}><p><KeyRound size={14}/>{item.id==='github'?'Add an allowlisted token for approved pull-request comments.':'Paste the required values to configure this running local session.'}</p>{item.keys.map(key=><label key={key}>{key}<input value={drafts[item.id]?.[key]||''} onChange={event=>setDrafts(current=>({...current,[item.id]:{...(current[item.id]||{}),[key]:event.target.value}}))} type={/TOKEN|SECRET|KEY/.test(key)?'password':'text'} autoComplete="off" required/></label>)}<button type="submit" disabled={checking}>Save connection values</button></form>}<p className="connection-secret-note">Values stay in the current local server process. Put approved values in the server’s .env file to keep them after restart. Keys are never shown after submission.</p><nav aria-label={`${item.name} setup links`}>{item.links.map(link => <a href={link.url} key={link.url} target="_blank" rel="noopener noreferrer">{link.label}<ExternalLink size={12} aria-hidden="true" /></a>)}</nav></details>
      </article>;
    })}</div>{upcoming.length>0&&<section className="connector-roadmap" aria-labelledby="connector-roadmap-title"><h2 id="connector-roadmap-title">Coming soon</h2><p>Planned connectors are visible early. They have no access to your data until their setup and approval flow is implemented.</p><div>{upcoming.map(item=><article key={item.id}><strong>{item.name}</strong><span>Planned</span><p>{item.purpose}</p></article>)}</div></section>}
  </section>;
}
