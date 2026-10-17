import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapters } from '../server/adapters.mjs';
import { createProvider } from '../server/provider.mjs';
import { distanceMeters, resolveManualPlace, validPoint } from '../server/geo.mjs';
import { isNearbyPlaceRequest, leafletPoint, locationErrorMessage, locationRequiredForRequest, readBrowserLocation } from '../src/location.mjs';

const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });

const tomtomInput = { origin: { latitude: 28, longitude: 77 }, destination: { latitude: 29, longitude: 78 }, deadline: new Date(Date.now() + 3600000).toISOString() };
const tomtomRoute = (seconds = 1800, delay = 120) => ({ summary: { travelTimeInSeconds: seconds, trafficDelayInSeconds: delay, lengthInMeters: 24000, noTrafficTravelTimeInSeconds: 1680 }, legs: [{ points: [{ latitude: 28, longitude: 77 }, { latitude: 29, longitude: 78 }] }] });

test('coordinate validation, haversine distance and Leaflet markers use consistent latitude-longitude order',()=>{
  assert.deepEqual(validPoint({lat:0,lon:1}),{latitude:0,longitude:1});
  assert.equal(validPoint({latitude:91,longitude:0}),null);
  assert.ok(Math.abs(distanceMeters({latitude:0,longitude:0},{latitude:0,longitude:1})-111195)<5);
  assert.deepEqual(leafletPoint({latitude:28.6,longitude:77.2}),[28.6,77.2]);
});

test('browser geolocation returns an actual fix and provides a manual fallback on denial or unavailability',async()=>{
  const fix=await readBrowserLocation({getCurrentPosition(success){success({coords:{latitude:28.6,longitude:77.2,accuracy:18},timestamp:Date.now()});}});
  assert.deepEqual([fix.latitude,fix.longitude,fix.accuracy],[28.6,77.2,18]);
  await assert.rejects(readBrowserLocation({getCurrentPosition(_ok,fail){fail({code:1,message:'denied'});}}),error=>error.code==='PERMISSION_DENIED');
  await assert.rejects(readBrowserLocation(undefined),error=>error.code==='UNAVAILABLE');
  assert.match(locationErrorMessage({code:'PERMISSION_DENIED'}),/enter a city/i);
  assert.equal(locationRequiredForRequest('Find nearby restaurants'),true);assert.equal(locationRequiredForRequest('Find restaurants near my current location'),true);
  assert.equal(isNearbyPlaceRequest('Find nearby restaurants'),true);assert.equal(isNearbyPlaceRequest('Navigate to work'),false);
  assert.equal(locationRequiredForRequest('Research restaurant trends in India'),false);
});

test('manual geocoding requires an explicit result selection when the place is unresolved or ambiguous',()=>{
  const result={places:[{id:'a',location:{latitude:1,longitude:2}},{id:'b',location:{latitude:3,longitude:4}}]};
  assert.equal(resolveManualPlace(result),null);assert.equal(resolveManualPlace(result,'b'),result.places[1]);
  assert.equal(resolveManualPlace({places:[result.places[0]]}),result.places[0]);
  assert.equal(resolveManualPlace({places:[result.places[0]],resolution:{status:'unresolved'}}),null);
});

test('TomTom requests current traffic and preserves alternatives, geometry and changing estimates', async () => {
  let seconds = 1800;
  let requestUrl;
  const adapters = createAdapters({ env: { MAPS_PROVIDER: 'tomtom', TOMTOM_API_KEY: 'test' }, fetchImpl: async url => { requestUrl = new URL(url); return reply({ routes: [tomtomRoute(seconds), tomtomRoute(seconds + 600, 0)] }); } });
  assert.equal(adapters.getIntegrations().find(i => i.id === 'routes').status, 'unavailable');
  const first = await adapters.calculateRoutes(tomtomInput);
  assert.match(requestUrl.pathname, /routing\/1\/calculateRoute\/28,77:29,78\/json/);
  for (const [key, value] of Object.entries({ traffic: 'true', departAt: 'now', computeTravelTimeFor: 'all', maxAlternatives: '2', instructionsType: 'text', sectionType: 'traffic' })) assert.equal(requestUrl.searchParams.get(key), value);
  assert.equal(first.length, 2);
  assert.deepEqual(first[0].coordinates, [[77, 28], [78, 29]]);
  assert.equal(first[0].trafficDelaySeconds, 120);
  assert.equal(first[1].trafficDelaySeconds, 0);
  assert.equal(first[0].cost, null);
  assert.equal(first[0].reliability, null);
  assert.match(first[0].source, /TomTom/);
  assert.ok(Number.isFinite(Date.parse(first[0].observedAt)));
  assert.equal(adapters.getIntegrations().find(i => i.id === 'routes').status, 'connected');
  seconds = 7200;
  const second = await adapters.calculateRoutes(tomtomInput);
  assert.equal(second[0].durationMinutes, 120);
  assert.equal(second[0].feasible, false);
  assert.ok(second[0].slackMinutes < first[0].slackMinutes);
});

