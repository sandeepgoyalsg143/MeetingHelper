const path = require('node:path');

module.exports = function loadEnvFile() {
  const portableDirectory = process.env.PORTABLE_EXECUTABLE_DIR;
  const envPath = portableDirectory
    ? path.join(portableDirectory, '.env')
    : path.join(__dirname, '..', '.env');
  try {
    process.loadEnvFile(envPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
};
