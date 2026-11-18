import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AppError, providerError } from './errors.js';
import { safeAdminTokenMatches } from './accounts.js';

const MAX_BODY = 9 * 1024 * 1024;
const MAX_AUDIO = 6 * 1024 * 1024;
const AUDIO_TYPES = new Set(['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/mpeg', 'audio/flac']);
const MAX_IMAGE = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

function invalid(message) {
  throw new AppError(400, 'INVALID_REQUEST', message);
}

function decodeAdminEmail(value) {
  if (value.includes('@')) return value;
  try { return decodeURIComponent(value.replace(/%(?![0-9a-f]{2})/gi, '%25')); }
  catch { throw new AppError(400, 'INVALID_REQUEST', 'Invalid account identifier.'); }
}

function validateResume(body) {
  if (body.resume === undefined) return '';
  if (typeof body.resume !== 'string' || body.resume.length > 24000) {
    invalid('Resume must be text of at most 24000 characters.');
  }
  return body.resume.trim();
}

function validateScreen(body) {
  if (body.screen === undefined) return undefined;
  const screen = body.screen;
  if (!screen || !IMAGE_TYPES.has(screen.mimeType) || typeof screen.data !== 'string' || !screen.data ||
      screen.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(screen.data)) {
    invalid('Screen snapshot must be a base64-encoded JPEG or PNG image.');
  }
  const bytes = Buffer.from(screen.data, 'base64');
  if (bytes.length > MAX_IMAGE) throw new AppError(413, 'IMAGE_TOO_LARGE', 'Screen snapshot must be smaller than 4 MiB.');
  if (bytes.length < 32 || bytes.toString('base64') !== screen.data) invalid('The screen snapshot is empty or invalid.');
  return { data: screen.data, mimeType: screen.mimeType };
}

function validateHistory(body) {
  const { history } = body;
  if (!Array.isArray(history) || history.length < 1 || history.length > 80 || history.length % 2 !== 1) {
    invalid('Provide an alternating conversation ending with a user message (up to 79 messages).');
  }
  let length = 0;
  for (const [index, item] of history.entries()) {
    if (!item || item.role !== (index % 2 === 0 ? 'user' : 'model') ||
        typeof item.text !== 'string' || !item.text.trim() || item.text.length > 24000) {
      invalid('Conversation messages must alternate user/model roles and contain 1-24000 characters.');
    }
    length += item.text.length;
  }
  if (length > 160000) invalid('Conversation is too long. Start a new chat.');
  return history.map(({ role, text }) => ({ role, text }));
}

function validateAudio(body) {
  if (!AUDIO_TYPES.has(body.mimeType) || typeof body.data !== 'string' || !body.data ||
      body.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) {
    invalid('Provide a supported audio MIME type and base64-encoded audio.');
  }
  const bytes = Buffer.from(body.data, 'base64');
  if (bytes.length > MAX_AUDIO) throw new AppError(413, 'AUDIO_TOO_LARGE', 'Audio must be smaller than 6 MiB. Record a shorter clip.');
  if (bytes.length < 44 || bytes.toString('base64') !== body.data) invalid('The audio data is empty or invalid.');
  return { data: body.data, mimeType: body.mimeType };
}