test('TomTom missing key, failures and malformed routes never fabricate a route or disclose a key', async () => {
  const missing = createAdapters({ env: { MAPS_PROVIDER: 'tomtom' } });
  await assert.rejects(missing.calculateRoutes(tomtomInput), /not configured/);
  await assert.rejects(missing.searchPlaces({ query: 'Airport' }), /not configured/);
  assert.equal(missing.getIntegrations().find(i => i.id === 'routes').status, 'disconnected');
  for (const status of [401, 403, 429, 500]) {
    const adapters = createAdapters({ env: { MAPS_PROVIDER: 'tomtom', TOMTOM_API_KEY: 'private-test' }, fetchImpl: async () => reply({ message: 'private-test' }, status) });
    await assert.rejects(adapters.calculateRoutes(tomtomInput), error => error.message.includes(String(status)) && !error.message.includes('private-test'));
    assert.equal(adapters.getIntegrations().find(i => i.id === 'routes').status, status < 429 ? 'permission_required' : 'unavailable');
  }
  for (const body of [{ routes: [] }, {}, { routes: [{ summary: { travelTimeInSeconds: -1 } }] }]) {
    const adapters = createAdapters({ env: { MAPS_PROVIDER: 'tomtom', TOMTOM_API_KEY: 'test' }, fetchImpl: async () => reply(body) });
    await assert.rejects(adapters.calculateRoutes(tomtomInput), /no usable driving route/);
  }
  const unknownDelay = tomtomRoute(); delete unknownDelay.summary.trafficDelayInSeconds;
  const adapters = createAdapters({ env: { MAPS_PROVIDER: 'tomtom', TOMTOM_API_KEY: 'test' }, fetchImpl: async () => reply({ routes: [unknownDelay] }) });
  assert.equal((await adapters.calculateRoutes(tomtomInput))[0].trafficDelaySeconds, null);
  const offline = createAdapters({ env: { MAPS_PROVIDER: 'tomtom', TOMTOM_API_KEY: 'private-test' }, fetchImpl: async () => { throw new Error('private-test'); } });
  await assert.rejects(offline.calculateRoutes(tomtomInput), error => /unavailable or timed out/.test(error.message) && !error.message.includes('private-test'));
  assert.equal(offline.getIntegrations().find(i => i.id === 'routes').status, 'unavailable');
});

test('TomTom search returns real place identities and validates coordinates', async () => {
  let requestUrl;
  const adapters = createAdapters({ env: { MAPS_PROVIDER: 'tomtom', TOMTOM_API_KEY: 'test' }, fetchImpl: async url => { requestUrl = new URL(url); return reply({ results: [{ id: 'real-id', poi: { name: 'Airport' }, address: { freeformAddress: 'Airport Road' }, position: { lat: 28, lon: 77 } }, { id: 'bad', position: { lat: 91, lon: 77 } }] }); } });
  const result = await adapters.searchPlaces({ query: 'Airport & Terminal' });
  assert.equal(decodeURIComponent(requestUrl.pathname), '/search/2/search/Airport & Terminal.json');
  assert.equal(requestUrl.searchParams.get('typeahead'), 'false');
  assert.equal(result.places.length, 1);
  assert.equal(result.places[0].id, 'real-id');
  assert.deepEqual(result.places[0].location, { latitude: 28, longitude: 77 });
  assert.equal(adapters.getIntegrations().find(i => i.id === 'places').status, 'connected');
});

