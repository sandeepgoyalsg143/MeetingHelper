import service from './service.ts';
import { createApiRuntime } from '../server/index.js';

const input = service.input();
const { db } = service.load();
const env = {
  ADMIN_TOKEN: input.adminToken.expose(),
  SAP_AI_CORE_BASE_URL: input.sapBaseUrl,
  SAP_AI_CORE_CLIENT_ID: input.sapClientId.expose(),
  SAP_AI_CORE_CLIENT_SECRET: input.sapClientSecret.expose(),
  SAP_AI_CORE_TOKEN_URI: input.sapTokenUri,
  ...(input.sapDeploymentId ? { SAP_AI_CORE_DEPLOYMENT_ID: input.sapDeploymentId } : {}),
  ...(input.sapModel ? { SAP_AI_CORE_MODEL: input.sapModel } : {}),
  ...(input.sapResourceGroup ? { SAP_AI_CORE_RESOURCE_GROUP: input.sapResourceGroup } : {})
};
const runtime = await createApiRuntime({ env, databaseUrl: db.url, hosted: true });

runtime.server.on('error', (error: Error & { code?: string }) => {
  console.error(`Meeting Helper API listener failed (${error.code ?? 'unknown'}).`);
  void runtime.accounts?.close();
  process.exitCode = 1;
});
runtime.server.listen(service.port(), '0.0.0.0', () => {
  console.info('Meeting Helper API is ready.');
});

process.on('SIGTERM', () => {
  runtime.server.close(() => {
    void runtime.accounts?.close();
  });
});
