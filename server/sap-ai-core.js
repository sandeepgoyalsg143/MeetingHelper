import { AppError, providerError } from './errors.js';

const REQUIRED_SETTINGS = [
  'SAP_AI_CORE_BASE_URL', 'SAP_AI_CORE_CLIENT_ID',
  'SAP_AI_CORE_CLIENT_SECRET', 'SAP_AI_CORE_TOKEN_URI'
];
const PAGE_SIZE = 100;
const MAX_DEPLOYMENTS = 1000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function invalidResponse() {
  return new AppError(502, 'INVALID_PROVIDER_RESPONSE',
    'SAP AI Core returned an invalid or oversized response. Try again or contact your SAP administrator.', true);
}

function httpsUrl(value, setting) {
  if (!value?.trim()) return undefined;
  let url;
  try { url = new URL(value); }
  catch { throw new AppError(503, 'INVALID_CONFIGURATION', `${setting} must be an HTTPS URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new AppError(503, 'INVALID_CONFIGURATION',
      `${setting} must be an HTTPS URL without embedded credentials, query parameters, or fragments.`);
  }
  return url;
}

async function readJson(response) {
  if (!response.body) throw invalidResponse();
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw invalidResponse();
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw invalidResponse(); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw invalidResponse();
  return result;
}

export function createSapAiCoreClient({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const missingSettings = REQUIRED_SETTINGS.filter(name => !env[name]?.trim());
  const base = httpsUrl(env.SAP_AI_CORE_BASE_URL, 'SAP_AI_CORE_BASE_URL');
  const tokenUri = httpsUrl(env.SAP_AI_CORE_TOKEN_URI, 'SAP_AI_CORE_TOKEN_URI');
  const apiBase = base ? base.href.replace(/\/+$/, '') + (base.pathname === '/' ? '/v2' : '') : undefined;
  const resourceGroup = env.SAP_AI_CORE_RESOURCE_GROUP?.trim() || 'default';
  const deploymentId = env.SAP_AI_CORE_DEPLOYMENT_ID?.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/.test(resourceGroup)) {
    throw new AppError(503, 'INVALID_CONFIGURATION', 'SAP_AI_CORE_RESOURCE_GROUP is not a valid resource group name.');
  }
  if (deploymentId && !/^[a-zA-Z0-9_-]{1,128}$/.test(deploymentId)) {
    throw new AppError(503, 'INVALID_CONFIGURATION', 'SAP_AI_CORE_DEPLOYMENT_ID is not a valid deployment ID.');
  }
  let accessToken;
  let expiresAt = 0;
  let tokenPending;
  let selectedDeployment;

  function requireConfigured() {
    if (missingSettings.length) {
      throw new AppError(503, 'NOT_CONFIGURED',
        `Set these server environment variables and restart: ${missingSettings.join(', ')}.`);
    }
  }

  async function send(url, options, timeout) {
    try {
      return await fetchImpl(url, {
        ...options,
        redirect: 'error',
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
          : AbortSignal.timeout(timeout)
      });
    } catch (error) {
      throw providerError(error);
    }
  }

  async function getToken() {
    requireConfigured();
    if (accessToken && now() < expiresAt) return accessToken;
    if (tokenPending) return tokenPending;
    tokenPending = (async () => {
      accessToken = undefined;
      expiresAt = 0;
      try {
        const response = await send(tokenUri, {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${env.SAP_AI_CORE_CLIENT_ID}:${env.SAP_AI_CORE_CLIENT_SECRET}`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json'
          },
          body: new URLSearchParams({ grant_type: 'client_credentials' })
        }, 15000);
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 400 || response.status === 401 || response.status === 403) {
            throw new AppError(502, 'SAP_AUTH_FAILED',
              'SAP OAuth rejected the client credentials. Check the server environment and service-key permissions.');
          }
          if (response.status === 404) {
            throw new AppError(503, 'INVALID_CONFIGURATION',
              'SAP OAuth endpoint was not found. SAP_AI_CORE_TOKEN_URI must point to the full /oauth/token endpoint.');
          }
          throw providerError({ status: response.status });
        }
        const body = await readJson(response);
        const lifetime = Number(body.expires_in);
        if (typeof body.access_token !== 'string' || !/^[\x21-\x7e]{1,32768}$/.test(body.access_token) ||
            !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 31 * 86400 ||
            (body.token_type !== undefined && String(body.token_type).toLowerCase() !== 'bearer')) {
          throw invalidResponse();
        }
        accessToken = body.access_token;
        expiresAt = now() + lifetime * 1000 - Math.min(30000, lifetime * 100);
        return accessToken;
      } finally { tokenPending = undefined; }
    })();
    return tokenPending;
  }

  async function apiRequest(url, { body, signal, timeout = 60000 } = {}) {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout);
    let token = await getToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await send(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'AI-Resource-Group': resourceGroup,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal
      }, timeout);
      if (response.status === 401 && accessToken === token) {
        accessToken = undefined;
        expiresAt = 0;
      }
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        // Refresh once for a rejected token, never for a permission denial (403).
        token = await getToken();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw providerError({ status: response.status });
      }
      try { return await readJson(response); }
      catch (error) { throw providerError(error); }
    }
  }

  function validateDeployment(deployment, model) {
    const actualModel = deployment?.details?.resources?.backendDetails?.model?.name;
    if (actualModel !== model) {
      throw new AppError(422, 'DEPLOYMENT_MODEL_MISMATCH',
        'The pinned SAP deployment does not match SAP_AI_CORE_MODEL. No substitute was selected. Check the settings before verifying again.');
    }
    if (deployment.status !== 'RUNNING') {
      throw new AppError(409, 'DEPLOYMENT_NOT_RUNNING',
        'The requested SAP AI Core deployment is not running. Ask your administrator to start it, then verify access again.', true);
    }
    if (typeof deployment.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(deployment.id)) throw invalidResponse();
    return { id: deployment.id, model };
  }

  async function resolveDeployment(model) {
    requireConfigured();
    if (!/^gemini-[a-zA-Z0-9._-]{1,113}$/.test(model)) {
      throw new AppError(422, 'MODEL_UNSUPPORTED',
        'This connection supports Gemini models through SAP AI Core. Ask before selecting a different model or protocol.');
    }
    selectedDeployment = undefined;
    const signal = AbortSignal.timeout(20000);
    if (deploymentId) {
      const deployment = await apiRequest(`${apiBase}/lm/deployments/${encodeURIComponent(deploymentId)}`, { signal });
      selectedDeployment = validateDeployment(deployment, model);
      return;
    }
    let offset = 0;
    while (offset < MAX_DEPLOYMENTS) {
      const url = new URL(`${apiBase}/lm/deployments`);
      url.search = new URLSearchParams({
        scenarioId: 'foundation-models', status: 'RUNNING',
        $top: String(PAGE_SIZE), $skip: String(offset)
      }).toString();
      const page = await apiRequest(url, { signal });
      if (!Array.isArray(page.resources) ||
          (page.count !== undefined && (!Number.isSafeInteger(page.count) || page.count < 0))) throw invalidResponse();
      const match = page.resources.find(deployment =>
        deployment?.status === 'RUNNING' &&
        deployment?.details?.resources?.backendDetails?.model?.name === model);
      if (match) {
        selectedDeployment = validateDeployment(match, model);
        return;
      }
      offset += page.resources.length;
      if (!page.resources.length || (page.count !== undefined && offset >= page.count) ||
          (page.count === undefined && page.resources.length < PAGE_SIZE)) break;
    }
    throw new AppError(422, 'MODEL_UNAVAILABLE',
      'No running SAP AI Core deployment matches the exact requested model in this resource group. Check SAP_AI_CORE_MODEL and SAP_AI_CORE_RESOURCE_GROUP, or pin SAP_AI_CORE_DEPLOYMENT_ID. No substitute was selected.');
  }

  return {
    configured: missingSettings.length === 0,
    missingSettings,
    models: {
      async get({ model }) {
        await resolveDeployment(model);
        return { name: model, supportedActions: ['generateContent'] };
      },
      async generateContent({ model, contents, config }) {
        requireConfigured();
        if (!selectedDeployment || selectedDeployment.model !== model) {
          throw new AppError(409, 'MODEL_NOT_VERIFIED', 'Verify the SAP AI Core model deployment before generating content.');
        }
        const url = `${apiBase}/inference/deployments/${encodeURIComponent(selectedDeployment.id)}/models/${encodeURIComponent(model)}:generateContent`;
        return apiRequest(url, { body: {
          contents: typeof contents === 'string' ? [{ role: 'user', parts: [{ text: contents }] }] : contents,
          systemInstruction: { parts: [{ text: config.systemInstruction }] },
          generationConfig: {
            maxOutputTokens: config.maxOutputTokens,
            thinkingConfig: config.thinkingConfig,
            ...(config.responseMimeType ? { responseMimeType: config.responseMimeType } : {}),
            ...(config.responseSchema ? { responseSchema: config.responseSchema } : {})
          }
        } });
      }
    }
  };
}