test('TomTom nearby search constrains results by the requested coordinates and radius',async()=>{
  let url;
  const adapters=createAdapters({env:{MAPS_PROVIDER:'tomtom',TOMTOM_API_KEY:'test'},fetchImpl:async input=>{url=new URL(input);return reply({results:[
    {id:'near',poi:{name:'Nearby cafe',categories:['Cafe']},address:{freeformAddress:'1 Main Street'},position:{lat:28.601,lon:77.201}},
    {id:'far',poi:{name:'Far cafe'},address:{freeformAddress:'Far Road'},position:{lat:29,lon:78}},
    {id:'invalid',poi:{name:'Invalid'},position:{lat:91,lon:78}},
  ]});}});
  const result=await adapters.searchNearbyPlaces({query:'cafes',location:{latitude:28.6,longitude:77.2},radiusMeters:1000});
  assert.match(url.pathname,/search\/2\/search\/cafes\.json/);
  assert.equal(url.searchParams.get('lat'),'28.6');assert.equal(url.searchParams.get('lon'),'77.2');assert.equal(url.searchParams.get('radius'),'1000');assert.equal(url.searchParams.get('limit'),'20');
  assert.deepEqual(result.places.map(place=>place.id),['near']);
  assert.ok(result.places[0].distanceMeters>0&&result.places[0].distanceMeters<200);
  assert.equal(result.places[0].name,'Nearby cafe');assert.equal(result.places[0].address,'1 Main Street');assert.ok(Date.parse(result.observedAt));
});

test('TomTom nearby search rejects missing credentials and invalid coordinate inputs clearly',async()=>{
  const missing=createAdapters({env:{MAPS_PROVIDER:'tomtom'}});
  await assert.rejects(missing.searchNearbyPlaces({query:'restaurants',location:{latitude:1,longitude:2}}),/TOMTOM_API_KEY/);
  const configured=createAdapters({env:{MAPS_PROVIDER:'tomtom',TOMTOM_API_KEY:'test'}});
  await assert.rejects(configured.searchNearbyPlaces({query:'restaurants',location:{latitude:91,longitude:2}}),/valid current or manually selected location/);
});

test('planner context keeps all candidates but excludes route geometry and bounds duplicated history', async () => {
  let payload;
  const provider = createProvider({ env: { GROQ_API_KEY: 'test' }, fetchImpl: async (_, init) => { payload = JSON.parse(init.body); return reply({ choices: [{ message: { content: JSON.stringify({ selectedPlanId: 'route-0', summary: 'Route zero preserves the deadline.' }) } }] }); } });
  const plans = Array.from({ length: 3 }, (_, i) => ({ id: `route-${i}`, name: `Option ${i}`, mode: 'drive', durationMinutes: 30 + i, slackMinutes: 50 - i, cost: null, reliability: null, feasible: true, reason: 'Meets the protected deadline', source: 'OSRM no live traffic', observedAt: '2026-10-11T12:00:00Z', path: [`route-${i}`, 'connection', 'capability'], coordinates: Array.from({ length: 442 }, (_, j) => [77.123456 + j / 100000, 28.765432]) }));
  const graph = { nodes: Array.from({ length: 40 }, (_, i) => ({ id: `node-${i}`, type: 'Entity', label: 'Evidence', properties: { copiedRoute: plans }, source: 'Observed', observedAt: '2026-10-11T12:00:00Z' })), edges: [] };
  const decision = await provider.next({ mission: { plans, goal: 'Airport arrival', constraints: { maxCost: null, bufferMinutes: 15 }, trace: Array(100).fill({ detail: 'trace' }) }, tools: [{ name: 'evaluate_candidate_plans', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }], results: Array.from({ length: 12 }, () => ({ tool: 'evaluate_candidate_plans', result: { plans, graph, query: 'MATCH (n) RETURN n' } })) });
  assert.equal(decision.selectedPlanId, 'route-0');
  assert.ok(JSON.stringify(payload).length <= 12000);
  assert.ok(!JSON.stringify(payload).includes('77.123456'));
  const context = JSON.parse(payload.messages.find(m => m.role === 'user').content);
  assert.equal(context.mission.plans.length, 3);
  assert.equal(context.mission.plans[0].observedAt, plans[0].observedAt);
  assert.equal(context.compaction.omittedRouteCoordinateCount, 1326);
  assert.ok(context.compaction.omittedToolResultCount > 0);
});

test('provider HTTP 413 reports context limit instead of credential failure', async () => {
  const provider = createProvider({ env: { GROQ_API_KEY: 'test' }, fetchImpl: async () => reply({}, 413) });
  await assert.rejects(provider.compileIntent({ text: 'Airport in 90 minutes' }), error => /context.*limit/i.test(error.message) && !/credentials/i.test(error.message));
});

