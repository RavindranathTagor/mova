const fail = (message, code = 'TRACKING_UNAVAILABLE') => Object.assign(new Error(message), { code });

export function createTraccar({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const hasAuth = Boolean(env.TRACCAR_TOKEN || (env.TRACCAR_USERNAME && env.TRACCAR_PASSWORD));
  const configured = Boolean(env.TRACCAR_URL && env.TRACCAR_DEVICE_ID && hasAuth);
  const deviceId = Number(env.TRACCAR_DEVICE_ID);
  let base;
  if (env.TRACCAR_DEVICE_ID && (!Number.isSafeInteger(deviceId) || deviceId <= 0)) throw fail('TRACCAR_DEVICE_ID must be one positive numeric device ID.', 'INVALID_TRACKING_CONFIG');
  if (env.TRACCAR_URL) {
    try { base = new URL(env.TRACCAR_URL); } catch { throw fail('Invalid Traccar URL.', 'INVALID_TRACKING_CONFIG'); }
    const privateHost = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(base.hostname);
    if (base.username || base.password || base.search || base.hash || !['https:', 'http:'].includes(base.protocol) || (base.protocol === 'http:' && !privateHost)) throw fail('Traccar URL must use HTTPS or a private local HTTP address, without embedded credentials or query parameters.', 'INVALID_TRACKING_CONFIG');
  }
  const pollIntervalMs = Math.max(10000, Math.min(60000, Number(env.TRACCAR_POLL_INTERVAL_MS) || 15000));
  let state = configured ? 'unavailable' : 'disconnected';
  let detail = configured ? 'Configured; no device fix has been verified yet.' : 'Configure a self-hosted URL, explicit device ID and backend authentication.';
  let lastAttempt = -Infinity;
  let cached;
  let lastError;
  let pending;
  const validate = raw => {
    if (!raw || raw.deviceId !== deviceId || !Number.isSafeInteger(raw.id) || raw.id <= 0) throw fail('Traccar returned no position for the configured device.');
    if (raw.valid !== true) throw fail('The configured device has no valid GPS fix.', 'INVALID_POSITION');
    if (!Number.isFinite(raw.latitude) || Math.abs(raw.latitude) > 90 || !Number.isFinite(raw.longitude) || Math.abs(raw.longitude) > 180) throw fail('Traccar returned invalid coordinates.', 'INVALID_POSITION');
    const timestamp = typeof raw.fixTime === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(raw.fixTime) ? Date.parse(raw.fixTime) : NaN;
    if (!Number.isFinite(timestamp)) throw fail('The device position has no valid fixTime; server receipt time cannot verify location.', 'INVALID_POSITION');
    if (timestamp > now() + 5000) throw fail('The device fix time is in the future; check the phone clock.', 'INVALID_POSITION');
    if (now() - timestamp > 120000) throw fail('The latest device fix is stale. Open Traccar Client and send a fresh location.', 'STALE_POSITION');
    if (raw.accuracy != null && (!Number.isFinite(raw.accuracy) || raw.accuracy < 0 || raw.accuracy > 1000000)) throw fail('Traccar returned an invalid accuracy value.', 'INVALID_POSITION');
    // Java positions default accuracy to zero when the device did not report it.
    const accuracy = raw.accuracy > 0 ? raw.accuracy : undefined;
    return { latitude: raw.latitude, longitude: raw.longitude, ...(accuracy !== undefined ? { accuracy } : {}), timestamp, fixTime: raw.fixTime, source: 'Traccar', deviceId, positionId: raw.id, evidenceKind: 'observed', verificationEligible: accuracy !== undefined && accuracy <= 100, receivedAt: new Date(now()).toISOString() };
  };
  const setError = error => { state = error.code === 'TRACKING_AUTH' ? 'permission_required' : 'unavailable'; detail = error.message; lastError = error; return error; };
  async function fetchPosition() {
    lastAttempt = now();
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/positions`;
    url.searchParams.set('deviceId', String(deviceId));
    const authorization = env.TRACCAR_TOKEN ? `Bearer ${env.TRACCAR_TOKEN}` : `Basic ${Buffer.from(`${env.TRACCAR_USERNAME}:${env.TRACCAR_PASSWORD}`, 'utf8').toString('base64')}`;
    let response;
    try { response = await fetchImpl(url, { headers: { Authorization: authorization, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw setError(fail('The self-hosted Traccar server is unreachable, redirected or timed out.')); }
    if (response.status >= 300 && response.status < 400) throw setError(fail('Traccar redirect refused; configure its final self-hosted URL.'));
    if (!response.ok) throw setError(fail(`Traccar request failed (${response.status}); check server access and device permissions.`, [401, 403].includes(response.status) ? 'TRACKING_AUTH' : 'TRACKING_UNAVAILABLE'));
    if (response.url && new URL(response.url).origin !== base.origin) throw setError(fail('Traccar response origin mismatch.'));
    let rows;
    try { rows = await response.json(); } catch { throw setError(fail('Traccar returned an invalid position response.')); }
    if (!Array.isArray(rows) || rows.length > 20) throw setError(fail('Traccar returned an invalid bounded device response.'));
    const raw = rows.filter(row => row.deviceId === deviceId).sort((a, b) => Date.parse(b.fixTime) - Date.parse(a.fixTime))[0];
    let result;
    try { result = validate(raw); } catch (error) { throw setError(error); }
    cached = raw;
    lastError = undefined;
    state = 'read_only';
    detail = result.verificationEligible ? 'Fresh device fix received; precise enough for the location criterion.' : 'Fresh device fix received; accuracy is unknown or too broad to verify arrival.';
    return result;
  }
  return {
    configured,
    pollIntervalMs,
    status: () => ({ id: 'traccar', name: 'Traccar · self-hosted', status: state, detail, deviceId: Number.isSafeInteger(deviceId) ? deviceId : null }),
    async getLatestPosition() {
      if (!configured) throw fail('Traccar is not configured. Add its URL, device ID and backend credentials.', 'TRACKING_DISCONNECTED');
      if (pending) return pending;
      if (now() - lastAttempt < pollIntervalMs) {
        if (lastError) throw lastError;
        try { return { ...validate(cached), cached: true }; } catch (error) { throw setError(error); }
      }
      pending = fetchPosition();
      try { return await pending; } finally { pending = undefined; }
    },
  };
}
