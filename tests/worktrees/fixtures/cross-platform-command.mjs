import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [action, ...args] = process.argv.slice(2);
if (action === 'install') {
  mkdirSync('node_modules', { recursive: true });
  appendFileSync(join('node_modules', 'install.log'), 'ran\n');
} else if (action === 'write-marker') {
  writeFileSync(args[0], 'ran\n');
} else if (action === 'fail') {
  process.stderr.write(args[0] || 'fixture failure\n');
  process.exitCode = Number(args[1] || 3);
} else if (action === 'tamper-lockfile') {
  appendFileSync('package-lock.json', 'tampered\n');
} else if (action === 'snapshot') {
  writeFileSync(args[1], readFileSync(args[0]));
} else {
  process.stderr.write(`unknown cross-platform fixture action: ${action}\n`);
  process.exitCode = 2;
}
