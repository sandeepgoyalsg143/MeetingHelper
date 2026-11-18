import { createGeminiService } from './gemini.js';
import { createApiServer } from './app.js';
import { createSapAiCoreClient } from './sap-ai-core.js';
import { AppError } from './errors.js';
import loadEnvFile from '../config/load-env.cjs';

loadEnvFile();

try {
  const service = createGeminiService({
    client: createSapAiCoreClient(),
    model: process.env.SAP_AI_CORE_MODEL || 'gemini-3.5-flash'
  });
  const server = createApiServer({ service, token: process.env.SERVER_TOKEN });
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    if (process.send) process.send({ type: 'ready', port });
    else console.info(`Meeting Helper API listening on 127.0.0.1:${port}`);
  });
  server.on('error', () => {
    console.error('Meeting Helper server could not listen on loopback.');
    process.exitCode = 1;
  });
  function shutdown() { server.close(() => process.exit(0)); }
  process.on('SIGTERM', shutdown);
  process.on('disconnect', shutdown);
} catch (error) {
  const message = error instanceof AppError
    ? error.message
    : 'Server configuration invalid. Check SAP AI Core settings and SERVER_TOKEN (at least 32 characters).';
  console.error(message);
  if (process.send) process.send({ type: 'startup-error', message });
  process.exitCode = 1;
}
