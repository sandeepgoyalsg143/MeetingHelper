import { module } from '@prisma/composer';
import { envParam, envSecret, publicUrl, rawPostgres } from '@prisma/composer-prisma-cloud';
import apiService from './service.ts';

export default module('meetinghelper', ({ provision }) => {
  const database = provision(rawPostgres({ name: 'accountdatabase' }));
  const api = provision(apiService, {
    deps: { db: database },
    input: {
      adminToken: envSecret('ADMIN_TOKEN'),
      sapBaseUrl: envParam('SAP_AI_CORE_BASE_URL'),
      sapClientId: envSecret('SAP_AI_CORE_CLIENT_ID'),
      sapClientSecret: envSecret('SAP_AI_CORE_CLIENT_SECRET'),
      sapTokenUri: envParam('SAP_AI_CORE_TOKEN_URI'),
      sapDeploymentId: envParam('SAP_AI_CORE_DEPLOYMENT_ID'),
      sapModel: envParam('SAP_AI_CORE_MODEL'),
      sapResourceGroup: envParam('SAP_AI_CORE_RESOURCE_GROUP')
    }
  });
  provision(publicUrl({
    id: 'api',
    url: publicUrl.prismaBuild(),
    target: api.http
  }));
});
