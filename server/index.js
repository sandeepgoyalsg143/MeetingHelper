import { createGeminiService } from './gemini.js';
import { createApiServer } from './app.js';
import { createSapAiCoreClient } from './sap-ai-core.js';
import { AppError } from './errors.js';
import { createAccountStore } from './accounts.js';

export async function createApiRuntime({ env = process.env, databaseUrl = env.DATABASE_URL,
  hosted = env.HOSTED_MODE === '1' } = {}) {
  const accounts = hosted
    ? createAccountStore({
      connectionString: databaseUrl,
      ssl: env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true }
    })
    : undefined;
  if (accounts) await accounts.initialize();
  const service = createGeminiService({
    client: createSapAiCoreClient({ env }),
    model: env.SAP_AI_CORE_MODEL || 'gemini-3.5-flash'
  });
  const server = createApiServer({
    service,
    token: env.SERVER_TOKEN,
    accounts,
    adminToken: env.ADMIN_TOKEN
  });
  return { server, accounts, hosted };
}
