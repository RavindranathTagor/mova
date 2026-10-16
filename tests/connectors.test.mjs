import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectors } from '../server/connectors.mjs';

const create = overrides => createConnectors({ env: {}, adapters: {}, provider: { name: 'Kiro', configured: false }, traccar: { configured: false }, ...overrides });

test('model failures distinguish validation, timeout and quota without exposing upstream content', async () => {
  for (const [message, status, expected] of [['Invalid mission deadline secret-canary', 'unavailable', /required format/], ['request timed out secret-canary', 'unavailable', /time limit/], ['HTTP 429 secret-canary', 'rate_limited', /limited this request/], ['HTTP 413 secret-canary', 'unavailable', /model limit/]]) {
    const connectors = create({ provider: { name: 'Kiro', configured: true, compileIntent: async () => { throw new Error(message); } } });
    const result = await connectors.check('model');
    assert.equal(result.status, status); assert.match(result.detail, expected);
    assert.ok(!JSON.stringify(result).includes('secret-canary'));
  }
});

test('configuration is never represented as verified and secret values are absent', () => {
  const result = create({ env: { MAPS_PROVIDER: 'tomtom', TOMTOM_API_KEY: 'private-canary', ELEVENLABS_API_KEY: 'other-private-canary' } }).list();
  assert.equal(result.find(x => x.id === 'routing').status, 'unverified');
  assert.equal(result.find(x => x.id === 'voice').status, 'unverified');
  assert.equal(result.find(x => x.id === 'calendar').status, 'disconnected');
  assert.ok(!JSON.stringify(result).includes('private-canary'));
  assert.ok(result.every(x => x.checkedAt === null && x.lastSuccessAt === null));
});

test('duplicate concurrent probes are coalesced and repeated checks are rate limited', async () => {
  let calls = 0, finish;
  const deferred = new Promise(resolve => { finish = resolve; });
  const connectors = create({ graphProbe: async () => { calls++; await deferred; return 'Read-only check passed.'; } });
  const first = connectors.check('graph');
  const second = connectors.check('graph');
  assert.equal(calls, 1); finish();
  assert.equal((await first).status, 'connected');
  assert.equal((await second).status, 'connected');
  const cached = await connectors.check('graph');
  assert.equal(cached.retryAfterSeconds, 60); assert.equal(calls, 1);
});

test('failed check keeps last success and never returns upstream secrets', async () => {
  let clock = 1000000, fail = false;
  const connectors = create({ now: () => clock, graphProbe: async () => { if (fail) throw new Error('password=private-canary'); return 'Read verified'; } });
  const first = await connectors.check('graph'); clock += 61000; fail = true;
  const second = await connectors.check('graph');
  assert.equal(second.status, 'unavailable'); assert.equal(second.lastSuccessAt, first.lastSuccessAt);
  assert.notEqual(second.checkedAt, first.checkedAt); assert.ok(!JSON.stringify(second).includes('private-canary'));
});

test('stale phone uploads fail and checks do not turn unknown accuracy into verification', async () => {
  const unavailable = create({ traccar: { configured: true, getLatestPosition: async () => { throw Object.assign(new Error('coordinates should not escape'), { code: 'STALE_POSITION' }); } } });
  const stale = await unavailable.check('tracking');
  assert.equal(stale.status, 'unavailable'); assert.match(stale.detail, /stale/); assert.equal(stale.lastSuccessAt, null);
  const fresh = create({ traccar: { configured: true, getLatestPosition: async () => ({ verificationEligible: false }) } });
  const result = await fresh.check('tracking'); assert.equal(result.status, 'connected'); assert.match(result.detail, /Insufficient accuracy/);
});

test('notification check cannot send anything and unconfigured calendar cannot read data', async () => {
  let invoked = false;
  const connectors = create({ env: { FIREBASE_SERVICE_ACCOUNT_PATH: 'secret-path' }, adapters: { sendNotification: () => { invoked = true; }, getCalendarEvents: () => { invoked = true; } } });
  assert.equal((await connectors.check('push')).status, 'unsupported');
  assert.equal((await connectors.check('calendar')).status, 'disconnected');
  assert.equal(invoked, false);
  await assert.rejects(connectors.check('not-real'), error => error.status === 404);
});

test('public route and search checks never use phone coordinates or create missions', async () => {
  const inputs = [];
  const connectors = create({ env: { MAPS_PROVIDER: 'tomtom', TOMTOM_API_KEY: 'secret' }, adapters: { calculateRoutes: async input => { inputs.push(input); return [{}]; }, searchPlaces: async input => { inputs.push(input); return { places: [{}] }; } } });
  assert.equal((await connectors.check('routing')).status, 'connected');
  assert.equal((await connectors.check('search')).status, 'connected');
  assert.equal(inputs[0].origin.latitude, 37.7749); assert.equal(inputs[1].query, 'public landmark');
});

test('successful check expires rather than remaining green indefinitely', async () => {
  let clock = 1000000;
  const connectors = create({ now: () => clock, graphProbe: async () => 'Read verified' });
  await connectors.check('graph'); clock += 300001;
  assert.equal(connectors.list().find(x => x.id === 'graph').status, 'unverified');
});

test('Slack and Discord require credentials, channel allowlists, and public-or-owned graph attestation', () => {
 const disconnected=create().list();
 assert.equal(disconnected.find(x=>x.id==='slack').status,'disconnected');
 assert.equal(disconnected.find(x=>x.id==='discord').status,'disconnected');
 const configured=create({env:{MOVA_GRAPH_DATA_ATTESTATION:'public_or_owned',SLACK_BOT_TOKEN:'slack-secret',SLACK_ALLOWED_CHANNEL_IDS:'C123',DISCORD_BOT_TOKEN:'discord-secret',DISCORD_ALLOWED_CHANNEL_IDS:'D456'}}).list();
 assert.equal(configured.find(x=>x.id==='slack').status,'unverified');
 assert.equal(configured.find(x=>x.id==='discord').status,'unverified');
 assert.ok(!JSON.stringify(configured).includes('slack-secret'));
 assert.ok(!JSON.stringify(configured).includes('discord-secret'));
});
