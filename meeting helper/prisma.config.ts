import { defineConfig as composer, environmentVariables } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';
import { definePrismaConfig } from 'prisma/config';

export default definePrismaConfig({
  composer: composer({
    entry: './prisma-compute/module.ts',
    extensions: [prismaCloud(), nodeBuild()],
    state: prismaState(),
    config: [environmentVariables()],
    secrets: [environmentVariables()]
  })
});
