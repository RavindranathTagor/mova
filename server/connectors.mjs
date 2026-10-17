import { createClient } from 'redis';

const publicOrigin = { latitude: 37.7749, longitude: -122.4194, label: 'Public test origin' };
const publicDestination = { latitude: 37.7849, longitude: -122.4094, label: 'Public test destination' };
const guide = (label, url) => ({ label, url });

export function createConnectors({ env = process.env, adapters, provider, traccar, workTools, remoteMcp, now = Date.now, graphProbe } = {}) {
  const modelKeys = provider.name === 'Kiro' ? ['LLM_PROVIDER', 'KIRO_API_KEY', 'KIRO_CLI_PATH'] : provider.name === 'Groq' ? ['LLM_PROVIDER', 'GROQ_API_KEY', 'GROQ_MODEL'] : ['LLM_PROVIDER', 'GEMINI_API_KEY', 'GEMINI_MODEL'];
  const definitions = [
    { id:'web',name:'Web research',purpose:'Searches current public web sources through local SearXNG.',configured:true,keys:['SEARXNG_BASE_URL'],steps:['Start the self-hosted search service with docker compose -f docker-compose.search.yml up -d.','Leave SEARXNG_BASE_URL empty for the local default, or set a private loopback URL.','Check a public search. Search snippets are leads; read the source before relying on them.'],links:[guide('SearXNG setup','https://docs.searxng.org/admin/installation-docker.html')],checkDescription:'One public web search; no mission is started.' },
    { id:'github',name:'GitHub',purpose:'Reads repository evidence, detects recent @MOVA issue or pull-request mentions, and proposes discussion replies for allowlisted repositories.',configured:true,keys:['GITHUB_TOKEN','GITHUB_ALLOWED_REPOSITORIES','GITHUB_MENTION_HANDLE'],steps:['Public repository and commit reads work without a token.','For mention checks and proposed discussion replies, create a fine-grained token with Issues: Read and write and Pull requests: Read and write, limited to GITHUB_ALLOWED_REPOSITORIES.','Set GITHUB_MENTION_HANDLE to the account name MOVA should recognize. MOVA investigates a mention, then asks before replying.'],links:[guide('GitHub API','https://docs.github.com/en/rest/repos/repos'),guide('Fine-grained tokens','https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens')],checkDescription:'Reads public FalkorDB repository metadata.' },
    { id:'slack',name:'Slack channel context',purpose:'Reads recent messages, detects @MOVA mentions, and proposes replies in allowlisted public or owned channels.',configured:Boolean(env.MOVA_GRAPH_DATA_ATTESTATION==='public_or_owned'&&env.SLACK_BOT_TOKEN&&env.SLACK_ALLOWED_CHANNEL_IDS),keys:['MOVA_GRAPH_DATA_ATTESTATION','SLACK_BOT_TOKEN','SLACK_ALLOWED_CHANNEL_IDS','SLACK_BOT_USER_ID'],steps:['Create or use a Slack app in a workspace you own, then grant channels:history or groups:history and chat:write for approved replies.','Install the app, invite it only to selected channels, set SLACK_ALLOWED_CHANNEL_IDS, and set SLACK_BOT_USER_ID so MOVA can recognize Slack-native mentions.','Set MOVA_GRAPH_DATA_ATTESTATION=public_or_owned only after confirming the channel data may enter FalkorDB. MOVA investigates a mention and asks before every send.'],links:[guide('Slack conversations API','https://api.slack.com/methods/conversations.history')],checkDescription:'Reads recent messages from the first allowlisted channel; no messages are sent.' },
    { id:'discord',name:'Discord channel context',purpose:'Reads recent messages, detects @MOVA mentions, and proposes replies in allowlisted public or owned channels.',configured:Boolean(env.MOVA_GRAPH_DATA_ATTESTATION==='public_or_owned'&&env.DISCORD_BOT_TOKEN&&env.DISCORD_ALLOWED_CHANNEL_IDS),keys:['MOVA_GRAPH_DATA_ATTESTATION','DISCORD_BOT_TOKEN','DISCORD_ALLOWED_CHANNEL_IDS','DISCORD_BOT_USER_ID'],steps:['Create a Discord application and bot for a server you own. Give it View Channel, Read Message History, and Send Messages only in selected channels.','Enable Message Content intent, set DISCORD_ALLOWED_CHANNEL_IDS, and set DISCORD_BOT_USER_ID so MOVA can recognize native mentions.','Attest that the allowlisted data is public or yours before ingesting it. MOVA investigates a mention and asks before every send.'],links:[guide('Discord channel messages','https://discord.com/developers/docs/resources/channel#get-channel-messages')],checkDescription:'Reads recent messages from the first allowlisted channel; no messages are sent.' },
    { id:'notion',name:'Notion',purpose:'Planned workspace documents and decision context.',configured:false,unsupported:true,comingSoon:true,keys:[],steps:['Planned connector. No Notion page is read or changed by this build.'],links:[],checkDescription:'Coming soon.' },
    { id:'linear',name:'Linear',purpose:'Planned issue, project, and decision context.',configured:false,unsupported:true,comingSoon:true,keys:[],steps:['Planned connector. No Linear issue is read or changed by this build.'],links:[],checkDescription:'Coming soon.' },
    { id:'google-drive',name:'Google Drive',purpose:'Planned document evidence and source attribution.',configured:false,unsupported:true,comingSoon:true,keys:[],steps:['Planned connector. No Drive file is read or changed by this build.'],links:[],checkDescription:'Coming soon.' },
    { id:'gmail',name:'Gmail',purpose:'Planned email thread evidence and drafting.',configured:false,unsupported:true,comingSoon:true,keys:[],steps:['Planned connector. No email is read or sent by this build.'],links:[],checkDescription:'Coming soon.' },
    { id:'jira',name:'Jira',purpose:'Planned delivery, incident, and issue context.',configured:false,unsupported:true,comingSoon:true,keys:[],steps:['Planned connector. No Jira issue is read or changed by this build.'],links:[],checkDescription:'Coming soon.' },
    { id:'teams',name:'Microsoft Teams',purpose:'Planned channel context and approval-aware replies.',configured:false,unsupported:true,comingSoon:true,keys:[],steps:['Planned connector. No Teams message is read or sent by this build.'],links:[],checkDescription:'Coming soon.' },
    { id:'dropbox',name:'Dropbox',purpose:'Planned file evidence and delivery context.',configured:false,unsupported:true,comingSoon:true,keys:[],steps:['Planned connector. No Dropbox file is read or changed by this build.'],links:[],checkDescription:'Coming soon.' },
    { id:'postgres',name:'PostgreSQL',purpose:'Planned read-only business data context.',configured:false,unsupported:true,comingSoon:true,keys:[],steps:['Planned connector. No database query is issued by this build.'],links:[],checkDescription:'Coming soon.' },
    { id:'artifacts',name:'Saved deliverables',purpose:'Writes briefs locally and verifies their saved content.',configured:true,keys:['MOVA_DATA_DIR'],steps:['Outputs are stored under the ignored local data directory.','Ask MOVA to save a brief, comparison or report.','Open Deliverables to inspect and download verified output.'],links:[],checkDescription:'Lists local artifacts without changing them.' },
    { id:'mcp',name:'Connected MCP tools',purpose:'Extends MOVA with explicitly allowed service tools.',configured:Boolean(env.MOVA_MCP_CONFIG),keys:['MOVA_MCP_CONFIG'],steps:['Copy config/mcp.example.json to a local configuration file.','Add trusted Streamable HTTP servers and exact readTools names; use tokenEnv for a backend token variable.','Set MOVA_MCP_CONFIG to that file and restart. Only explicitly allowed tools advertising read-only access enter the agent catalog.'],links:[guide('MCP documentation','https://modelcontextprotocol.io/docs/learn/architecture')],checkDescription:'Reports actual server negotiation and allowed tool counts; does not execute remote tools.' },
    { id:'rides',name:'Ride booking',purpose:'Uber, Ola and Rapido account actions.',configured:false,unsupported:true,keys:[],steps:['Web research can investigate transport options, but it cannot establish a confirmed cab booking.','Uber ride requests and Ola booking need provider-approved credentials and user authorization.','No official public Rapido booking API has been verified for this project. Use the provider app until an authorized connector is implemented.'],links:[guide('Uber ride access','https://developer.uber.com/docs/riders/ride-requests/tutorials/api/introduction'),guide('Ola booking','https://developers.olacabs.com/docs/cab-booking')],checkDescription:'No ride booking connector is implemented; no booking is made.' },
    { id: 'model', name: 'MOVA reasoning', purpose: 'Understands goals and chooses the next action.', configured: provider.configured, keys: modelKeys, steps: ['Open your model provider account and create an API key.', 'Save the listed variables in the backend .env file, then restart MOVA.', 'Check access: this sends one small goal-parsing request and does not start a mission.'], links: [guide('Provider setup', provider.name === 'Kiro' ? 'https://kiro.dev/docs/cli/' : provider.name === 'Groq' ? 'https://console.groq.com/keys' : 'https://aistudio.google.com/apikey')], checkDescription: 'One model request; provider usage may apply.' },
    { id: 'graph', name: 'FalkorDB', purpose: 'The decision backbone: stores evidence provenance, dependency paths, mention triggers, approval proposals, and graph-gates tool execution.', configured: true, keys: ['FALKORDB_URL'], steps: ['Start the local FalkorDB Docker service.', 'Set FALKORDB_URL to the local database address (default port 6380).', 'Check access to execute a read-only graph capability query.'], links: [guide('FalkorDB setup', 'https://docs.falkordb.com/getting-started.html')], checkDescription: 'Read-only GRAPH.LIST and, when a graph exists, RETURN 1.' },
    { id: 'routing', name: 'TomTom Routing', purpose: 'Provides road-network estimates for location requests.', configured: Boolean(env.TOMTOM_API_KEY), keys: ['MAPS_PROVIDER', 'TOMTOM_API_KEY'], steps: ['Open the TomTom Developer Portal and create an application key.', 'Enable Routing access; set MAPS_PROVIDER=tomtom and TOMTOM_API_KEY in .env.', 'Restart MOVA and check a generic public route. It is a connection test only.'], links: [guide('TomTom console', 'https://developer.tomtom.com/user/me/apps'), guide('Routing guide', 'https://developer.tomtom.com/routing-api/documentation/tomtom-maps/calculate-route')], checkDescription: 'One generic public route request; not a mission or your location.' },
    { id: 'search', name: 'TomTom Search', purpose: 'Resolves a requested location to a place for map-based work.', configured: Boolean(env.TOMTOM_API_KEY), keys: ['MAPS_PROVIDER', 'TOMTOM_API_KEY'], steps: ['Open your TomTom application in the Developer Portal.', 'Ensure Search API access is enabled for its key.', 'Restart MOVA and check a generic public landmark search.'], links: [guide('TomTom console', 'https://developer.tomtom.com/search-api/documentation/search-service/fuzzy-search')], checkDescription: 'One generic public landmark search; no personal query is sent.' },
    { id: 'tracking', name: 'Traccar', purpose: 'Receives location observations from your phone.', configured: traccar.configured, keys: ['TRACCAR_URL', 'TRACCAR_DEVICE_ID', 'TRACCAR_TOKEN'], steps: ['Open local Traccar management and match the phone Client identifier to its device.', 'Use a read-only account restricted to that device; set the backend numeric device ID and token.', 'In iPhone Settings → Privacy & Security → Local Network, allow Traccar Client. Enable location permission and tracking.', 'For the current hotspot, use http://172.20.10.2:5055 in the Client. Check for a fresh fix; a stale upload cannot verify arrival.'], links: [guide('Local Traccar', 'http://127.0.0.1:8082'), guide('Client setup', 'https://www.traccar.org/client/'), guide('iPhone network permission', 'https://support.apple.com/en-au/102229')], checkDescription: 'Reads only the selected phone. Location coordinates are not displayed here.' },
    { id: 'voice', name: 'ElevenLabs', purpose: 'Reads updates aloud with an account voice.', configured: Boolean(env.ELEVENLABS_API_KEY), keys: ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'], steps: ['Open ElevenLabs settings and create an API key with voice-list access.', 'Save ELEVENLABS_API_KEY in .env and restart MOVA.', 'Check the voice list, then choose an available voice. This check does not synthesize speech.'], links: [guide('ElevenLabs console', 'https://elevenlabs.io/app/settings/api-keys'), guide('API setup', 'https://elevenlabs.io/docs/api-reference/introduction')], checkDescription: 'Lists available voices without generating audio.' },
    { id: 'calendar', name: 'Google Calendar', purpose: 'Reads calendar context after you connect Google.', configured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI && env.TOKEN_ENCRYPTION_KEY), keys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'TOKEN_ENCRYPTION_KEY'], steps: ['In Google Cloud, enable Calendar API and create a Web application OAuth client.', 'Add the exact GOOGLE_REDIRECT_URI as an authorized redirect URI. Save credentials and TOKEN_ENCRYPTION_KEY in backend .env.', 'Restart MOVA, choose Connect Google, and approve calendar access.', 'Check access to read at most one upcoming event. Event details stay out of this panel.'], links: [guide('Google Cloud credentials', 'https://console.cloud.google.com/apis/credentials'), guide('OAuth setup', 'https://developers.google.com/calendar/api/quickstart/nodejs')], action: { label: 'Connect Google', url: '/api/google/auth' }, checkDescription: 'Reads at most one upcoming event; does not create or change events.' },
    { id: 'weather', name: 'Open-Meteo', purpose: 'Reads weather context for a location named in the mission.', configured: true, keys: ['OPEN_METEO_BASE_URL'], steps: ['The public non-commercial forecast endpoint needs no API key.', 'Ask MOVA for weather context for a named public location.', 'For commercial use, configure a service plan appropriate to your deployment.'], links: [guide('Open-Meteo API', 'https://open-meteo.com/en/docs')], checkDescription: 'One public-location forecast; not a phone location request.' },
    { id: 'push', name: 'Firebase notifications', purpose: 'Optional phone notifications.', configured: Boolean(env.FIREBASE_SERVICE_ACCOUNT_PATH), unsupported: true, keys: ['FIREBASE_SERVICE_ACCOUNT_PATH', 'FIREBASE_PROJECT_ID'], steps: ['Create a Firebase project and register a client application.', 'A device token, installed messaging dependency, and delivery acknowledgement flow are required.', 'This prototype has no end-to-end notification check. A credential alone cannot establish delivery.'], links: [guide('Firebase setup', 'https://firebase.google.com/docs/cloud-messaging')], checkDescription: 'Delivery verification is not implemented. No message will be sent.' },
  ];
  const state = new Map();
  const pending = new Map();
  const configured = d => d.id==='web'||d.id==='github'||d.id==='weather'||d.id==='graph'||d.id==='artifacts'
    ? true
    : d.id==='slack' ? Boolean(env.MOVA_GRAPH_DATA_ATTESTATION==='public_or_owned'&&env.SLACK_BOT_TOKEN&&env.SLACK_ALLOWED_CHANNEL_IDS)
    : d.id==='discord' ? Boolean(env.MOVA_GRAPH_DATA_ATTESTATION==='public_or_owned'&&env.DISCORD_BOT_TOKEN&&env.DISCORD_ALLOWED_CHANNEL_IDS)
    : d.id==='calendar' ? Boolean(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET&&env.GOOGLE_REDIRECT_URI&&env.TOKEN_ENCRYPTION_KEY)
    : d.id==='mcp' ? Boolean(env.MOVA_MCP_CONFIG)
    : d.id==='model' ? provider.configured
    : d.id==='routing'||d.id==='search' ? Boolean(env.MAPS_PROVIDER==='tomtom'&&env.TOMTOM_API_KEY)
    : d.id==='tracking' ? traccar.configured
    : d.id==='voice' ? Boolean(env.ELEVENLABS_API_KEY)
    : Boolean(d.configured);
  const snapshot = d => {
    const isConfigured=configured(d);
    const result = state.get(d.id);
    const stale = result?.status === 'connected' && now() - Date.parse(result.checkedAt) > 300000;
    return { ...d, configured:isConfigured, status: d.unsupported ? 'unsupported' : stale ? 'unverified' : result?.status || (isConfigured ? 'unverified' : 'disconnected'), detail: stale ? 'Previous check is more than five minutes old. Check again.' : result?.detail || (d.unsupported ? 'End-to-end delivery is not implemented.' : isConfigured ? 'Configured; no successful check in this session.' : 'Setup is required before checking.'), checkedAt: result?.checkedAt || null, lastSuccessAt: result?.lastSuccessAt || null, checking: pending.has(d.id) };
  };
  async function probe(id) {
    if(id==='web'){const result=await workTools.call('web_search',{query:'FalkorDB official documentation'});if(!result.results?.length)throw new Error('Search returned no results');return `Search returned ${result.results.length} real source links. Snippets are not independently verified claims.`;}
    if(id==='github'){
      const repositories=String(env.GITHUB_ALLOWED_REPOSITORIES||'').split(',').map(v=>v.trim()).filter(Boolean);
      if(!repositories.length){await workTools.call('read_github_repository',{repository:'FalkorDB/FalkorDB'});return 'Public GitHub access works. Select repositories to enable workspace context.';}
      for(const repository of repositories)await workTools.call('read_github_repository',{repository});
      return `${repositories.length} selected repositories are readable. Issue write access requires an approved action to verify.`;
    }
    if(id==='slack'){const channelId=String(env.SLACK_ALLOWED_CHANNEL_IDS||'').split(',').map(value=>value.trim()).find(Boolean);if(!channelId)throw new Error('No Slack channel is allowlisted');const result=await workTools.call('read_slack_channel',{channelId});return `Slack returned ${result.results?.length||0} recent messages from an allowlisted channel.`;}
    if(id==='discord'){const channelId=String(env.DISCORD_ALLOWED_CHANNEL_IDS||'').split(',').map(value=>value.trim()).find(Boolean);if(!channelId)throw new Error('No Discord channel is allowlisted');const result=await workTools.call('read_discord_channel',{channelId});return `Discord returned ${result.results?.length||0} recent messages from an allowlisted channel.`;}
    if(id==='artifacts'){await workTools.call('list_artifacts',{});return 'Local artifact storage is readable. No artifact was written by this check.';}
    if(id==='mcp'){const states=remoteMcp?.status()||[];const count=states.filter(s=>s.status==='connected').reduce((n,s)=>n+s.toolCount,0);if(!count)throw new Error('No allowed MCP tools');return `${count} allowed read tools negotiated from configured MCP servers.`;}
    if (id === 'model') { await provider.compileIntent({ text: 'Find the current weather for a named public location.' }); return 'Model returned a valid structured response. No mission was created.'; }
    if (id === 'graph') {
      if (graphProbe) return graphProbe();
      const client = createClient({ url: env.FALKORDB_URL || 'redis://127.0.0.1:6380', socket: { connectTimeout: 5000, reconnectStrategy: false } });
      client.on('error', () => {});
      let timeout;
      try { await Promise.race([(async () => { await client.connect(); const names = await client.sendCommand(['GRAPH.LIST']); if (names.length) await client.sendCommand(['GRAPH.RO_QUERY', names[0], 'RETURN 1', 'TIMEOUT', '1000']); })(), new Promise((_, reject) => { timeout = setTimeout(() => { if (client.isOpen) client.destroy(); reject(new Error('Graph check timed out')); }, 8000); })]); return 'FalkorDB responded to a read-only graph capability check.'; }
      finally { clearTimeout(timeout); if (client.isOpen) client.destroy(); }
    }
    if (id === 'routing' || id === 'search') {
      if (env.MAPS_PROVIDER !== 'tomtom') throw new Error('MAPS_PROVIDER must select tomtom');
      if (id === 'routing') { const routes = await adapters.calculateRoutes({ origin: publicOrigin, destination: publicDestination }); if (!routes?.length) throw new Error('No route'); return 'Generic public route returned. Traffic estimates are not arrival evidence.'; }
      const result = await adapters.searchPlaces({ query: 'public landmark' }); if (!result.places?.length) throw new Error('No place'); return 'Generic public landmark search returned a place.';
    }
    if (id === 'tracking') { const fix = await traccar.getLatestPosition(); return `Fresh phone fix received${fix.accuracy ? `; reported accuracy ${Math.round(fix.accuracy)} m` : '; accuracy unknown'}. ${fix.verificationEligible ? 'Eligible for mission arrival checks.' : 'Insufficient accuracy to verify arrival.'}`; }
    if (id === 'voice') { const result = await adapters.listVoices({ refresh: true }); if (!result.voices?.length) throw new Error('No voices'); return `Voice list returned ${result.voices.length} available voices. Speech generation was not tested.`; }
    if (id === 'calendar') { await adapters.getCalendarEvents({ maxResults: 1 }); return 'Google Calendar read access succeeded. No events were modified.'; }
    if (id === 'weather') { const result = await adapters.getWeather(publicOrigin); if (!result.current || !Number.isFinite(result.current.temperature_2m)) throw new Error('No weather'); return 'Public-location weather response received. Forecasts remain estimates.'; }
  }
  async function check(id) {
    const d = definitions.find(item => item.id === id);
    if (!d) throw Object.assign(new Error('Unknown connector.'), { status: 404 });
    if (pending.has(id)) return pending.get(id);
    const previous = state.get(id);
    if (previous && now() - Date.parse(previous.checkedAt) < 60000) return { ...snapshot(d), retryAfterSeconds: Math.ceil((60000 - now() + Date.parse(previous.checkedAt)) / 1000) };
    const task = (async () => {
      const isConfigured=configured(d);
      let status = d.unsupported ? 'unsupported' : isConfigured ? 'connected' : 'disconnected';
      let detail = d.unsupported ? 'End-to-end delivery verification is not implemented. No message was sent.' : 'Configure the listed backend settings and restart MOVA.';
      if (isConfigured && !d.unsupported) try { detail = await probe(id); } catch (error) {
        status = id === 'calendar' ? 'permission_required' : 'unavailable';
        const message=String(error.message||'');
        detail = id === 'tracking' ? (error.code === 'STALE_POSITION' ? 'Phone upload is stale. Enable tracking and wait for a recent fix.' : error.code === 'TRACKING_AUTH' ? 'Traccar denied access. Check the read-only token and assigned device.' : 'No recent valid phone fix is available. Check phone permissions and connection.') : id === 'calendar' ? 'Calendar read failed. Connect Google or review OAuth setup.' : id === 'slack' && /channel_not_found/i.test(message) ? 'Slack cannot access the allowlisted channel. Confirm its exact channel ID, invite the app to that channel, and grant channels:history (or groups:history for a private channel).' : `${d.name} check failed. Review credentials, service access, and setup instructions.`;
        if (id === 'model') {
          const message = String(error.message || '');
          if (/timed out|timeout/i.test(message)) detail = 'The model did not respond within the time limit. Try again; this does not establish a credential problem.';
          else if (/429|rate.?limit/i.test(message)) { status = 'rate_limited'; detail = 'The model provider limited this request. Wait before trying again or review your account quota.'; }
          else if (/413|context exceeds|token limit/i.test(message)) detail = 'The request or response exceeded the model limit. Reduce the request size or use a larger account allowance.';
          else if (/deadline|structured|valid|extract|destination|mission kind/i.test(message)) detail = 'The model responded, but its output did not meet the required format. No decision was accepted. Try the check again.';
        }
      }
      const checkedAt = new Date(now()).toISOString();
      state.set(id, { status, detail, checkedAt, lastSuccessAt: status === 'connected' ? checkedAt : previous?.lastSuccessAt || null });
      return snapshot(d);
    })();
    pending.set(id, task);
    try { return { ...await task, checking: false }; } finally { pending.delete(id); }
  }
  function configure(id,values){
    const d=definitions.find(item=>item.id===id);if(!d)throw Object.assign(new Error('Unknown connector.'),{status:404});
    if(!values||typeof values!=='object'||Array.isArray(values))throw Object.assign(new Error('Provide connection values.'),{status:400});
    const entries=Object.entries(values);
    if(!entries.length||entries.some(([key,value])=>!d.keys.includes(key)||typeof value!=='string'||!value.trim()||value.length>4000||/[\r\n]/.test(value)))throw Object.assign(new Error('Invalid connection values.'),{status:400});
    for(const [key,value] of entries)env[key]=value.trim();
    state.delete(id);
    return snapshot(d);
  }
  return { list: () => definitions.map(snapshot), check, configure };
}
