import type { Server } from 'node:http';

export function createApiRuntime(options?: {
  env?: Record<string, string | undefined>;
  databaseUrl?: string;
  hosted?: boolean;
}): Promise<{
  server: Server;
  accounts?: { close(): Promise<void> };
  hosted: boolean;
}>;
