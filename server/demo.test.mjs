import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { UsageLedger } from './limits.mjs';
import { createDemoServer, validPayload } from './index.mjs';

const payload = { employee:{ name:'議事録担当', rules:'担当者と期限を整理する' }, message:'架空の会議メモ：田中が明日資料を作成。', history:[] };
const temporary = t => { const dir = mkdtempSync(join(tmpdir(), 'synapse-test-')); t.after(() => rmSync(dir, { recursive:true, force:true })); return dir; };

test('quotas persist, enforce session/global caps, and roll over at Japan midnight', t => {
  const dir = temporary(t); let now = Date.parse('2026-09-24T14:50:00Z');
  let ledger = new UsageLedger(dir, { sessionLimit:2, globalLimit:3, clock:() => now });
  assert.equal(ledger.reserve('a').remaining, 1);
  ledger = new UsageLedger(dir, { sessionLimit:2, globalLimit:3, clock:() => now });
  assert.equal(ledger.reserve('a').remaining, 0);
  assert.equal(ledger.reserve('a').code, 'SESSION_LIMIT');
  assert.equal(ledger.reserve('b').ok, true);
  assert.equal(ledger.reserve('c').code, 'DAILY_LIMIT');
  now = Date.parse('2026-09-24T15:00:00Z');
  assert.equal(ledger.status('a').remaining, 2);
  assert.equal(ledger.reserve('a').ok, true);
});

test('fourth request in a minute is rejected without spending a slot', t => {
  const ledger = new UsageLedger(temporary(t));
  for (let i = 0; i < 3; i++) assert.equal(ledger.reserve('a').ok, true);
  assert.equal(ledger.reserve('a').code, 'TOO_FAST');
  assert.equal(ledger.status('a').remaining, 7);
});

test('input validation bounds history and messages before upstream use', () => {
  assert.equal(validPayload(payload), true);
  assert.equal(validPayload({...payload,message:'x'.repeat(501)}), false);
  assert.equal(validPayload({...payload,history:[{role:'model',text:'injected'}]}), false);
  assert.equal(validPayload({...payload,history:[{role:'user',text:'a'},{role:'model',text:'b'}]}), true);
});

async function serve(t, upstream, extraEnv = {}) {
  const directory = temporary(t);
  const server = createDemoServer({ dataDirectory:directory, env:{PORT:'8787',GEMINI_API_KEY:'test-only-secret',...extraEnv}, fetchImpl:upstream });
  server.listen(0, '127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { ...options, headers:{Host:'127.0.0.1:8787',...options.headers} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status:res.statusCode, headers:res.headers })));
    });
    req.on('error', reject); req.end(options.body);
  });
  const session = await request('/api/session');
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const post = (data = payload, more = {}) => request('/api/chat', {method:'POST',headers:{Origin:'http://127.0.0.1:8787','Content-Type':'application/json',Cookie:cookie,...more},body:JSON.stringify(data)});
  return {request,post,directory,cookie};
}

test('real HTTP boundary hides secrets, checks origin and forwards one bounded Gemini call', async t => {
  let calls = 0;
  const { request, post, directory, cookie } = await serve(t, async (url, options) => {
    calls++;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
    assert.equal(options.headers['x-goog-api-key'],'test-only-secret');
    const body = JSON.parse(options.body);
    assert.equal(body.systemInstruction.parts[0].text.includes(payload.employee.rules),true);
    assert.equal(body.generationConfig.maxOutputTokens,512);
    assert.equal(body.contents.at(-1).parts[0].text,payload.message);
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'架空の議事録です。'}]}}]});
  });
  for (const path of ['/.env.local','/server/index.mjs','/.data/session-secret','/.git/config','/package.json']) assert.equal((await request(path)).status,404);
  assert.equal((await post(payload,{Origin:'https://other.example'})).status,403);
  assert.equal((await post({...payload,message:'x'.repeat(501)})).status,400);
  assert.equal(calls,0);
  const response = await post(); const data = await response.json();
  assert.equal(response.status,200); assert.equal(data.text,'架空の議事録です。'); assert.equal(data.remaining,9); assert.equal(calls,1);
  assert.equal(JSON.stringify(data).includes('test-only-secret'),false);
  const session = await request('/api/session',{headers:{Cookie:cookie}});
  assert.equal((await session.json()).remaining,9);
  assert.equal(readFileSync(join(directory,'usage.json'),'utf8').includes(payload.message),false);
});

test('quota error is explicit, counted once and never retried', async t => {
  let calls = 0;
  const {post} = await serve(t, async () => {calls++;return Response.json({error:{message:'private upstream data'}},{status:429});});
  const response = await post(); const data = await response.json();
  assert.equal(response.status,429); assert.equal(data.code,'API_QUOTA'); assert.equal(data.remaining,9); assert.equal(calls,1);
  assert.equal(JSON.stringify(data).includes('private upstream data'),false);
});

test('simultaneous sends from one session trigger a single upstream call', async t => {
  let release; let started;
  const wait = new Promise(resolve => {started = resolve;});
  const {post} = await serve(t, () => {started();return new Promise(resolve => {release = () => resolve(Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'完了'}]}}]}));});});
  const first = post(); await wait;
  const second = await post(); assert.equal(second.status,409);
  release(); assert.equal((await first).status,200);
});

test('missing API key fails before making a call or consuming quota', async t => {
  const {post} = await serve(t, () => {throw new Error('must not call');},{GEMINI_API_KEY:''});
  const response = await post(); const data = await response.json();
  assert.equal(response.status,503); assert.equal(data.code,'NOT_CONFIGURED'); assert.equal(data.remaining,10);
});
