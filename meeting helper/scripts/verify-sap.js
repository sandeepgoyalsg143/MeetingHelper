import { createSapAiCoreClient } from '../server/sap-ai-core.js';
import { createGeminiService } from '../server/gemini.js';
import { providerError } from '../server/errors.js';
import loadEnvFile from '../config/load-env.cjs';

loadEnvFile();

try {
  const service = createGeminiService({
    client: createSapAiCoreClient(),
    model: process.env.SAP_AI_CORE_MODEL || 'gemini-3.5-flash'
  });
  const result = await service.verify();
  console.info(JSON.stringify({ provider: 'sap-ai-core', ...result }));
} catch (error) {
  const failure = providerError(error);
  console.error(`${failure.code}: ${failure.message}`);
  process.exitCode = 1;
}
