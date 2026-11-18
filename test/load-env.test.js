import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const loadEnvFile = require('../config/load-env.cjs');

test('portable .env is loaded from the executable directory without user-set environment variables', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'meeting-helper-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executableDirectory = path.join(root, 'portable');
  const extractedDirectory = path.join(root, 'extracted');
  mkdirSync(executableDirectory);
  mkdirSync(extractedDirectory);
  const variable = `MEETING_HELPER_ENV_TEST_${process.pid}_${Date.now()}`;
  writeFileSync(path.join(executableDirectory, '.env'), `${variable}=from-portable-env\n`);
  t.after(() => { delete process.env[variable]; });

  const loadedPath = loadEnvFile({
    env: {},
    cwd: executableDirectory,
    executablePath: path.join(extractedDirectory, 'Meeting Helper.exe'),
    packaged: true
  });

  assert.equal(loadedPath, path.join(executableDirectory, '.env'));
  assert.equal(process.env[variable], 'from-portable-env');
});

test('existing process environment variables take precedence over .env', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'meeting-helper-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const variable = `MEETING_HELPER_ENV_TEST_${process.pid}_${Date.now()}_PRECEDENCE`;
  const previous = process.env[variable];
  process.env[variable] = 'from-process';
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
  writeFileSync(path.join(root, '.env'), `${variable}=from-file\n`);

  loadEnvFile({ env: {}, cwd: root, executablePath: path.join(root, 'app.exe'), packaged: true });

  assert.equal(process.env[variable], 'from-process');
});

test('development mode loads .env from the project directory', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'meeting-helper-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const variable = `MEETING_HELPER_ENV_TEST_${process.pid}_${Date.now()}_DEV`;
  writeFileSync(path.join(root, '.env'), `${variable}=from-project-env\n`);
  t.after(() => { delete process.env[variable]; });

  const loadedPath = loadEnvFile({ env: {}, cwd: tmpdir(), projectDirectory: root, packaged: false });

  assert.equal(loadedPath, path.join(root, '.env'));
  assert.equal(process.env[variable], 'from-project-env');
});
