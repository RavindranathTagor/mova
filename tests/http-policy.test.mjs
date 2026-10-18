import test from 'node:test';
import assert from 'node:assert/strict';
import {isAllowedRequestOrigin} from '../server/http-policy.mjs';

const configuredOrigins=new Set(['http://localhost:5173','http://127.0.0.1:3001']);

test('request origin accepts configured application and backend origins',()=>{
 assert.equal(isAllowedRequestOrigin('http://localhost:5173','http://127.0.0.1:5174',configuredOrigins),true);
 assert.equal(isAllowedRequestOrigin('http://127.0.0.1:3001','http://127.0.0.1:5174',configuredOrigins),true);
});

test('request origin accepts the exact Vite proxy host when its port changes',()=>{
 assert.equal(isAllowedRequestOrigin('http://127.0.0.1:5174','http://127.0.0.1:5174',configuredOrigins),true);
});

test('request origin continues to reject unrelated cross origins',()=>{
 assert.equal(isAllowedRequestOrigin('https://example.com','http://127.0.0.1:5174',configuredOrigins),false);
 assert.equal(isAllowedRequestOrigin(undefined,'http://127.0.0.1:5174',configuredOrigins),true);
});