test('Groq has priority over Gemini and validates OpenAI-compatible JSON decisions', async () => {
  let request;
  const provider = createProvider({ env: { GROQ_API_KEY: 'groq-test', GEMINI_API_KEY: 'gemini-test' }, fetchImpl: async (url, init) => {
    request = { url, body: JSON.parse(init.body) };
    return reply({ choices: [{ message: { content: JSON.stringify({ destinationQuery: 'Delhi airport', goal: 'Arrive', summary: 'Protect arrival', deadlineMinutes: 90 }) } }] });
  } });
  const intent = await provider.compileIntent({ text: 'Delhi airport in 90 minutes' });
  assert.equal(provider.name, 'Groq');
  assert.equal(intent.deadlineMinutes, 90);
  assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(request.body.response_format.type, 'json_schema');
  assert.equal(provider.status().status, 'connected');
});

test('Groq rejects invalid structured output and exposes permission failure without credentials', async () => {
  let response = reply({ choices: [{ message: { content: 'null' } }] });
  const provider = createProvider({ env: { GROQ_API_KEY: 'private-groq-value' }, fetchImpl: async () => response });
  await assert.rejects(provider.compileIntent({ text: 'Airport in 90 minutes' }), /valid structured decision/);
  response = reply({ error: { message: 'private-groq-value' } }, 401);
  await assert.rejects(provider.compileIntent({ text: 'Airport' }), error => error.message.includes('401') && !error.message.includes('private-groq-value'));
  assert.equal(provider.status().status, 'permission_required');
});

test('public route failures never return a simulated route', async () => {
  const adapters = createAdapters({ env: {}, fetchImpl: async () => reply({ code: 'NoRoute', routes: [] }) });
  await assert.rejects(adapters.calculateRoutes({ origin: { latitude: 28, longitude: 77 }, destination: { latitude: 29, longitude: 78 } }), /could not calculate/);
});

test('OSRM returns actual open route geometry without claiming traffic data', async () => {
  let requestUrl;
  const adapters = createAdapters({ env: {}, fetchImpl: async url => {
    requestUrl = String(url);
    return reply({ code: 'Ok', routes: [{ duration: 1800, distance: 24000, geometry: { coordinates: [[77, 28], [77.1, 28.5]] }, legs: [{ summary: 'Airport Road' }] }] });
  } });
  const plans = await adapters.calculateRoutes({ origin: { latitude: 28, longitude: 77 }, destination: { latitude: 28.5, longitude: 77.1 }, deadline: new Date(Date.now() + 3600000).toISOString() });
  assert.match(requestUrl, /route\/v1\/driving\/77,28;77.1,28.5/);
  assert.equal(new URL(requestUrl).searchParams.get('alternatives'), 'true');
  assert.match(plans[0].source, /OSRM/);
  assert.match(plans[0].reason, /no live traffic/i);
  assert.deepEqual(plans[0].coordinates, [[77, 28], [77.1, 28.5]]);
  assert.equal(adapters.getIntegrations().find(i => i.id === 'routes').status, 'read_only');
});

test('Nominatim explicit search caches responses and includes identifying headers', async () => {
  let calls = 0;
  let header;
  const adapters = createAdapters({ env: {}, fetchImpl: async (_, init) => {
    calls++; header = init.headers['User-Agent'];
    return reply([{ place_id: 10, display_name: 'Delhi Airport, India', lat: '28.55', lon: '77.1', osm_type: 'way', osm_id: 20 }]);
  } });
  const first = await adapters.searchPlaces({ query: 'Delhi Airport' });
  const second = await adapters.searchPlaces({ query: 'Delhi Airport' });
  assert.equal(calls, 1);
  assert.match(header, /MOVA/);
  assert.equal(first.places[0].location.latitude, 28.55);
  assert.equal(second.cached, true);
});

