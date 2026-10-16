import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProvider } from '../server/provider.mjs';

test('Kiro receives a bounded two-minute investigation window while Groq retains one minute', () => {
  assert.equal(createProvider({ env: { LLM_PROVIDER: 'kiro-cli', KIRO_API_KEY: 'test' } }).investigationBudgetMs, 200000);
  assert.equal(createProvider({ env: { LLM_PROVIDER: 'groq', GROQ_API_KEY: 'test' } }).investigationBudgetMs, 60000);
});

function fakeKiroSpawn(onSpawn) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    onSpawn({ command, args, options });
    child.stdin.on('finish', () => {
      setImmediate(() => {
        child.stdout.end(JSON.stringify({ destinationQuery: 'Mumbai airport', goal: 'Reach Mumbai airport', summary: 'Destination identified.' }));
        child.stderr.end();
        child.emit('close', 0);
      });
    });
    return child;
  };
}

test('Kiro headless request uses an isolated profile so desktop login cannot override API-key auth', async () => {
  let invocation;
  let calls = 0;
  const provider = createProvider({
    env: { LLM_PROVIDER: 'kiro-cli', KIRO_API_KEY: 'test-key', KIRO_CLI_PATH: 'kiro-cli', KIRO_HOME: 'C:\\Users\\me\\.kiro' },
    spawnImpl: fakeKiroSpawn(value => {
      invocation = value; calls++;
      const agent = JSON.parse(readFileSync(join(value.options.env.KIRO_HOME, 'agents', 'mova-json.json'), 'utf8'));
      assert.deepEqual(agent.tools, []);
      assert.deepEqual(agent.allowedTools, []);
      assert.equal(agent.includeMcpJson, false);
      assert.deepEqual(agent.resources, []);
    }),
  });

  const intent = await provider.compileIntent({ text: 'Reach Mumbai airport' });

  assert.equal(calls, 1);
  assert.deepEqual(intent, { destinationQuery: 'Mumbai airport', goal: 'Reach Mumbai airport', summary: 'Destination identified.' });
  assert.notEqual(invocation.options.env.KIRO_HOME, 'C:\\Users\\me\\.kiro');
  assert.match(invocation.options.env.KIRO_HOME, /mova-kiro/);
  assert.equal(invocation.options.env.KIRO_API_KEY, 'test-key');
  assert.deepEqual(invocation.args.slice(0, 2), ['chat', '--no-interactive']);
  assert.ok(invocation.args.includes('--trust-tools='));
  assert.ok(invocation.args.includes('mova-json'));
});

test('Kiro timeout rejects promptly even when a subprocess never closes its streams',async()=>{
 let killed=false;
 const provider=createProvider({env:{LLM_PROVIDER:'kiro-cli',KIRO_API_KEY:'test'},setTimeoutImpl:callback=>setTimeout(callback,5),spawnImpl:()=>{const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{killed=true;setTimeout(()=>child.emit('close',null),5);};return child;}});
 const start=Date.now();await assert.rejects(provider.compileIntent({text:'Reach the airport'}),/timed out/);assert.ok(Date.now()-start<1000);assert.equal(killed,true);assert.equal(provider.status().status,'unavailable');
});
