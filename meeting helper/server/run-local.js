import { AppError } from './errors.js';
import { createApiRuntime } from './index.js';
import loadEnvFile from '../config/load-env.cjs';

if (process.env.MEETING_HELPER_SMOKE_TEST !== '1') loadEnvFile();

let runtime;
try {
  runtime = await createApiRuntime();
  const port = runtime.hosted ? Number(process.env.PORT || 3000) : 0;
  const host = runtime.hosted ? '0.0.0.0' : '127.0.0.1';
  runtime.server.listen(port, host, () => {
    if (process.send) process.send({ type: 'ready', port: runtime.server.address().port });
    else console.info(`Meeting Helper API listening on ${host}:${runtime.server.address().port}`);
  });
  runtime.server.on('error', () => {
    console.error('Meeting Helper server could not listen on the configured interface.');
    process.exitCode = 1;
  });
  function shutdown() {
    runtime.server.close(async () => {
      await runtime.accounts?.close();
      process.exit(0);
    });
  }
  process.on('SIGTERM', shutdown);
  process.on('disconnect', shutdown);
} catch (error) {
  await runtime?.accounts?.close();
  const message = error instanceof AppError
    ? error.message
    : 'Server configuration invalid. Check SAP AI Core settings and SERVER_TOKEN (at least 32 characters).';
  console.error(message);
  if (process.send) process.send({ type: 'startup-error', message });
  process.exitCode = 1;
}
