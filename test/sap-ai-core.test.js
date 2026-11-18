import test from 'node:test';
import assert from 'node:assert/strict';
import { createSapAiCoreClient } from '../server/sap-ai-core.js';
import { createGeminiService, verificationAudio } from '../server/gemini.js';

const MODEL = 'gemini-3.5-flash';
const ENV = {
  SAP_AI_CORE_BASE_URL: 'https://api.example.invalid',
  SAP_AI_CORE_TOKEN_URI: 'https://auth.example.invalid/oauth/token',
  SAP_AI_CORE_CLIENT_ID: 'test-client-id',
  SAP_AI_CORE_CLIENT_SECRET: 'test-client-secret'
};

function deployment(model = MODEL, extra = {}) {
  return {
    id: 'deployment-primary', status: 'RUNNING', scenarioId: 'foundation-models',
    details: { resources: { backendDetails: { model: { name: model } } } },
    ...extra
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fixture({ settings = {}, handler, now } = {}) {
  const wire = [];
  let tokenCount = 0;
  const env = { ...ENV, ...settings };
  const client = createSapAiCoreClient({
    env, now,
    fetchImpl: async (target, options) => {
      const url = new URL(target);
      assert.ok(['api.example.invalid', 'auth.example.invalid'].includes(url.hostname), 'test transport must never call a real service');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      const body = options.body instanceof URLSearchParams
        ? Object.fromEntries(options.body) : options.body ? JSON.parse(options.body) : undefined;
      const entry = { url, options, body };
      wire.push(entry);
      const custom = await handler?.(entry);
      if (custom !== undefined) return custom;
      if (url.pathname === '/oauth/token') {
        return json({ access_token: `test-access-token-${++tokenCount}`, token_type: 'bearer', expires_in: 3600 });
      }
      if (url.pathname.endsWith('/lm/deployments')) return json({ count: 1, resources: [deployment()] });
      if (url.pathname.endsWith('/lm/deployments/deployment-primary')) return json(deployment());
      if (url.pathname.endsWith(`/${MODEL}:generateContent`)) {
        const audio = body.contents[0].parts.find(part => part.inlineData)?.inlineData;
        const text = audio ? audio.data === verificationAudio() ? 'NO_SPEECH' : 'A transcript' : 'A helpful answer';
        return json({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
      }
      throw new Error('Unexpected mocked SAP endpoint');
    }
  });
  return {
    client, wire, env,
    service: createGeminiService({ client }),
    tokenCalls: () => wire.filter(entry => entry.url.pathname === '/oauth/token'),
    inferenceCalls: () => wire.filter(entry => entry.url.pathname.endsWith(':generateContent'))
  };
}

test('SAP OAuth, deployment discovery, Gemini history and audio follow native API contracts', async () => {
  const { service, wire, env, tokenCalls, inferenceCalls } = fixture();
  assert.equal(service.status().provider, 'sap-ai-core');
  assert.equal(service.status().configured, true);
  assert.equal((await service.verify()).audioTranscription, true);
  assert.equal(wire[0].url.href, ENV.SAP_AI_CORE_TOKEN_URI);
  assert.equal(wire[0].options.method, 'POST');
  assert.equal(wire[0].options.headers.authorization,
    `Basic ${Buffer.from(`${env.SAP_AI_CORE_CLIENT_ID}:${env.SAP_AI_CORE_CLIENT_SECRET}`).toString('base64')}`);
  assert.deepEqual(wire[0].body, { grant_type: 'client_credentials' });
  assert.equal(wire[1].url.pathname, '/v2/lm/deployments');
  assert.equal(wire[1].url.searchParams.get('scenarioId'), 'foundation-models');
  assert.equal(wire[1].url.searchParams.get('status'), 'RUNNING');
  assert.equal(wire[1].options.headers['AI-Resource-Group'], 'default');
  const audioProbe = inferenceCalls()[1];
  assert.equal(audioProbe.url.pathname,
    `/v2/inference/deployments/deployment-primary/models/${MODEL}:generateContent`);
  assert.equal(audioProbe.body.contents[0].parts[0].inlineData.mimeType, 'audio/wav');
  assert.equal(audioProbe.body.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
  assert.equal(typeof audioProbe.body.systemInstruction.parts[0].text, 'string');
  const history = [
    { role: 'user', text: 'We agreed on Friday.' },
    { role: 'model', text: 'Understood.' },
    { role: 'user', text: 'Summarize our decision.' }
  ];
  assert.equal(await service.chat(history), 'A helpful answer');
  assert.deepEqual(inferenceCalls().at(-1).body.contents,
    history.map(({ role, text }) => ({ role, parts: [{ text }] })));
  assert.equal(await service.transcribe({ data: 'YXVkaW8=', mimeType: 'audio/webm' }), 'A transcript');
  assert.deepEqual(inferenceCalls().at(-1).body.contents[0].parts[0],
    { inlineData: { data: 'YXVkaW8=', mimeType: 'audio/webm' } });
  assert.equal(tokenCalls().length, 1, 'OAuth token is reused until expiry');
  assert.ok(wire.slice(1).every(entry => entry.options.headers.authorization === 'Bearer test-access-token-1'));
  assert.ok(wire.every(entry => !entry.url.searchParams.has('key') && !entry.options.headers['x-goog-api-key']));
  assert.ok(!JSON.stringify(service.status()).includes(env.SAP_AI_CORE_CLIENT_SECRET));
});

test('root and versioned SAP base URLs are normalized without duplicate slashes or versions', async () => {
  for (const [url, expected] of [
    ['https://api.example.invalid', '/v2/lm/deployments'],
    ['https://api.example.invalid/', '/v2/lm/deployments'],
    ['https://api.example.invalid/v2', '/v2/lm/deployments'],
    ['https://api.example.invalid/v2/', '/v2/lm/deployments'],
    ['https://api.example.invalid/proxy/v2/', '/proxy/v2/lm/deployments']
  ]) {
    const { client, wire } = fixture({ settings: { SAP_AI_CORE_BASE_URL: url } });
    await client.models.get({ model: MODEL });
    assert.equal(wire[1].url.pathname, expected);
  }
});

test('live structured output settings reach native SAP Gemini inference unchanged', async () => {
  const { service, inferenceCalls } = fixture({ handler: entry =>
    entry.body?.generationConfig?.responseMimeType === 'application/json'
      ? json({ candidates: [{ finishReason: 'STOP', content: { parts: [
        { text: '{"transcript":"A question?","answer":"A reply."}' }
      ] } }] }) : undefined });
  await service.verify();
  assert.deepEqual(await service.live({ data: 'YXVkaW8=', mimeType: 'audio/webm', history: [] }),
    { transcript: 'A question?', answer: 'A reply.' });
  const config = inferenceCalls().at(-1).body.generationConfig;
  assert.equal(config.responseMimeType, 'application/json');
  assert.deepEqual(config.responseSchema.required, ['transcript', 'answer']);
  assert.equal(config.maxOutputTokens, 1024);
});

test('missing configuration is explicit, never falls back to a Gemini API key, and makes no requests', async () => {
  const client = createSapAiCoreClient({
    env: { GEMINI_API_KEY: 'must-not-be-used' },
    fetchImpl: () => { throw new Error('Unconfigured services must not call a provider'); }
  });
  assert.equal(client.configured, false);
  assert.equal(client.missingSettings.length, 4);
  await assert.rejects(client.models.get({ model: MODEL }), { code: 'NOT_CONFIGURED' });
  await assert.rejects(createGeminiService({ client }).verify(), { code: 'NOT_CONFIGURED' });
});

test('invalid URLs, credentials-in-URLs, resource groups and deployment IDs are rejected safely', () => {
  for (const settings of [
    { SAP_AI_CORE_BASE_URL: 'http://api.example.invalid' },
    { SAP_AI_CORE_BASE_URL: 'https://name:password@api.example.invalid' },
    { SAP_AI_CORE_BASE_URL: 'https://api.example.invalid?key=private-value' },
    { SAP_AI_CORE_TOKEN_URI: 'https://auth.example.invalid/oauth/token#private-value' },
    { SAP_AI_CORE_TOKEN_URI: 'invalid-private-value' },
    { SAP_AI_CORE_RESOURCE_GROUP: 'invalid\r\nheader' },
    { SAP_AI_CORE_DEPLOYMENT_ID: '../other-deployment' }
  ]) {
    assert.throws(() => fixture({ settings }), error =>
      error.code === 'INVALID_CONFIGURATION' &&
      !error.message.includes('password') && !error.message.includes('private-value'));
  }
});

test('a pinned deployment must match the requested model and sends the configured resource group', async () => {
  const { client, wire } = fixture({
    settings: { SAP_AI_CORE_DEPLOYMENT_ID: 'deployment-primary', SAP_AI_CORE_RESOURCE_GROUP: 'meeting-team' }
  });
  await client.models.get({ model: MODEL });
  assert.equal(wire[1].url.pathname, '/v2/lm/deployments/deployment-primary');
  assert.equal(wire[1].options.headers['AI-Resource-Group'], 'meeting-team');
});

test('pinned model mismatch or a stopped deployment never triggers an inference or fallback', async () => {
  for (const [resource, code] of [
    [deployment('different-gemini-model'), 'DEPLOYMENT_MODEL_MISMATCH'],
    [deployment(MODEL, { status: 'STOPPED' }), 'DEPLOYMENT_NOT_RUNNING']
  ]) {
    const { service, inferenceCalls } = fixture({
      settings: { SAP_AI_CORE_DEPLOYMENT_ID: 'deployment-primary' },
      handler: entry => entry.url.pathname.endsWith('/lm/deployments/deployment-primary') ? json(resource) : undefined
    });
    await assert.rejects(service.verify(), { code });
    assert.equal(inferenceCalls().length, 0);
    assert.equal(service.status().verified, false);
  }
});

test('discovery selects only the exact running model and ignores returned external deployment URLs', async () => {
  const { service, wire } = fixture({
    handler: entry => entry.url.pathname.endsWith('/lm/deployments') ? json({
      count: 3, resources: [
        deployment('gemini-3.5-flash-lite', { id: 'not-requested' }),
        deployment(MODEL, { id: 'stopped', status: 'STOPPED' }),
        deployment(MODEL, { deploymentUrl: 'https://untrusted.invalid/collect' })
      ]
    }) : undefined
  });
  await service.verify();
  assert.ok(wire.every(entry => !entry.url.href.includes('untrusted.invalid')));
  assert.ok(wire.every(entry => !entry.url.href.includes('not-requested') && !entry.url.href.includes('/stopped/')));
});

test('unavailable models and non-Gemini protocols fail without substituting a model', async () => {
  const { service, client, inferenceCalls } = fixture({
    handler: entry => entry.url.pathname.endsWith('/lm/deployments')
      ? json({ count: 1, resources: [deployment('gemini-3.5-flash-lite')] }) : undefined
  });
  await assert.rejects(service.verify(), { code: 'MODEL_UNAVAILABLE' });
  assert.equal(inferenceCalls().length, 0);
  await assert.rejects(client.models.get({ model: 'gpt-5' }), { code: 'MODEL_UNSUPPORTED' });
});

test('discovery paginates before reporting that a requested model is unavailable', async () => {
  const { client, wire } = fixture({
    handler: entry => {
      if (!entry.url.pathname.endsWith('/lm/deployments')) return;
      const offset = Number(entry.url.searchParams.get('$skip'));
      return json({ count: 101, resources: offset === 0
        ? Array.from({ length: 100 }, (_, index) => deployment('another-model', { id: `other-${index}` }))
        : [deployment()] });
    }
  });
  await client.models.get({ model: MODEL });
  assert.equal(wire[2].url.searchParams.get('$skip'), '100');
});

test('concurrent requests share one OAuth exchange and expired tokens are refreshed', async () => {
  let time = 0;
  const { client, tokenCalls } = fixture({ now: () => time });
  await Promise.all([client.models.get({ model: MODEL }), client.models.get({ model: MODEL })]);
  assert.equal(tokenCalls().length, 1);
  time = 3600000;
  await client.models.get({ model: MODEL });
  assert.equal(tokenCalls().length, 2);
});

test('a 401 refreshes the token once and resends only the rejected request', async () => {
  let rejected = false;
  const { service, tokenCalls, inferenceCalls } = fixture({
    handler: entry => {
      if (entry.url.pathname.endsWith(':generateContent') && !rejected) {
        rejected = true;
        return json({ error: 'rejected old token' }, 401);
      }
    }
  });
  await service.verify();
  assert.equal(tokenCalls().length, 2);
  assert.equal(inferenceCalls().length, 3);
  assert.equal(inferenceCalls()[1].options.headers.authorization, 'Bearer test-access-token-2');
});

test('repeated 401s stop after one refresh and do not loop', async () => {
  let reject = true;
  const { service, tokenCalls, wire } = fixture({
    handler: entry => reject && entry.url.pathname.endsWith('/lm/deployments') ? json({}, 401) : undefined
  });
  await assert.rejects(service.verify(), { code: 'AUTH_FAILED' });
  assert.equal(tokenCalls().length, 2);
  assert.equal(wire.filter(entry => entry.url.pathname.endsWith('/lm/deployments')).length, 2);
  reject = false;
  await service.verify();
  assert.equal(tokenCalls().length, 3, 'a known rejected token must not stay cached');
});

for (const [status, code] of [[400, 'SAP_AUTH_FAILED'], [401, 'SAP_AUTH_FAILED'], [403, 'SAP_AUTH_FAILED'],
  [404, 'INVALID_CONFIGURATION'], [429, 'RATE_LIMITED'], [503, 'PROVIDER_UNREACHABLE']]) {
  test(`OAuth ${status} is classified without exposing a token, secret or raw response`, async () => {
    const { service, wire } = fixture({
      handler: entry => entry.url.pathname === '/oauth/token'
        ? json({ error: 'private-provider-details' }, status) : undefined
    });
    await assert.rejects(service.verify(), error =>
      error.code === code && !error.message.includes('private-provider-details') && !error.message.includes(ENV.SAP_AI_CORE_CLIENT_SECRET));
    assert.equal(wire.length, 1);
  });
}

test('malformed token responses never create authenticated requests', async () => {
  for (const body of [
    {}, { access_token: '', expires_in: 3600 }, { access_token: 'invalid\r\ntoken', expires_in: 3600 },
    { access_token: 'test-token', expires_in: 0 }, { access_token: 'test-token', expires_in: 'invalid' },
    { access_token: 'test-token', expires_in: 3600, token_type: 'other' }
  ]) {
    const { service, wire } = fixture({
      handler: entry => entry.url.pathname === '/oauth/token' ? json(body) : undefined
    });
    await assert.rejects(service.verify(), { code: 'INVALID_PROVIDER_RESPONSE' });
    assert.equal(wire.length, 1);
  }
});

for (const operation of ['chat', 'transcribe']) {
  for (const [status, code] of [[400, 'PROVIDER_REJECTED'], [403, 'AUTH_FAILED'], [404, 'MODEL_UNAVAILABLE'],
    [429, 'RATE_LIMITED'], [503, 'PROVIDER_UNREACHABLE']]) {
    test(`SAP ${operation} ${status} does not retry or select another deployment`, async () => {
      let failed = false;
      const { service, tokenCalls, inferenceCalls } = fixture({
        handler: entry => failed && entry.url.pathname.endsWith(':generateContent')
          ? json({ error: 'private-provider-details' }, status) : undefined
      });
      await service.verify();
      failed = true;
      await assert.rejects(operation === 'chat'
        ? service.chat([{ role: 'user', text: 'Approved message' }])
        : service.transcribe({ data: 'YXVkaW8=', mimeType: 'audio/webm' }), error =>
        error.code === code && !error.message.includes('private-provider-details'));
      assert.equal(inferenceCalls().length, 3, 'only one inference request beyond the two verification probes');
      assert.equal(tokenCalls().length, 1, '403 is a permission failure, not a token refresh trigger');
    });
  }
}

test('audio rejection during verification keeps recording and chat disabled', async () => {
  const { service } = fixture({
    handler: entry => entry.body?.contents?.[0]?.parts?.some(part => part.inlineData)
      ? json({ error: 'Unsupported audio' }, 415) : undefined
  });
  await assert.rejects(service.verify(), { code: 'PROVIDER_REJECTED' });
  assert.equal(service.status().verified, false);
  await assert.rejects(service.transcribe({ data: 'YXVkaW8=', mimeType: 'audio/webm' }), { code: 'MODEL_NOT_VERIFIED' });
});

test('malformed and oversized SAP responses are explicit errors, not successful fallbacks', async () => {
  for (const response of [
    () => new Response('not-json', { status: 200 }),
    () => json({ count: 1 }),
    () => json({ count: '1', resources: [] }),
    () => json({ count: 1, resources: [deployment(MODEL, { id: '../invalid' })] }),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 })
  ]) {
    const { service } = fixture({
      handler: entry => entry.url.pathname.endsWith('/lm/deployments') ? response() : undefined
    });
    await assert.rejects(service.verify(), { code: 'INVALID_PROVIDER_RESPONSE' });
  }
});

test('network timeouts and TLS errors are reported without raw diagnostics', async () => {
  for (const [error, code] of [
    [new DOMException('private-network-details', 'TimeoutError'), 'TIMEOUT'],
    [new TypeError('private-network-details', { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } }), 'TLS_ERROR'],
    [new TypeError('private-network-details'), 'PROVIDER_UNREACHABLE']
  ]) {
    const { service } = fixture({ handler: () => { throw error; } });
    await assert.rejects(service.verify(), failure =>
      failure.code === code && !failure.message.includes('private-network-details'));
  }
});