function validateLiveHistory(body) {
  const history = body.history;
  if (!Array.isArray(history) || history.length > 12 || history.length % 2 !== 0) {
    invalid('Live context must contain up to six completed user/model pairs.');
  }
  let length = 0;
  for (const [index, item] of history.entries()) {
    if (!item || item.role !== (index % 2 ? 'model' : 'user') ||
        typeof item.text !== 'string' || !item.text.trim() || item.text.length > 24000) {
      invalid('Live context must alternate nonempty user/model text.');
    }
    length += item.text.length;
  }
  if (length > 12000) invalid('Live context must be at most 12000 characters.');
  return history.map(({ role, text }) => ({ role, text }));
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new AppError(413, 'BODY_TOO_LARGE', 'Request too large. Record a shorter clip.');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { invalid('Request body must be valid JSON.'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') invalid('Request body must be an object.');
  return body;
}

export function createApiServer({ service, token, accounts, adminToken, logger = console }) {
  if (!accounts && (!token || token.length < 32)) throw new Error('A server token of at least 32 characters is required.');
  if (accounts && (!adminToken || adminToken.length < 32)) throw new Error('An admin token of at least 32 characters is required.');
  const expected = Buffer.from(`Bearer ${token}`);
  const loginAttempts = new Map();
  let busy = false;
  return http.createServer({ requestTimeout: 20000, headersTimeout: 10000 }, async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const received = Buffer.from(request.headers.authorization ?? '');
      const bearer = /^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(request.headers.authorization ?? '');
      const adminMatch = accounts && /^\/api\/admin\/users(?:\/([^/]+))?$/.exec(request.url ?? '');
      if (accounts && request.method === 'GET' && request.url === '/api/status') {
        response.end(JSON.stringify({ provider: 'sap-ai-core', authenticationRequired: true }));
        return;
      }
      if (accounts && request.method === 'POST' && request.url === '/api/auth/login') {
        if (request.headers.origin) throw new AppError(401, 'UNAUTHORIZED', 'Login request not allowed.');
        const body = await readJson(request);
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
        const key = `${request.socket.remoteAddress ?? 'unknown'}:${email}`;
        if (loginAttempts.size > 1000) {
          for (const [attemptKey, value] of loginAttempts) {
            if (value.resetAt <= Date.now()) loginAttempts.delete(attemptKey);
          }
        }
        const attempt = loginAttempts.get(key) ?? { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
        if (attempt.resetAt <= Date.now()) {
          attempt.count = 0;
          attempt.resetAt = Date.now() + 15 * 60 * 1000;
        }
        if (attempt.count >= 8) throw new AppError(429, 'LOGIN_RATE_LIMITED', 'Too many sign-in attempts. Try again in 15 minutes.', true);
        const session = await accounts.login(body.email, body.password);
        if (!session) {
          attempt.count++;
          loginAttempts.set(key, attempt);
          throw new AppError(401, 'LOGIN_FAILED', 'Email or password is incorrect, or account access is inactive.');
        }
        loginAttempts.delete(key);
        response.end(JSON.stringify(session));
        return;
      }
      if (adminMatch) {
        if (!safeAdminTokenMatches(request.headers['x-admin-token'], adminToken) || request.headers.origin) {
          throw new AppError(401, 'ADMIN_UNAUTHORIZED', 'Admin authorization required.');
        }
        if (request.method === 'GET' && !adminMatch[1]) {
          response.end(JSON.stringify({ users: await accounts.listUsers() }));
          return;
        }
        if (request.method === 'POST' && !adminMatch[1]) {
          const body = await readJson(request);
          const user = await accounts.createUser(body);
          response.statusCode = 201;
          response.end(JSON.stringify({ user }));
          return;
        }
        if (request.method === 'PUT' && adminMatch[1]) {
          const email = decodeAdminEmail(adminMatch[1]);
          const body = await readJson(request);
          if (!await accounts.setPassword(email, body.password)) {
            throw new AppError(404, 'USER_NOT_FOUND', 'Account not found.');
          }
          response.end(JSON.stringify({ passwordUpdated: true }));
          return;
        }
        if (request.method === 'PATCH' && adminMatch[1]) {
          const email = decodeAdminEmail(adminMatch[1]);
          const body = await readJson(request);
          const user = await accounts.updateUser(email, body);
          if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Account not found.');
          response.end(JSON.stringify({ user }));
          return;
        }
        throw new AppError(404, 'NOT_FOUND', 'Admin route not found.');
      }
      let authenticatedSession;
      if (accounts) {
        if (request.headers.origin) throw new AppError(401, 'UNAUTHORIZED', 'Only the desktop application may access this server.');
        authenticatedSession = bearer ? await accounts.authenticate(bearer[1]) : null;
        if (!authenticatedSession) throw new AppError(401, 'UNAUTHORIZED', 'Sign in is required or account access has been disabled.');
        if (request.method === 'POST' && request.url === '/api/auth/logout') {
          await accounts.logout(bearer[1]);
          response.end(JSON.stringify({ ok: true }));
          return;
        }
      }
      if (!accounts && (received.length !== expected.length || !timingSafeEqual(received, expected) || request.headers.origin)) {
        throw new AppError(401, 'UNAUTHORIZED', 'Only the authenticated desktop app may access this server.');
      }
      if (!accounts && request.method === 'GET' && request.url === '/api/status') {
        response.end(JSON.stringify(service.status()));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/status') {
        response.end(JSON.stringify(service.status()));
        return;
      }
      if (request.method !== 'POST' || !['/api/verify', '/api/chat', '/api/transcribe', '/api/live'].includes(request.url)) {
        throw new AppError(404, 'NOT_FOUND', 'API route not found.');
      }
      const body = await readJson(request);
      if (busy) throw new AppError(429, 'BUSY', 'Another AI request is running. Please wait.', true);
      busy = true;
      try {
        let result;
        if (request.url === '/api/verify') result = await service.verify();
        if (request.url === '/api/chat') {
          const screen = validateScreen(body);
          result = { answer: await service.chat(validateHistory(body), validateResume(body), ...(screen ? [screen] : [])) };
        }
        if (request.url === '/api/transcribe') result = { transcript: await service.transcribe(validateAudio(body)) };
        if (request.url === '/api/live') result = await service.live({ ...validateAudio(body), history: validateLiveHistory(body),
          ...(body.resume !== undefined ? { resume: validateResume(body) } : {}) });
        response.end(JSON.stringify(result));
      } finally { busy = false; }
    } catch (error) {
      const failure = providerError(error);
      // Log classification only: never record audio, messages, credentials, or raw provider errors.
      logger.error(`[meeting-helper] ${failure.code} (${failure.status})`);
      response.statusCode = failure.status;
      response.end(JSON.stringify({
        error: failure.message, code: failure.code, provider: 'sap-ai-core', retryable: failure.retryable
      }));
    }
  });
}
