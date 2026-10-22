import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
} else if (action === 'hang-and-record-pid') {
  writeFileSync(args[0], String(process.pid));
  setInterval(() => {}, 1000);
} else if (action === 'spawn-ignored-child-and-exit') {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'hang-and-record-pid', args[0]], {
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + 3000;
  while (!existsSync(args[0]) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!existsSync(args[0])) process.exitCode = 4;
} else if (action === 'retry-once-then-hang') {
  const { existsSync } = await import('node:fs');
  if (!existsSync(args[0])) {
    writeFileSync(args[0], 'first attempt\n');
    process.stderr.write('Could not resolve host: injected transient failure\n');
    process.exitCode = 1;
  } else {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'hang-and-record-pid', args[1]], {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.unref();
  }
} else {
  process.stderr.write(`unknown cross-platform fixture action: ${action}\n`);
  process.exitCode = 2;
}
