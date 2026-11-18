import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { AppError } from './errors.js';

const scrypt = promisify(scryptCallback);
const SESSION_DAYS = 30;
const PASSWORD_BYTES = 64;

function normalizeEmail(email) {
  if (typeof email !== 'string' || email.length > 254) throw new AppError(400, 'INVALID_ACCOUNT', 'Provide a valid email address.');
  const value = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new AppError(400, 'INVALID_ACCOUNT', 'Provide a valid email address.');
  return value;
}

function normalizeExpiry(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new AppError(400, 'INVALID_ACCOUNT', 'Access expiry must be a valid ISO date.');
  return date.toISOString();
}

async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) {
    throw new AppError(400, 'INVALID_ACCOUNT', 'Password must be at least 12 characters and no more than 1024 bytes.');
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, PASSWORD_BYTES, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

async function passwordMatches(password, stored) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024 || typeof stored !== 'string') return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!/^[0-9a-f]{32}$/.test(saltHex ?? '') || !/^[0-9a-f]{128}$/.test(hashHex ?? '')) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), PASSWORD_BYTES,
    { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(expected, actual);
}

function sessionHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createAccountStore({ connectionString, ssl = { rejectUnauthorized: true } } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required for hosted account access.');
  const pool = new Pool({
    connectionString,
    ssl,
    max: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000
  });

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS meeting_helper_users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS meeting_helper_sessions (
        token_hash CHAR(64) PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES meeting_helper_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS meeting_helper_sessions_user_id_idx
        ON meeting_helper_sessions(user_id);
    `);
  }

  async function login(emailInput, password) {
    let email;
    try { email = normalizeEmail(emailInput); } catch { email = ''; }
    const result = await pool.query(
      'SELECT id, email, password_hash, active, expires_at FROM meeting_helper_users WHERE email = $1',
      [email]
    );
    const user = result.rows[0];
    const validPassword = await passwordMatches(password,
      user?.password_hash ?? `${'0'.repeat(32)}:${'0'.repeat(PASSWORD_BYTES * 2)}`);
    if (!user || !validPassword || !user.active ||
        (user.expires_at && new Date(user.expires_at).getTime() <= Date.now())) {
      return null;
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO meeting_helper_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [sessionHash(token), user.id, expiresAt]
    );
    return { token, email: user.email, expiresAt: expiresAt.toISOString() };
  }

  async function authenticate(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
    const result = await pool.query(
      `SELECT u.id, u.email
       FROM meeting_helper_sessions s
       JOIN meeting_helper_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.active = TRUE
         AND (u.expires_at IS NULL OR u.expires_at > NOW())`,
      [sessionHash(token)]
    );
    return result.rows[0] ?? null;
  }

  async function logout(token) {
    if (typeof token === 'string') {
      await pool.query('DELETE FROM meeting_helper_sessions WHERE token_hash = $1', [sessionHash(token)]);
    }
  }

  async function createUser({ email: emailInput, password, expiresAt }) {
    const email = normalizeEmail(emailInput);
    const hashed = await passwordHash(password);
    const expiry = normalizeExpiry(expiresAt);
    const result = await pool.query(
      `INSERT INTO meeting_helper_users (email, password_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, email, active, expires_at, created_at`,
      [email, hashed, expiry]
    ).catch(error => {
      if (error.code === '23505') throw new AppError(409, 'ACCOUNT_EXISTS', 'An account with that email already exists.');
      throw error;
    });
    return result.rows[0];
  }

  async function listUsers() {
    const result = await pool.query(
      'SELECT id, email, active, expires_at, created_at FROM meeting_helper_users ORDER BY created_at DESC'
    );
    return result.rows;
  }

  async function updateUser(emailInput, { active, expiresAt }) {
    const email = normalizeEmail(emailInput);
    const expiry = normalizeExpiry(expiresAt);
    if (active === undefined && expiresAt === undefined) throw new AppError(400, 'INVALID_ACCOUNT', 'Provide active and/or expiresAt.');
    if (active !== undefined && typeof active !== 'boolean') throw new AppError(400, 'INVALID_ACCOUNT', 'active must be true or false.');
    const result = await pool.query(
      `UPDATE meeting_helper_users
       SET active = COALESCE($2, active), expires_at = CASE WHEN $3 THEN $4 ELSE expires_at END
       WHERE email = $1
       RETURNING id, email, active, expires_at, created_at`,
      [email, typeof active === 'boolean' ? active : null, expiresAt !== undefined, expiry]
    );
    return result.rows[0] ?? null;
  }

  async function setPassword(emailInput, password) {
    const email = normalizeEmail(emailInput);
    const hashed = await passwordHash(password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'UPDATE meeting_helper_users SET password_hash = $2 WHERE email = $1 RETURNING id, email',
        [email, hashed]
      );
      if (!result.rows[0]) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('DELETE FROM meeting_helper_sessions WHERE user_id = $1', [result.rows[0].id]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  return { initialize, login, authenticate, logout, createUser, listUsers, updateUser, setPassword, close: () => pool.end() };
}

export function safeAdminTokenMatches(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const actual = Buffer.from(received);
  const secret = Buffer.from(expected);
  return actual.length === secret.length && actual.length >= 32 && timingSafeEqual(actual, secret);
}
