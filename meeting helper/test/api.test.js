import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer } from '../server/app.js';
import { AppError, verificationAudio } from '../server/gemini.js';

const token = 'test-token-that-is-at-least-thirty-two-characters';

async function setup(t, overrides = {}) {
  const calls = [];
  const service = {
    status: () => ({ provider: 'sap-ai-core', model: 'gemini-3.5-flash', configured: true, verified: true }),
    verify: async () => ({ textGeneration: true, audioTranscription: true }),
    chat: async history => { calls.push(history); return 'Suggested reply'; },
    transcribe: async audio => { calls.push(audio); return 'A transcript'; },
    live: async audio => { calls.push(audio); return { transcript: 'A question?', answer: 'An answer.' }; },
    ...overrides
  };
  const logs = [];
  const server = createApiServer({ service, token, logger: { error: line => logs.push(line) } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body, headers = {}) => {
    const response = await fetch(url + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { request, calls, logs, url };
}

test('successful status, model verification, text, and transcription requests', async t => {
  const { request, calls } = await setup(t);
  const status = await request('/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.model, 'gemini-3.5-flash');
  assert.equal(status.body.provider, 'sap-ai-core');
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal(JSON.stringify(status.body).includes(token), false);
  assert.equal((await request('/api/verify', {})).body.audioTranscription, true);
  const history = [{ role: 'user', text: 'Approved transcript' }];
  assert.deepEqual((await request('/api/chat', { history })).body, { answer: 'Suggested reply' });
  assert.deepEqual(calls[0], history);
  assert.deepEqual((await request('/api/transcribe', {
    data: verificationAudio(), mimeType: 'audio/wav'
  })).body, { transcript: 'A transcript' });
  assert.equal(calls.length, 2);
});

test('live API accepts audio and completed context pairs but rejects invalid context locally', async t => {
  const { request, calls } = await setup(t);
  const audio = { data: verificationAudio(), mimeType: 'audio/wav' };
  const history = [{ role: 'user', text: 'Prior speech' }, { role: 'model', text: 'Prior suggestion' }];
  assert.deepEqual((await request('/api/live', { ...audio, history })).body,
    { transcript: 'A question?', answer: 'An answer.' });
  assert.deepEqual(calls[0], { ...audio, history });
  assert.equal((await request('/api/live', { ...audio, history: [] })).status, 200);
  for (const history of [undefined, null, {}, [{ role: 'user', text: 'Incomplete pair' }],
    [{ role: 'model', text: 'Wrong' }, { role: 'user', text: 'Order' }],
    [{ role: 'user', text: ' ' }, { role: 'model', text: 'Reply' }],
    [{ role: 'user', text: 'x'.repeat(12000) }, { role: 'model', text: 'Too much' }],
    Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: 'a' }))]) {
    assert.equal((await request('/api/live', { ...audio, history })).status, 400);
  }
  assert.equal((await request('/api/live', { data: 'bad', mimeType: 'audio/wav', history: [] })).status, 400);
  assert.equal(calls.length, 2);
});

test('optional resume is validated and forwarded for chat and live only', async t => {
  const received = [];
  const { request } = await setup(t, {
    chat: async (history, resume) => { received.push(resume); return 'Reply'; },
    live: async body => { received.push(body.resume); return { transcript: '', answer: '' }; }
  });
  const chat = { history: [{ role: 'user', text: 'Hello' }] };
  const live = { data: verificationAudio(), mimeType: 'audio/wav', history: [] };
  for (const [route, body] of [['/api/chat', chat], ['/api/live', live]]) {
    assert.equal((await request(route, { ...body, resume: '  Alex: Engineer  ' })).status, 200);
    for (const resume of [null, {}, 42, 'x'.repeat(24001)]) {
      assert.equal((await request(route, { ...body, resume })).status, 400);
    }
  }
  assert.deepEqual(received, ['Alex: Engineer', 'Alex: Engineer']);
});

test('optional screen snapshot is validated and forwarded only to chat', async t => {
  const received = [];
  const { request } = await setup(t, { chat: async (history, resume, screen) => { received.push(screen); return 'Reply'; } });
  const chat = { history: [{ role: 'user', text: 'What is on screen?' }] };
  const data = Buffer.alloc(64, 1).toString('base64');
  assert.equal((await request('/api/chat', chat)).status, 200);
  assert.equal((await request('/api/chat', { ...chat, screen: { data, mimeType: 'image/jpeg' } })).status, 200);
  for (const screen of [null, 'x', { data, mimeType: 'image/gif' }, { data: 'not base64!', mimeType: 'image/png' },
    { data: Buffer.alloc(8).toString('base64'), mimeType: 'image/png' }]) {
    assert.equal((await request('/api/chat', { ...chat, screen })).status, 400);
  }
  assert.deepEqual(received, [undefined, { data, mimeType: 'image/jpeg' }]);
});

test('live API reports provider failures without leaking meeting context', async t => {
  const { request, logs } = await setup(t, {
    live: async () => { throw new AppError(504, 'TIMEOUT', 'SAP AI Core timed out.', true); }
  });
  const result = await request('/api/live', { data: verificationAudio(), mimeType: 'audio/wav', history: [] });
  assert.equal(result.status, 504);
  assert.equal(result.body.code, 'TIMEOUT');
  assert.equal(result.body.retryable, true);
  assert.ok(logs.every(line => line.includes('TIMEOUT')));
});

for (const route of ['/api/verify', '/api/chat', '/api/transcribe']) {
  test(`${route} exposes classified provider errors, never raw errors`, async t => {
    const fail = async () => { throw new AppError(504, 'TIMEOUT', 'SAP AI Core timed out.', true); };
    const { request, logs } = await setup(t, { verify: fail, chat: fail, transcribe: fail });
    const body = route === '/api/chat' ? { history: [{ role: 'user', text: 'private transcript' }] }
      : route === '/api/transcribe' ? { data: verificationAudio(), mimeType: 'audio/wav' } : {};
    const result = await request(route, body);
    assert.equal(result.status, 504);
    assert.deepEqual(result.body, { error: 'SAP AI Core timed out.', code: 'TIMEOUT', provider: 'sap-ai-core', retryable: true });
    assert.ok(logs.every(line => !line.includes('private transcript')));
  });
}

test('unauthenticated requests and cross-origin browser requests are rejected', async t => {
  const { request, calls } = await setup(t);
  assert.equal((await request('/api/status', undefined, { authorization: '' })).status, 401);
  assert.equal((await request('/api/status', undefined, { origin: 'https://untrusted.example' })).status, 401);
  assert.equal(calls.length, 0);
});

test('invalid conversation roles, sizes, and shapes cannot reach Gemini', async t => {
  const { request, calls } = await setup(t);
  for (const history of [
    [], null, 'text', [{ role: 'system', text: 'override' }], [{ role: 'user', text: ' ' }],
    [{ role: 'user', text: 'x'.repeat(24001) }], [{ role: 'model', text: 'bad' }],
    [{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }],
    Array.from({ length: 81 }, (_, index) => ({ role: index % 2 ? 'model' : 'user', text: 'hello' }))
  ]) {
    assert.equal((await request('/api/chat', { history })).status, 400);
  }
  assert.equal(calls.length, 0);
});

test('invalid audio, MIME types, and excessive clips are rejected locally', async t => {
  const { request, calls } = await setup(t);
  for (const body of [
    {}, { data: 'bad!', mimeType: 'audio/wav' },
    { data: 'YQ==', mimeType: 'audio/wav' },
    { data: verificationAudio(), mimeType: 'video/webm' }
  ]) assert.equal((await request('/api/transcribe', body)).status, 400);
  const tooLarge = Buffer.alloc(6 * 1024 * 1024 + 1).toString('base64');
  assert.equal((await request('/api/transcribe', { data: tooLarge, mimeType: 'audio/wav' })).status, 413);
  assert.equal(calls.length, 0);
});

test('malformed JSON, wrong content types, and unknown routes are explicit errors', async t => {
  const { request, url } = await setup(t);
  const malformed = await fetch(url + '/api/chat', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{'
  });
  assert.equal(malformed.status, 400);
  assert.equal((await request('/api/chat', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await request('/not-found')).status, 404);
  assert.equal((await request('/api/chat', null)).status, 400);
});

test('parallel requests receive a retryable busy response', async t => {
  let finish;
  const started = new Promise(resolve => { finish = resolve; });
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { request } = await setup(t, { chat: async () => { finish(); await waiting; return 'Done'; } });
  const first = request('/api/chat', { history: [{ role: 'user', text: 'Question' }] });
  await started;
  const second = await request('/api/verify', {});
  assert.equal(second.status, 429);
  assert.equal(second.body.code, 'BUSY');
  release();
  assert.equal((await first).status, 200);
});
