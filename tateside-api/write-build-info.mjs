import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const hash = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
writeFileSync(new URL('../dist-tateside-api/build-info.json', import.meta.url), JSON.stringify({
  hash,
  builtAt: new Date().toISOString(),
}, null, 2));
