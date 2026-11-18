import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let failed = false;
for (const directory of ['config', 'server', 'desktop', 'scripts', 'test']) {
  for (const file of readdirSync(directory)) {
    if (!/\.(js|cjs)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', join(directory, file)], { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
