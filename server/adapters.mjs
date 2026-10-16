import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CALENDAR_READ = 'https://www.googleapis.com/auth/calendar.events.owned.readonly';
const CALENDAR_WRITE = 'https://www.googleapis.com/auth/calendar.events.owned';
const stamp = () => new Date().toISOString();
const requireText = (value, name, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value.trim();
};
const point = value => {
  const latitude = value?.latitude ?? value?.lat;
  const longitude = value?.longitude ?? value?.lng;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error('Invalid location coordinates');
  return { latitude, longitude };
};
const waypoint = value => typeof value === 'string' ? { address: requireText(value, 'destination') } : { location: { latLng: point(value) } };
const destinationText = value => typeof value === 'string' ? requireText(value, 'destination') : `${point(value).latitude},${point(value).longitude}`;
let publicMapQueue = Promise.resolve();
let publicMapLastCall = 0;
function publicMapRequest(operation) {
  const task = publicMapQueue.then(async () => {
    const wait = 1100 - (Date.now() - publicMapLastCall);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    publicMapLastCall = Date.now();
    return operation();
  });
  publicMapQueue = task.catch(() => {});
  return task;
}

export function createAdapters({ env = process.env, fetchImpl = fetch } = {}) {
  const dataDir = env.MOVA_DATA_DIR || '.data';
  const tokenFile = join(dataDir, 'google-tokens.enc');
  const states = new Map();
  const health = new Map();
  const verified = new Set();
  const placeCache = new Map();
  const mapsProvider = env.MAPS_PROVIDER || 'osm';
  if (!['osm', 'google', 'tomtom'].includes(mapsProvider)) throw new Error('MAPS_PROVIDER must be osm, google or tomtom.');
  const userAgent = env.OSM_USER_AGENT || 'MOVA-LocalPrototype/0.1 (personal outcome agent; local development)';
  let tokens;
  let tokenLoadError = false;
  let firebase;
  let voiceCache = null;
  const oauthConfigured = () => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI && /^[0-9a-f]{64}$/i.test(env.TOKEN_ENCRYPTION_KEY || ''));
  const encryptionKey = () => {
    if (!/^[0-9a-f]{64}$/i.test(env.TOKEN_ENCRYPTION_KEY || '')) throw new Error('TOKEN_ENCRYPTION_KEY must contain 64 hexadecimal characters');
    return Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'hex');
  };
  function saveTokens(next) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${tokenFile}.${randomBytes(5).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: encrypted.toString('hex') }), { mode: 0o600 });
    renameSync(tmp, tokenFile);
    tokens = next;
    tokenLoadError = false;
  }
  if (existsSync(tokenFile)) {
    try {
      const encrypted = JSON.parse(readFileSync(tokenFile, 'utf8'));
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(encrypted.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));
      tokens = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'hex')), decipher.final()]).toString());
    } catch { tokenLoadError = true; }
  }
  async function request(url, init = {}, service = 'Provider', timeout = 15000) {
    let response;
    try { response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeout) }); }
    catch { health.set(service, 'unavailable'); throw new Error(`${service} unavailable or timed out; result is unknown.`); }
    if (!response.ok) {
      health.set(service, response.status === 401 || response.status === 403 ? 'permission_required' : 'unavailable');
      throw new Error(`${service} request failed (${response.status})${response.status === 429 ? ': rate limited' : ''}. Check permissions, quota and configuration.`);
    }
    health.delete(service);
    verified.add(service);
    return response;
  }
  const jsonRequest = async (...args) => (await request(...args)).json();
  async function accessToken(write = false) {
    if (!tokens) throw new Error('Google Calendar is not connected. Complete OAuth first.');
    if (write && (env.GOOGLE_CALENDAR_WRITE_ENABLED !== 'true' || !tokens.scope?.split(' ').includes(CALENDAR_WRITE))) throw new Error('Calendar write permission is required.');
    if (tokens.expiresAt > Date.now() + 60000) return tokens.access_token;
    if (!tokens.refresh_token) throw new Error('Calendar permission expired; reconnect Google Calendar.');
    const refreshed = await jsonRequest('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: tokens.refresh_token, grant_type: 'refresh_token' }),
    }, 'Google Calendar');
    if (!refreshed.access_token) throw new Error('Calendar token refresh returned no access token.');
    saveTokens({ ...tokens, ...refreshed, expiresAt: Date.now() + (refreshed.expires_in || 3600) * 1000 });
    return tokens.access_token;
  }
  async function calendarRequest(path, { write = false, ...init } = {}) {
    const access = await accessToken(write);
    return jsonRequest(`https://www.googleapis.com/calendar/v3/calendars/primary/${path}`, {
      ...init, headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', ...init.headers },
    }, 'Google Calendar');
  }
  const adapters = {
    getIntegrations() {
      const calendarStatus = tokens ? (tokens.scope?.split(' ').includes(CALENDAR_WRITE) && env.GOOGLE_CALENDAR_WRITE_ENABLED === 'true' ? 'write_available' : 'read_only') : oauthConfigured() ? 'permission_required' : 'disconnected';
      const llmProvider = String(env.LLM_PROVIDER || (env.GROQ_API_KEY || env.groq_api_for_api ? 'groq' : 'gemini')).toLowerCase();
      const kiroSelected = llmProvider === 'kiro-cli';
      const groqSelected = llmProvider === 'groq';
      const llmName = 'MOVA reasoning';
      const llmKeyConfigured = kiroSelected ? Boolean(env.KIRO_API_KEY) : groqSelected ? Boolean(env.GROQ_API_KEY || env.groq_api_for_api) : Boolean(env.GEMINI_API_KEY);
      const tomtomIntegration = (id, service) => ({ id, name: service, status: health.get(service) || (env.TOMTOM_API_KEY ? verified.has(service) ? 'connected' : 'unavailable' : 'disconnected'), detail: env.TOMTOM_API_KEY ? verified.has(service) ? 'Last provider request succeeded. Traffic-aware results are estimates; coverage varies.' : 'Backend key configured; access has not yet been verified.' : 'Add TOMTOM_API_KEY on the backend.' });
      return [
        { id: kiroSelected ? 'kiro' : groqSelected ? 'groq' : 'gemini', name: llmName, status: llmKeyConfigured ? 'unavailable' : 'disconnected', detail: llmKeyConfigured ? 'Configured; the MOVA model controller reports actual request health.' : kiroSelected ? 'Set KIRO_API_KEY and install the Kiro CLI for live MOVA decisions.' : 'Add a backend model API key for live MOVA decisions.' },
        { id: 'routes', name: mapsProvider === 'osm' ? 'OSRM · OpenStreetMap' : 'Google Routes', status: health.get(mapsProvider === 'osm' ? 'OSRM' : 'Google Routes') || (mapsProvider === 'osm' ? 'read_only' : env.GOOGLE_MAPS_SERVER_API_KEY ? verified.has('Google Routes') ? 'connected' : 'unavailable' : 'disconnected'), detail: mapsProvider === 'osm' ? `${verified.has('OSRM') ? 'Last route request succeeded.' : 'Public endpoint; not yet queried.'} Open driving estimates; no live traffic feed. Public service has no SLA.` : 'Optional Google adapter; key alone does not verify access.' },
        { id: 'places', name: mapsProvider === 'osm' ? 'Nominatim · OpenStreetMap' : 'Google Places', status: health.get(mapsProvider === 'osm' ? 'Nominatim' : 'Google Places') || (mapsProvider === 'osm' ? 'read_only' : env.GOOGLE_MAPS_SERVER_API_KEY ? verified.has('Google Places') ? 'connected' : 'unavailable' : 'disconnected'), detail: mapsProvider === 'osm' ? 'Explicit place searches only, cached and limited to one public request per second.' : 'Optional Places API (New) adapter; access checked on request.' },
        { id: 'calendar', name: 'Google Calendar', status: tokenLoadError ? 'unavailable' : health.get('Google Calendar') || calendarStatus, detail: tokenLoadError ? 'Stored token could not be decrypted; verify the encryption key.' : tokens ? 'Authorized primary calendar events.' : 'Connect your calendar using OAuth.' },
        { id: 'voice', name: 'ElevenLabs', status: health.get('ElevenLabs') || (env.ELEVENLABS_API_KEY ? 'connected' : 'disconnected'), detail: env.ELEVENLABS_API_KEY ? 'Backend key configured. Voice access is checked when voices or speech are requested.' : 'Optional speech; configure a backend key.' },
        { id: 'weather', name: 'Open-Meteo', status: health.get('Open-Meteo') || 'read_only', detail: 'Public forecast adapter; non-commercial free endpoint. No live weather fetched until requested.' },
        { id: 'fcm', name: 'Firebase push', status: health.get('Firebase') || (env.FIREBASE_SERVICE_ACCOUNT_PATH ? 'permission_required' : 'disconnected'), detail: 'Backend adapter available; device token registration and native/background integration are not enabled in this web prototype.' },
      ].map(integration => mapsProvider === 'tomtom' && ['routes', 'places'].includes(integration.id) ? tomtomIntegration(integration.id, integration.id === 'routes' ? 'TomTom Routing' : 'TomTom Search') : integration);
    },
    async calculateRoutes({ origin, destination, deadline }) {
      if (mapsProvider === 'tomtom') {
        if (!env.TOMTOM_API_KEY) throw new Error('TomTom Routing is not configured. Add TOMTOM_API_KEY.');
        const from = point(origin), to = point(destination);
        const url = new URL(`https://api.tomtom.com/routing/1/calculateRoute/${from.latitude},${from.longitude}:${to.latitude},${to.longitude}/json`);
        url.search = new URLSearchParams({ key: env.TOMTOM_API_KEY, traffic: 'true', departAt: 'now', travelMode: 'car', routeType: 'fastest', maxAlternatives: '2', computeTravelTimeFor: 'all', routeRepresentation: 'polyline', instructionsType: 'text', language: 'en-GB', sectionType: 'traffic' }).toString();
        const data = await jsonRequest(url, {}, 'TomTom Routing', 20000);
        const observedAt = stamp();
        const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : null;
        const routes = (Array.isArray(data?.routes) ? data.routes : []).slice(0, 3).flatMap((route, index) => {
          const summary = route?.summary;
          if (!summary || nonnegative(summary.travelTimeInSeconds) === null) return [];
          const points = Array.isArray(route.legs) ? route.legs.flatMap(leg => Array.isArray(leg?.points) ? leg.points : []) : [];
          if (points.length < 2 || points.some(p => !Number.isFinite(p?.latitude) || !Number.isFinite(p?.longitude) || Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180)) return [];
          const coordinates = points.map(p => [p.longitude, p.latitude]);
          const maneuvers = (Array.isArray(route.guidance?.instructions) ? route.guidance.instructions : []).flatMap(step => {
            if (typeof step?.message !== 'string' || !step.message.trim()) return [];
            let location = null;
            try { location = point(step.point); } catch { /* Optional guidance location. */ }
            return [{ instruction: step.message.slice(0, 1000), distanceMeters: nonnegative(step.routeOffsetInMeters), travelTimeSeconds: nonnegative(step.travelTimeInSeconds), point: location }];
          });
          const trafficSections = (Array.isArray(route.sections) ? route.sections : []).flatMap(section => {
            if (section?.sectionType !== 'TRAFFIC' || !Number.isInteger(section.startPointIndex) || !Number.isInteger(section.endPointIndex) || section.startPointIndex < 0 || section.endPointIndex >= coordinates.length || section.endPointIndex <= section.startPointIndex) return [];
            return [{ startPointIndex: section.startPointIndex, endPointIndex: section.endPointIndex, delaySeconds: nonnegative(section.delayInSeconds), category: String(section.simpleCategory || 'TRAFFIC').slice(0, 80) }];
          });
          const durationMinutes = Math.ceil(summary.travelTimeInSeconds / 60);
          const slackMinutes = Number.isFinite(Date.parse(deadline)) ? Math.floor((Date.parse(deadline) - Date.now()) / 60000) - durationMinutes : null;
          return [{ id: `tomtom-route-${index}`, maneuvers, trafficSections, name: index ? `TomTom driving alternative ${index}` : 'TomTom recommended drive', mode: 'drive', durationMinutes, cost: null, reliability: null, slackMinutes, feasible: slackMinutes !== null && slackMinutes >= 0, reason: 'TomTom traffic-aware driving estimate; live traffic coverage varies. Fare and arrival are unverified.', path: [], coordinates, source: 'TomTom Routing API', observedAt, distanceMeters: nonnegative(summary.lengthInMeters), trafficDelaySeconds: nonnegative(summary.trafficDelayInSeconds), noTrafficDurationSeconds: nonnegative(summary.noTrafficTravelTimeInSeconds), historicTrafficDurationSeconds: nonnegative(summary.historicTrafficTravelTimeInSeconds), liveTrafficDurationSeconds: nonnegative(summary.liveTrafficIncidentsTravelTimeInSeconds), evidenceKind: 'calculated_estimate' }];
        });
        if (!routes.length) throw new Error('TomTom returned no usable driving route for these locations.');
        return routes;
      }
      if (mapsProvider === 'osm') {
        const from = point(origin), to = point(destination);
        const base = new URL(env.OSRM_BASE_URL || 'https://router.project-osrm.org');
        if (!['https:', 'http:'].includes(base.protocol) || (base.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(base.hostname))) throw new Error('OSRM endpoint must use HTTPS or local HTTP.');
        base.pathname = `${base.pathname.replace(/\/$/, '')}/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
        base.search = new URLSearchParams({ alternatives: 'true', geometries: 'geojson', overview: 'full', steps: 'false' }).toString();
        const data = await publicMapRequest(() => jsonRequest(base, { headers: { 'User-Agent': userAgent } }, 'OSRM', 20000));
        if (data.code !== 'Ok') throw new Error('OSRM could not calculate a driving route for these locations.');
        const observedAt = stamp();
        return (data.routes || []).slice(0, 5).flatMap((route, index) => {
          if (!Number.isFinite(route.duration) || route.duration < 0) return [];
          const coordinates = (route.geometry?.coordinates || []).filter(c => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90).map(c => c.slice(0, 2));
          if (coordinates.length < 2) return [];
          const durationMinutes = Math.ceil(route.duration / 60);
          const slackMinutes = Number.isFinite(Date.parse(deadline)) ? Math.floor((Date.parse(deadline) - Date.now()) / 60000) - durationMinutes : null;
          const summary = route.legs?.map(l => l.summary).filter(Boolean).join(' / ');
          return [{ id: `osrm-route-${index}`, name: summary || (index ? `Driving alternative ${index}` : 'OpenStreetMap driving route'), mode: 'drive', durationMinutes, cost: null, reliability: null, slackMinutes, feasible: slackMinutes !== null && slackMinutes >= 0, reason: 'OSRM road-network driving estimate; no live traffic, fare or arrival verification.', path: [], coordinates, source: 'OSRM · OpenStreetMap (no live traffic)', observedAt, distanceMeters: Number.isFinite(route.distance) ? route.distance : null, evidenceKind: 'calculated_estimate' }];
        });
      }
      if (!env.GOOGLE_MAPS_SERVER_API_KEY) throw new Error('Google Routes is not configured. Add GOOGLE_MAPS_SERVER_API_KEY.');
      const body = { origin: waypoint(origin), destination: waypoint(destination), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', computeAlternativeRoutes: true, polylineEncoding: 'GEO_JSON_LINESTRING' };
      const data = await jsonRequest('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_MAPS_SERVER_API_KEY, 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.geoJsonLinestring,routes.description,routes.routeLabels' }, body: JSON.stringify(body),
      }, 'Google Routes');
      const observedAt = stamp();
      return (data.routes || []).slice(0, 5).flatMap((route, index) => {
        if (typeof route.duration !== 'string' || !/^\d+(?:\.\d+)?s$/.test(route.duration)) return [];
        const durationMinutes = Math.ceil(parseFloat(route.duration) / 60);
        const slackMinutes = Number.isFinite(Date.parse(deadline)) ? Math.floor((Date.parse(deadline) - Date.now()) / 60000) - durationMinutes : null;
        const coordinates = (route.polyline?.geoJsonLinestring?.coordinates || []).filter(c => Array.isArray(c) && c.length >= 2 && c.slice(0, 2).every(Number.isFinite));
        return [{ id: `google-route-${index}`, name: route.description || (index ? `Driving alternative ${index}` : 'Recommended drive'), mode: 'drive', durationMinutes, cost: null, reliability: null, slackMinutes, feasible: slackMinutes !== null && slackMinutes >= 0, reason: 'Google traffic-aware driving estimate. Fare and arrival are unverified.', path: [], coordinates, source: 'Google Routes API', observedAt, distanceMeters: route.distanceMeters ?? null }];
      });
    },
    async openNavigation({ destination, plan }) {
      const target = destinationText(destination);
      const mode = String(plan?.mode || 'drive').toLowerCase();
      const travelModes = { drive: 'driving', driving: 'driving', transit: 'transit', walk: 'walking', walking: 'walking', bicycle: 'bicycling', bicycling: 'bicycling' };
      if (!Object.hasOwn(travelModes, mode)) throw new Error('Unsupported navigation transport mode.');
      return { status: 'UNVERIFIED', navigationTarget: { planId: plan?.id || null, destination: target, mode: travelModes[mode] }, summary: 'Route guidance opened in MOVA. Directions and traffic are estimates; arrival is not verified.' };
    },
    async getNavigationTarget() {
      return { status: 'unavailable', target: null, source: 'No connected navigation session', observedAt: stamp(), summary: 'The browser cannot read the active target from another navigation app. Use the mission destination.' };
    },
    async getCurrentRouteState() {
      return { status: 'unavailable', route: null, source: 'No connected navigation session', observedAt: stamp(), summary: 'Current turn-by-turn navigation state is not available. Recompute route estimates from an authorized location.' };
    },
    async searchPlaces({ query }) {
      if (mapsProvider === 'tomtom') {
        if (!env.TOMTOM_API_KEY) throw new Error('TomTom Search is not configured. Add TOMTOM_API_KEY.');
        const text = requireText(query, 'place query', 300);
        const url = new URL(`https://api.tomtom.com/search/2/search/${encodeURIComponent(text)}.json`);
        url.search = new URLSearchParams({ key: env.TOMTOM_API_KEY, limit: '5', typeahead: 'false' }).toString();
        const data = await jsonRequest(url, {}, 'TomTom Search');
        if (!Array.isArray(data?.results)) throw new Error('TomTom returned an invalid search response.');
        const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/([a-zA-Z])([0-9])/g, '$1 $2').replace(/([0-9])([a-zA-Z])/g, '$1 $2').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        const words = value => normalize(value).split(' ').filter(Boolean);
        const fragments = text.split(',');
        const requestedName = normalize(fragments[0]);
        const localityWords = words(fragments.slice(1).join(' '));
        const queryWords = words(text);
        const ranked = data.results.slice(0, 5).flatMap(row => {
          const latitude = row?.position?.lat, longitude = row?.position?.lon;
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || typeof row.id !== 'string') return [];
          const address = String(row.address?.freeformAddress || '').slice(0, 500);
          const name = String(row.poi?.name || address || text).slice(0, 500);
          const addressWords = new Set(words(Object.values(row.address || {}).filter(v => typeof v === 'string').join(' ')));
          const categories = Array.isArray(row.poi?.categories) ? row.poi.categories.filter(c => typeof c === 'string').slice(0, 10) : [];
          const categoryWords = new Set(words(categories.join(' ')));
          const nameWords = new Set(words(row.poi?.name));
          const localityMatches = localityWords.every(word => addressWords.has(word));
          let rank = 0;
          let matchKind = 'fuzzy_only';
          if (row.poi?.name && localityMatches) {
            // Comma-delimited localities cannot supply missing landmark-name words.
            // Without commas, a structured city or region may qualify a place name.
            const cityWords = new Set(words([row.address?.municipality, row.address?.countrySubdivision, row.address?.countrySubdivisionName].filter(Boolean).join(' ')));
            const identityWords = words(fragments[0]).filter(word => !(fragments.length === 1 && cityWords.has(word) && !nameWords.has(word)));
            const nameMatches = identityWords.length > 0 && identityWords.some(word => nameWords.has(word)) && identityWords.every(word => nameWords.has(word) || categoryWords.has(word));
            const coreWords = identityWords.filter(word => !categoryWords.has(word) || nameWords.has(word));
            const exactName = coreWords.join(' ') === normalize(row.poi.name);
            if (nameMatches) { rank = exactName ? 3 : 2; matchKind = exactName ? 'exact_name' : 'name_terms'; }
          } else if (!row.poi?.name && localityMatches) {
            const geographyFields = { Municipality: 'municipality', Country: 'country', CountrySubdivision: 'countrySubdivision', MunicipalitySubdivision: 'municipalitySubdivision' };
            const geographyName = row.type === 'Geography' ? row.address?.[geographyFields[row.entityType]] : null;
            if (geographyName && normalize(geographyName) === requestedName) {
              rank = ['Municipality', 'Country', 'CountrySubdivision'].includes(row.entityType) ? 4 : 1;
              matchKind = 'exact_geography';
            } else if (queryWords.length > 0 && queryWords.every(word => addressWords.has(word))) { rank = 1; matchKind = 'address_terms'; }
          }
          return [{ rank, place: { id: row.id, displayName: { text: name }, location: { latitude, longitude }, formattedAddress: address, categories, matchKind } }];
        }).sort((a, b) => b.rank - a.rank);
        const bestRank = ranked[0]?.rank || 0;
        const candidateIds = [...new Set(ranked.filter(item => bestRank > 0 && item.rank === bestRank).map(item => item.place.id))];
        const status = candidateIds.length === 1 ? 'matched' : candidateIds.length > 1 ? 'ambiguous' : 'unresolved';
        return { places: ranked.map(item => item.place), resolution: { status, selectedPlaceId: status === 'matched' ? candidateIds[0] : null, candidateIds, query: text }, source: 'TomTom Search API', observedAt: stamp() };
      }
      if (mapsProvider === 'osm') {
        const text = requireText(query, 'place query', 300);
        const key = text.toLowerCase();
        const cached = placeCache.get(key);
        if (cached && Date.now() - cached.at < 3600000) return { ...structuredClone(cached.result), cached: true };
        return publicMapRequest(async () => {
          const latest = placeCache.get(key);
          if (latest && Date.now() - latest.at < 3600000) return { ...structuredClone(latest.result), cached: true };
          const url = new URL(env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org');
          if (url.protocol !== 'https:') throw new Error('Nominatim endpoint must use HTTPS.');
          url.pathname = `${url.pathname.replace(/\/$/, '')}/search`;
          url.search = new URLSearchParams({ q: text, format: 'jsonv2', limit: '5', addressdetails: '0' }).toString();
          const rows = await jsonRequest(url, { headers: { 'User-Agent': userAgent, 'Accept-Language': 'en', Accept: 'application/json' } }, 'Nominatim', 20000);
          if (!Array.isArray(rows)) throw new Error('Nominatim returned an invalid search response.');
          const places = rows.slice(0, 5).flatMap(row => {
            const latitude = Number(row.lat), longitude = Number(row.lon);
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return [];
            return [{ id: `osm-${row.osm_type || 'place'}-${row.osm_id || row.place_id}`, displayName: { text: String(row.display_name || text).slice(0, 500) }, location: { latitude, longitude }, formattedAddress: String(row.display_name || text).slice(0, 500) }];
          });
          const result = { places, source: 'Nominatim · OpenStreetMap', observedAt: stamp(), cached: false };
          if (placeCache.size >= 100) placeCache.delete(placeCache.keys().next().value);
          placeCache.set(key, { at: Date.now(), result });
          return structuredClone(result);
        });
      }
      if (!env.GOOGLE_MAPS_SERVER_API_KEY) throw new Error('Google Places is not configured.');
      const data = await jsonRequest('https://places.googleapis.com/v1/places:searchText', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_MAPS_SERVER_API_KEY, 'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.formattedAddress' }, body: JSON.stringify({ textQuery: requireText(query, 'place query'), maxResultCount: 5 }) }, 'Google Places');
      return { places: data.places || [], source: 'Google Places API', observedAt: stamp() };
    },
    async getWeather(location) {
      const { latitude, longitude } = point(location);
      const url = new URL(env.OPEN_METEO_BASE_URL || 'https://api.open-meteo.com/v1/forecast');
      if (url.pathname.endsWith('/v1')) url.pathname += '/forecast';
      if (url.protocol !== 'https:') throw new Error('Weather endpoint must use HTTPS.');
      url.search = new URLSearchParams({ latitude, longitude, current: 'temperature_2m,precipitation,weather_code,wind_speed_10m', forecast_days: '1' }).toString();
      const data = await jsonRequest(url, {}, 'Open-Meteo');
      return { ...data, source: 'Open-Meteo forecast', observedAt: stamp(), evidenceKind: 'calculated_estimate' };
    },
    authURL({ sessionId } = {}) {
      if (!oauthConfigured()) throw new Error('Google OAuth is not configured; client, redirect URI and encryption key are required.');
      requireText(sessionId, 'browser session', 256);
      for (const [key, value] of states) if (value.expiresAt < Date.now()) states.delete(key);
      if (states.size > 100) throw new Error('Too many pending OAuth requests.');
      const state = randomBytes(32).toString('hex');
      states.set(state, { sessionId, expiresAt: Date.now() + 10 * 60 * 1000 });
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: env.GOOGLE_REDIRECT_URI, response_type: 'code', scope: env.GOOGLE_CALENDAR_WRITE_ENABLED === 'true' ? CALENDAR_WRITE : CALENDAR_READ, access_type: 'offline', prompt: 'consent', state }).toString();
      return url.toString();
    },
    async callback({ code, state, sessionId }) {
      const pending = states.get(state);
      if (!pending || pending.expiresAt < Date.now() || pending.sessionId !== sessionId) throw new Error('Invalid or expired OAuth state. Reconnect from the original browser.');
      states.delete(state);
      const data = await jsonRequest('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: requireText(code, 'OAuth code', 4096), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: env.GOOGLE_REDIRECT_URI, grant_type: 'authorization_code' }) }, 'Google Calendar');
      if (!data.access_token || !data.scope?.split(' ').some(s => s === CALENDAR_READ || s === CALENDAR_WRITE)) throw new Error('Google did not grant the required calendar scope.');
      saveTokens({ ...data, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 });
      return { connected: true, scope: data.scope };
    },
    async getCalendarEvents({ timeMin = stamp(), timeMax, maxResults = 20 } = {}) {
      if (!Number.isFinite(Date.parse(timeMin)) || (timeMax && !Number.isFinite(Date.parse(timeMax)))) throw new Error('Invalid calendar time bounds.');
      const params = new URLSearchParams({ timeMin, singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.min(50, Math.max(1, Number(maxResults) || 20))) });
      if (timeMax) params.set('timeMax', timeMax);
      const data = await calendarRequest(`events?${params}`);
      return { events: (data.items || []).map(e => ({ id: e.id, summary: e.summary, start: e.start, end: e.end, location: e.location, status: e.status, updated: e.updated })), source: 'Google Calendar', observedAt: stamp() };
    },
    async createCalendarEvent({ summary, start, end, location, idempotencyKey }) {
      validateEvent({ summary, start, end });
      const id = createHash('sha256').update(requireText(idempotencyKey, 'idempotency key', 200)).digest('hex');
      const event = { id, summary, start: { dateTime: start }, end: { dateTime: end }, ...(location ? { location: requireText(location, 'event location') } : {}) };
      let response;
      try { response = await calendarRequest('events?sendUpdates=none', { write: true, method: 'POST', body: JSON.stringify(event) }); }
      catch (error) { if (!error.message.includes('(409)')) throw error; }
      const actual = await calendarRequest(`events/${id}`);
      const verified = actual.id === id && actual.summary === summary && Date.parse(actual.start?.dateTime) === Date.parse(start) && Date.parse(actual.end?.dateTime) === Date.parse(end);
      return { status: verified ? 'VERIFIED' : 'UNVERIFIED', response: response || actual, observed: actual, source: 'Google Calendar', observedAt: stamp() };
    },
    async updateCalendarEvent({ eventId, summary, start, end }) {
      validateEvent({ summary, start, end });
      const path = `events/${encodeURIComponent(requireText(eventId, 'event id', 256))}`;
      const previous = await calendarRequest(path);
      const response = await calendarRequest(`${path}?sendUpdates=none`, { write: true, method: 'PATCH', headers: previous.etag ? { 'If-Match': previous.etag } : {}, body: JSON.stringify({ summary, start: { dateTime: start }, end: { dateTime: end } }) });
      const actual = await calendarRequest(path);
      const verified = actual.summary === summary && Date.parse(actual.start?.dateTime) === Date.parse(start) && Date.parse(actual.end?.dateTime) === Date.parse(end);
      return { status: verified ? 'VERIFIED' : 'UNVERIFIED', response, observed: actual, source: 'Google Calendar', observedAt: stamp() };
    },
    async listVoices({ refresh = false } = {}) {
      if (!env.ELEVENLABS_API_KEY) throw new Error('ElevenLabs is not configured. Add a backend API key.');
      if (!refresh && voiceCache && Date.now() - voiceCache.at < 300000) return voiceCache.result;
      const voices = [];
      let pageToken;
      let hasMore = false;
      for (let page = 0; page < 3; page++) {
        const url = new URL('https://api.elevenlabs.io/v2/voices');
        url.searchParams.set('page_size', '100');
        url.searchParams.set('include_total_count', 'false');
        if (pageToken) url.searchParams.set('next_page_token', pageToken);
        const data = await jsonRequest(url, { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } }, 'ElevenLabs');
        if (!Array.isArray(data.voices)) throw new Error('ElevenLabs returned an invalid voice list.');
        for (const voice of data.voices) {
          if (typeof voice.voice_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(voice.voice_id) || typeof voice.name !== 'string') continue;
          if (!voices.some(v => v.id === voice.voice_id)) voices.push({ id: voice.voice_id, name: voice.name.slice(0, 150), category: voice.category || 'unknown' });
        }
        hasMore = Boolean(data.has_more);
        pageToken = data.next_page_token;
        if (!hasMore || typeof pageToken !== 'string' || !pageToken) break;
      }
      const selectedVoiceId = voices.find(v => v.id === env.ELEVENLABS_VOICE_ID)?.id || (env.ELEVENLABS_VOICE_ID ? null : voices.find(v => v.category === 'premade')?.id || null);
      const result = { voices, selectedVoiceId, hasMore, source: 'ElevenLabs account voices', observedAt: stamp() };
      voiceCache = { at: Date.now(), result };
      return result;
    },
    async speech({ text, voiceId }) {
      const validText = requireText(text, 'speech text', 1000);
      const available = await adapters.listVoices();
      const selected = voiceId || env.ELEVENLABS_VOICE_ID || available.selectedVoiceId;
      if (!selected || !available.voices.some(v => v.id === selected)) throw new Error('Choose a voice returned by the connected ElevenLabs account.');
      const response = await request(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(selected)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'xi-api-key': env.ELEVENLABS_API_KEY }, body: JSON.stringify({ text: validText, model_id: env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2' }) }, 'ElevenLabs', 30000);
      if (!response.headers.get('content-type')?.startsWith('audio/')) throw new Error('ElevenLabs returned a non-audio response.');
      return Buffer.from(await response.arrayBuffer());
    },
    async sendNotification({ token, title, body, missionId }) {
      if (!env.FIREBASE_SERVICE_ACCOUNT_PATH) throw new Error('Firebase push is not configured.');
      requireText(token, 'device token', 4096);
      if (!firebase) {
        const { initializeApp, cert, getApps } = await import('firebase-admin/app');
        const { getMessaging } = await import('firebase-admin/messaging');
        const app = getApps().find(a => a.name === 'mova') || initializeApp({ credential: cert(JSON.parse(readFileSync(env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8'))), projectId: env.FIREBASE_PROJECT_ID }, 'mova');
        firebase = getMessaging(app);
      }
      try {
        const messageId = await firebase.send({ token, notification: { title: requireText(title, 'notification title', 100), body: requireText(body, 'notification body', 500) }, data: { missionId: requireText(missionId, 'mission id', 100), path: `/?mission=${encodeURIComponent(missionId)}` } });
        return { status: 'UNVERIFIED', messageId, summary: 'FCM accepted the message; device delivery is not verified.' };
      } catch (error) {
        if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error.code)) return { status: 'FAILED', invalidToken: true, summary: 'Device token is invalid; remove it and register a refreshed token.' };
        throw new Error('Firebase send failed. Delivery is unknown.');
      }
    },
  };
  return adapters;
}

function validateEvent({ summary, start, end }) {
  requireText(summary, 'event summary', 200);
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start)) throw new Error('Invalid event start or end.');
}
