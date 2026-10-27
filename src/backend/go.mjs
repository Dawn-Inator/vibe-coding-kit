import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Go packages expose exported APIs; they do not use Python's facade import convention. */
export function checkGoArchitecture({ projectRoot, configPath = '.vibe-coding/backend-architecture.json' }) {
  if (typeof projectRoot !== 'string' || !projectRoot || typeof configPath !== 'string' || !configPath) {
    throw new TypeError('projectRoot and configPath must be nonempty strings');
  }
  const analyzer = fileURLToPath(new URL('./go-analyzer/main.go', import.meta.url));
  const run = spawnSync('go', ['run', analyzer, path.resolve(projectRoot), path.resolve(projectRoot, configPath)], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GO111MODULE: 'off', GOPROXY: 'off', GOTOOLCHAIN: 'local' },
  });
  if (run.error || run.status !== 0) {
    throw new Error(`Go backend architecture analyzer failed: ${run.error?.message || run.stderr.trim() || `exit ${run.status}`}`);
  }
  try { return JSON.parse(run.stdout); } catch { throw new Error('Go backend architecture analyzer returned invalid JSON'); }
}
