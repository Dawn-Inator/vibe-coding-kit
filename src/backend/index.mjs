import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Run the portable Python AST checker against a consumer project. */
export function checkBackendArchitecture({ projectRoot, configPath = '.vibe-coding/backend-architecture.json' }) {
  if (typeof projectRoot !== 'string' || !projectRoot || typeof configPath !== 'string' || !configPath) {
    throw new TypeError('projectRoot and configPath must be nonempty strings');
  }
  const analyzer = fileURLToPath(new URL('./python_analyzer.py', import.meta.url));
  const run = spawnSync('python3', [analyzer, path.resolve(projectRoot), path.resolve(projectRoot, configPath)], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) {
    throw new Error(`Python backend architecture analyzer failed: ${run.error?.message || run.stderr.trim() || `exit ${run.status}`}`);
  }
  try { return JSON.parse(run.stdout); } catch { throw new Error('Python backend architecture analyzer returned invalid JSON'); }
}