test('intent compilation requires live model data and validates the destination and deadline', async () => {
  await assert.rejects(createProvider({ env: {} }).compileIntent({ text: 'Airport in 90 minutes' }), /not configured/);
  let output = { destinationQuery: 'Kempegowda International Airport Bengaluru', deadlineMinutes: 90, summary: 'Protect airport arrival within 90 minutes.', goal: 'Reach the airport before the deadline.' };
  const provider = createProvider({ env: { GEMINI_API_KEY: 'test' }, fetchImpl: async () => reply({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] }) });
  const intent = await provider.compileIntent({ text: 'Get me to Bengaluru airport in 90 minutes.' });
  assert.equal(intent.deadlineMinutes, 90);
  assert.equal(intent.destinationQuery, output.destinationQuery);
  output.deadlineMinutes = -2;
  await assert.rejects(provider.compileIntent({ text: 'Airport' }), /deadline/);
  output = { destinationQuery: '', summary: 'Unknown destination', goal: 'Arrive' };
  await assert.rejects(provider.compileIntent({ text: 'Take me there' }), /destination/);
});

test('voice selection uses returned account voices and does not invent a fallback', async () => {
  const calls = [];
  const adapters = createAdapters({ env: { ELEVENLABS_API_KEY: 'test' }, fetchImpl: async (url) => {
    calls.push(String(url));
    if (String(url).includes('/v2/voices')) return reply({ voices: [{ voice_id: 'verified-id', name: 'Account voice', category: 'premade' }], has_more: false });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
  } });
  const voices = await adapters.listVoices();
  assert.equal(voices.voices[0].id, 'verified-id');
  assert.equal(voices.selectedVoiceId, 'verified-id');
  const audio = await adapters.speech({ text: 'Your arrival is still being verified.' });
  assert.equal(audio.length, 3);
  assert.ok(calls.some(url => url.includes('/text-to-speech/verified-id')));
  await assert.rejects(adapters.speech({ text: 'Hello', voiceId: 'not-in-account' }), /voice/i);
  const empty = createAdapters({ env: { ELEVENLABS_API_KEY: 'test' }, fetchImpl: async () => reply({ voices: [] }) });
  await assert.rejects(empty.speech({ text: 'Hello' }), /voice/i);
});

test('missing credentials never fabricate live routes or model output', async () => {
  const adapters = createAdapters({ env: { MAPS_PROVIDER: 'google' } });
  await assert.rejects(adapters.calculateRoutes({ origin: 'A', destination: 'B' }), /not configured/);
  assert.equal(adapters.getIntegrations().find(i => i.id === 'routes').status, 'disconnected');
  const provider = createProvider({ env: {} });
  assert.equal(provider.configured, false);
  await assert.rejects(provider.next({ mission: {}, tools: [], results: [] }), /not configured/);
});

test('routes preserve provider geometry, reject malformed durations and leave unknown cost null', async () => {
  let request;
  const adapters = createAdapters({ env: { MAPS_PROVIDER: 'google', GOOGLE_MAPS_SERVER_API_KEY: 'test' }, fetchImpl: async (_, init) => {
    request = JSON.parse(init.body);
    return reply({ routes: [{ duration: '1800s', polyline: { geoJsonLinestring: { coordinates: [[77, 12], [78, 13]] } } }, { duration: 'invalid' }] });
  } });
  const plans = await adapters.calculateRoutes({ origin: { latitude: 12, longitude: 77 }, destination: 'Airport', deadline: new Date(Date.now() + 3600000).toISOString() });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].durationMinutes, 30);
  assert.equal(plans[0].cost, null);
  assert.equal(plans[0].source, 'Google Routes API');
  assert.deepEqual(plans[0].coordinates, [[77, 12], [78, 13]]);
  assert.equal(request.origin.location.latLng.latitude, 12);
});

test('navigation handoff cannot verify arrival and validates destination', async () => {
  const adapters = createAdapters({ env: {} });
  const receipt = await adapters.openNavigation({ destination: 'Airport & Terminal 2', plan: { mode: 'drive' }, idempotencyKey: 'test' });
  assert.equal(receipt.status, 'UNVERIFIED');
  assert.equal(receipt.navigationTarget.destination, 'Airport & Terminal 2');
  assert.equal(receipt.navigationUrl, undefined);
  await assert.rejects(adapters.openNavigation({ destination: '' }), /destination/);
});

