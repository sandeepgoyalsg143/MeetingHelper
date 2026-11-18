const path = require('node:path');
const { existsSync } = require('node:fs');

function resolveEnvPath({ env = process.env, cwd = process.cwd(), executablePath = process.execPath,
  projectDirectory = path.join(__dirname, '..'), packaged = false } = {}) {
  const directories = [
    env.PORTABLE_EXECUTABLE_DIR,
    env.PORTABLE_EXECUTABLE_FILE && path.dirname(env.PORTABLE_EXECUTABLE_FILE),
    ...(packaged ? [cwd, path.dirname(executablePath)] : [projectDirectory])
  ].filter(Boolean);
  const uniqueDirectories = [...new Set(directories.map(directory => path.resolve(directory)))];
  return uniqueDirectories.map(directory => path.join(directory, '.env')).find(existsSync);
}

function loadEnvFile(options) {
  const envPath = resolveEnvPath(options);
  if (envPath) process.loadEnvFile(envPath);
  return envPath;
}

module.exports = loadEnvFile;
module.exports.resolveEnvPath = resolveEnvPath;
