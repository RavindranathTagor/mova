import test from 'node:test';
import assert from 'node:assert/strict';
import { createTraccar } from '../server/traccar.mjs';

const now = Date.parse('2026-10-11T12:00:00Z');
const env = { TRACCAR_URL: 'http://127.0.0.1:8082', TRACCAR_DEVICE_ID: '7', TRACCAR_TOKEN: 'secret-test-token' };
const position = overrides => ({ id: 19, deviceId: 7, valid: true, latitude: 28.55, longitude: 77.10, accuracy: 12, fixTime: new Date(now - 10000).toISOString(), serverTime: new Date(now).toISOString(), ...overrides });
const response = data => new Response(JSON.stringify(data), { status: 200 });

test('unconfigured tracker never polls and requires an explicit numeric device', async () => {
  let calls = 0;
  const tracker = createTraccar({ env: {}, fetchImpl: async () => { calls++; } });
  assert.equal(tracker.configured, false);
  await assert.rejects(tracker.getLatestPosition(), /not configured/);
  assert.equal(calls, 0);
  assert.throws(() => createTraccar({ env: { ...env, TRACCAR_DEVICE_ID: 'all' } }), /device/i);
});

test('tracker queries only permitted device and preserves actual fix time', async () => {
  let init, url;
  const tracker = createTraccar({ env, now: () => now, fetchImpl: async (u, i) => { url = String(u); init = i; return response([position()]); } });
  const result = await tracker.getLatestPosition();
  assert.equal(url, 'http://127.0.0.1:8082/api/positions?deviceId=7');
  assert.equal(init.headers.Authorization, 'Bearer secret-test-token');
  assert.equal(init.redirect, 'error');
  assert.equal(result.timestamp, now - 10000);
  assert.equal(result.source, 'Traccar');
  assert.equal(result.verificationEligible, true);
  assert.equal(tracker.status().status, 'read_only');
});

test('stale fix cannot become fresh because serverTime is recent', async () => {
  const tracker = createTraccar({ env, now: () => now, fetchImpl: async () => response([position({ fixTime: new Date(now - 121000).toISOString() })]) });
  await assert.rejects(tracker.getLatestPosition(), /stale/i);
});

test('invalid, missing, future and cross-device fixes are rejected', async () => {
  for (const overrides of [{ valid: false }, { latitude: 200 }, { longitude: NaN }, { fixTime: undefined }, { fixTime: new Date(now + 20000).toISOString() }, { deviceId: 8 }, { accuracy: -1 }]) {
    const tracker = createTraccar({ env, now: () => now, fetchImpl: async () => response([position(overrides)]) });
    await assert.rejects(tracker.getLatestPosition());
  }
});

test('missing or zero accuracy is unknown and cannot verify arrival', async () => {
  for (const accuracy of [undefined, 0]) {
    const tracker = createTraccar({ env, now: () => now, fetchImpl: async () => response([position({ accuracy })]) });
    const result = await tracker.getLatestPosition();
    assert.equal(result.accuracy, undefined);
    assert.equal(result.verificationEligible, false);
  }
});

test('cached fix is not restamped and stops being usable when stale', async () => {
  let time = now, calls = 0;
  const tracker = createTraccar({ env, now: () => time, fetchImpl: async () => { calls++; return response([position({ fixTime: new Date(now - 115000).toISOString() })]); } });
  const first = await tracker.getLatestPosition();
  const second = await tracker.getLatestPosition();
  assert.equal(calls, 1);
  assert.equal(first.timestamp, second.timestamp);
  time += 6000;
  await assert.rejects(tracker.getLatestPosition(), /stale/i);
  assert.equal(calls, 1);
});

test('remote failures and redirects never expose credential or upstream body', async () => {
  for (const status of [302, 401, 403, 500]) {
    const tracker = createTraccar({ env, fetchImpl: async () => new Response('secret-test-token', { status, headers: { location: 'https://other.example/api' } }) });
    await assert.rejects(tracker.getLatestPosition(), error => !error.message.includes('secret-test-token'));
  }
  assert.throws(() => createTraccar({ env: { ...env, TRACCAR_URL: 'http://user:password@127.0.0.1:8082' } }), /URL/);
});

test('Basic authentication is supported without including credentials in the URL', async () => {
  let authorization;
  const tracker = createTraccar({ env: { ...env, TRACCAR_TOKEN: '', TRACCAR_USERNAME: 'user@example.test', TRACCAR_PASSWORD: 'password' }, now: () => now, fetchImpl: async (_, init) => { authorization = init.headers.Authorization; return response([position()]); } });
  await tracker.getLatestPosition();
  assert.equal(authorization, `Basic ${Buffer.from('user@example.test:password').toString('base64')}`);
});