test('navigation preserves transit and walking modes across plan casing and rejects unsupported transport', async () => {
  const adapters = createAdapters({ env: {} });
  for (const mode of ['TRANSIT', 'transit']) {
    const result = await adapters.openNavigation({ destination: 'Airport', plan: { mode } });
    assert.equal(result.navigationTarget.mode, 'transit');
  }
  const walk = await adapters.openNavigation({ destination: 'Airport', plan: { mode: 'WALK' } });
  assert.equal(walk.navigationTarget.mode, 'walking');
  await assert.rejects(adapters.openNavigation({ destination: 'Airport', plan: { mode: 'flying' } }), /transport mode/);
});

test('provider rejects unknown tool selection and infeasible chosen plans', async () => {
  let output = { tool: 'shell', args: {}, summary: 'Do something' };
  const provider = createProvider({ env: { GEMINI_API_KEY: 'test' }, fetchImpl: async () => reply({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] }) });
  await assert.rejects(provider.next({ mission: { plans: [] }, tools: [{ name: 'calculate_routes' }], results: [] }), /Unknown tool/);
  output = { selectedPlanId: 'late', summary: 'Choose late' };
  await assert.rejects(provider.next({ mission: { plans: [{ id: 'late', feasible: false }] }, tools: [], results: [] }), /feasible/);
});

test('provider errors do not expose upstream body or credentials', async () => {
  const provider = createProvider({ env: { GEMINI_API_KEY: 'secret-test' }, fetchImpl: async () => reply({ error: 'secret-test' }, 403) });
  await assert.rejects(provider.next({ mission: {}, tools: [], results: [] }), error => error.message.includes('403') && !error.message.includes('secret-test'));
});

test('provider passes only schema-approved arguments and returns public summary', async () => {
  const provider = createProvider({ env: { GEMINI_API_KEY: 'test' }, fetchImpl: async () => reply({ candidates: [{ content: { parts: [{ thought: true, text: 'private token' }, { text: JSON.stringify({ tool: 'find_recovery_options', args: {}, summary: 'Check which routes still satisfy the deadline.' }) }] } }] }) });
  const decision = await provider.next({ mission: {}, tools: [{ name: 'find_recovery_options', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }], results: [] });
  assert.equal(decision.tool, 'find_recovery_options');
  assert.ok(!decision.summary.includes('private token'));
});

test('provider failures update integration health without returning forged routes', async () => {
  const adapters = createAdapters({ env: { MAPS_PROVIDER: 'google', GOOGLE_MAPS_SERVER_API_KEY: 'test' }, fetchImpl: async () => reply({}, 429) });
  await assert.rejects(adapters.calculateRoutes({ origin: 'Start', destination: 'End' }), /rate limited/);
  assert.equal(adapters.getIntegrations().find(i => i.id === 'routes').status, 'unavailable');
});

test('invalid geographic and event input is rejected before requests', async () => {
  let calls = 0;
  const adapters = createAdapters({ env: { GOOGLE_MAPS_SERVER_API_KEY: 'test' }, fetchImpl: async () => { calls++; return reply({}); } });
  await assert.rejects(adapters.calculateRoutes({ origin: { latitude: 91, longitude: 10 }, destination: 'Airport' }), /coordinates/);
  await assert.rejects(adapters.createCalendarEvent({ summary: 'Flight', start: 'bad', end: 'bad', idempotencyKey: 'a' }), /start or end/);
  assert.equal(calls, 0);
});

