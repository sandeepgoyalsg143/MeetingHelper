import node from '@prisma/composer/node';
import { rawHttpContract } from '@prisma/composer/http';
import { secretString } from '@prisma/composer/arktype';
import { compute, rawPostgres } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';

const serviceInput = type({
  adminToken: secretString(),
  sapBaseUrl: 'string',
  sapClientId: secretString(),
  sapClientSecret: secretString(),
  sapTokenUri: 'string',
  'sapDeploymentId?': 'string',
  'sapModel?': 'string',
  'sapResourceGroup?': 'string'
});

export default compute({
  name: 'meeting-helper-api',
  deps: { db: rawPostgres() },
  input: serviceInput,
  build: node({ module: import.meta.url, entry: '../dist/meeting-helper-api.mjs' }),
  expose: { http: rawHttpContract }
});