test('OAuth state binds browser session, is single-use, and tokens persist encrypted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mova-oauth-'));
  try {
    const adapters = createAdapters({ env: { GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', GOOGLE_REDIRECT_URI: 'http://localhost:3001/api/google/callback', TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32), MOVA_DATA_DIR: dir }, fetchImpl: async () => reply({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.events.owned.readonly' }) });
    const url = new URL(adapters.authURL({ sessionId: 'browser-a' }));
    const state = url.searchParams.get('state');
    await assert.rejects(adapters.callback({ code: 'code', state, sessionId: 'browser-b' }), /state/);
    await adapters.callback({ code: 'code', state, sessionId: 'browser-a' });
    assert.ok(!readFileSync(join(dir, 'google-tokens.enc'), 'utf8').includes('private-access'));
    await assert.rejects(adapters.callback({ code: 'code', state, sessionId: 'browser-a' }), /state/);
    assert.equal(adapters.getIntegrations().find(i => i.id === 'calendar').status, 'read_only');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('calendar create retries reuse event identity and verify the remote record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mova-calendar-'));
  try {
    let storedEvent;
    let postCount = 0;
    const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REDIRECT_URI: 'http://localhost:3001/api/google/callback', TOKEN_ENCRYPTION_KEY: '12'.repeat(32), MOVA_DATA_DIR: dir, GOOGLE_CALENDAR_WRITE_ENABLED: 'true' };
    const adapters = createAdapters({ env, fetchImpl: async (url, init) => {
      if (url.includes('oauth2.googleapis.com')) return reply({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.events.owned' });
      if (init.method === 'POST') { postCount++; if (storedEvent) return reply({}, 409); storedEvent = JSON.parse(init.body); return reply(storedEvent); }
      return reply(storedEvent);
    } });
    const state = new URL(adapters.authURL({ sessionId: 'session' })).searchParams.get('state');
    await adapters.callback({ code: 'code', state, sessionId: 'session' });
    const input = { summary: 'Airport departure', start: '2026-10-15T10:00:00+05:30', end: '2026-10-15T10:15:00+05:30', idempotencyKey: 'mission-one-action' };
    const first = await adapters.createCalendarEvent(input);
    const second = await adapters.createCalendarEvent(input);
    assert.equal(first.status, 'VERIFIED');
    assert.equal(second.status, 'VERIFIED');
    assert.equal(first.response.id, second.response.id);
    assert.equal(postCount, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('calendar refresh persists a renewed token and read permission cannot write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mova-refresh-'));
  try {
    let tokenCalls = 0;
    const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REDIRECT_URI: 'http://localhost:3001/api/google/callback', TOKEN_ENCRYPTION_KEY: '34'.repeat(32), MOVA_DATA_DIR: dir };
    const adapters = createAdapters({ env, fetchImpl: async (url, init) => {
      if (url.includes('oauth2.googleapis.com')) { tokenCalls++; return reply({ access_token: `access-${tokenCalls}`, refresh_token: 'refresh', expires_in: tokenCalls === 1 ? 1 : 3600, scope: 'https://www.googleapis.com/auth/calendar.events.owned.readonly' }); }
      assert.equal(init.headers.authorization, 'Bearer access-2');
      return reply({ items: [{ id: 'one', summary: 'Flight' }] });
    } });
    const state = new URL(adapters.authURL({ sessionId: 'session' })).searchParams.get('state');
    await adapters.callback({ code: 'code', state, sessionId: 'session' });
    const result = await adapters.getCalendarEvents();
    assert.equal(result.events[0].id, 'one');
    assert.equal(tokenCalls, 2);
    await assert.rejects(adapters.createCalendarEvent({ summary: 'Test', start: '2026-10-15T10:00:00Z', end: '2026-10-15T11:00:00Z', idempotencyKey: 'a' }), /write permission/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('TomTom preserves real guidance and traffic section boundaries only', async () => {
  const route = tomtomRoute();
  route.guidance = { instructions: [{ message: 'Turn right onto Airport Road', routeOffsetInMeters: 100, travelTimeInSeconds: 30, point: { latitude: 28, longitude: 77 } }] };
  route.sections = [{ sectionType: 'TRAFFIC', startPointIndex: 0, endPointIndex: 1, delayInSeconds: 45, simpleCategory: 'JAM' }, { sectionType: 'TRAFFIC', startPointIndex: 0, endPointIndex: 999 }];
  const adapters = createAdapters({ env: { MAPS_PROVIDER: 'tomtom', TOMTOM_API_KEY: 'test' }, fetchImpl: async () => reply({ routes: [route] }) });
  const [plan] = await adapters.calculateRoutes(tomtomInput);
  assert.equal(plan.maneuvers[0].instruction, 'Turn right onto Airport Road');
  assert.equal(plan.maneuvers[0].distanceMeters, 100);
  assert.equal(plan.trafficSections.length, 1);
  assert.equal(plan.trafficSections[0].delaySeconds, 45);
});


test('TomTom ranks exact landmark names ahead of unrelated fuzzy matches and flags duplicate identities', async () => {
  let rows = [
    { id: 'wrong', poi: { name: 'Purana Quila Gate' }, address: { freeformAddress: 'Pragati Maidan, New Delhi' }, position: { lat: 28.608829, lon: 77.242251 } },
    { id: 'monument', poi: { name: 'India Gate', categories: ['monument'] }, address: { freeformAddress: 'India Gate, New Delhi' }, position: { lat: 28.612908, lon: 77.229442 } },
  ];
  const adapters = createAdapters({ env: { MAPS_PROVIDER: 'tomtom', TOMTOM_API_KEY: 'test' }, fetchImpl: async () => reply({ results: rows }) });
  let result = await adapters.searchPlaces({ query: 'India Gate, New Delhi' });
  assert.equal(result.places[0].id, 'monument');
  assert.equal(result.resolution.status, 'matched');
  assert.equal(result.resolution.selectedPlaceId, 'monument');
  rows.push({ id: 'cafe', poi: { name: 'India Gate', categories: ['caf?'] }, address: { freeformAddress: 'Nizampur, New Delhi' }, position: { lat: 28.6938, lon: 76.9984 } });
  result = await adapters.searchPlaces({ query: 'India Gate, New Delhi' });
  assert.equal(result.resolution.status, 'ambiguous');
  assert.equal(result.resolution.selectedPlaceId, null);
  assert.deepEqual(result.resolution.candidateIds, ['monument', 'cafe']);
  const specific = await adapters.searchPlaces({ query: 'India Gate monument, New Delhi' });
  assert.equal(specific.resolution.selectedPlaceId, 'monument');
  rows = rows.slice(0, 1);
  result = await adapters.searchPlaces({ query: 'India Gate, New Delhi' });
  assert.equal(result.resolution.status, 'unresolved');
  assert.equal(result.resolution.selectedPlaceId, null);
});

test('TomTom name matching respects requested locality and terminal numbers', async () => {
  const rows = [
    { id: 'wrong-city', poi: { name: 'India Gate' }, address: { freeformAddress: 'Mumbai' }, position: { lat: 19, lon: 72 } },
    { id: 't2', poi: { name: 'Airport Terminal 2' }, address: { freeformAddress: 'Delhi', municipality: 'Delhi' }, position: { lat: 28, lon: 77 } },
    { id: 't3', poi: { name: 'Airport Terminal 3' }, address: { freeformAddress: 'Delhi', municipality: 'Delhi' }, position: { lat: 28.1, lon: 77.1 } },
  ];
  const adapters = createAdapters({ env: { MAPS_PROVIDER: 'tomtom', TOMTOM_API_KEY: 'test' }, fetchImpl: async () => reply({ results: rows }) });
  assert.equal((await adapters.searchPlaces({ query: 'India Gate, New Delhi' })).resolution.status, 'unresolved');
  const airport = await adapters.searchPlaces({ query: 'Delhi Airport Terminal3' });
  assert.equal(airport.resolution.selectedPlaceId, 't3');
  assert.equal(airport.places[0].id, 't3');
});


test('TomTom uses structured geography and keeps landmark identity separate from its neighborhood', async () => {
  let rows = [
    { id: 'business', type: 'POI', poi: { name: 'New Delhi India Biryani' }, address: { country: 'Indonesia', municipality: 'Kota Tangerang', freeformAddress: 'Kota Tangerang' }, position: { lat: -6, lon: 106 } },
    { id: 'city', type: 'Geography', entityType: 'Municipality', address: { municipality: 'New Delhi', country: 'India', freeformAddress: 'New Delhi, Delhi' }, position: { lat: 28.6, lon: 77.2 } },
  ];
  const adapters = createAdapters({ env: { MAPS_PROVIDER: 'tomtom', TOMTOM_API_KEY: 'test' }, fetchImpl: async () => reply({ results: rows }) });
  assert.equal((await adapters.searchPlaces({ query: 'New Delhi, India' })).resolution.selectedPlaceId, 'city');
  rows = [
    { id: 'wrong', poi: { name: 'Jyot Pancham Gate', categories: ['monument'] }, address: { municipalitySubdivision: 'India Gate', municipality: 'New Delhi', country: 'India', freeformAddress: 'India Gate, New Delhi' }, position: { lat: 28.61, lon: 77.23 } },
    { id: 'right', poi: { name: 'India Gate', categories: ['monument'] }, address: { municipalitySubdivision: 'India Gate', municipality: 'New Delhi', country: 'India', freeformAddress: 'India Gate, New Delhi' }, position: { lat: 28.612908, lon: 77.229442 } },
  ];
  const result = await adapters.searchPlaces({ query: 'India Gate monument, New Delhi' });
  assert.equal(result.resolution.selectedPlaceId, 'right');
  assert.equal(result.places.find(p => p.id === 'wrong').matchKind, 'fuzzy_only');
});
