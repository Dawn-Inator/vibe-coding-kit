import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isMainModule } from '../lib/main-module.mjs';

/** Select a real language analyzer. An unsupported language is never a skipped success. */
export async function checkBackendArchitecture({ projectRoot, configPath = '.vibe-coding/backend-architecture.json' }) {
  if (typeof projectRoot !== 'string' || !projectRoot) throw new Error('projectRoot is required');
  const config = JSON.parse(readFileSync(resolve(projectRoot, configPath), 'utf8'));
  const language = config.language ?? 'python';
  const options = { projectRoot, configPath };
  switch (language) {
    case 'python': return (await import('./index.mjs')).checkBackendArchitecture(options);
    case 'typescript': return (await import('./typescript.mjs')).checkTypeScriptArchitecture(options);
    case 'go': return (await import('./go.mjs')).checkGoArchitecture(options);
    default: throw new Error(`Unsupported backend language: ${String(language)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--project-root', '--config'].includes(key) || !value || value.startsWith('--')) {
      throw new Error('Usage: dispatch.mjs --project-root <path> [--config <path>]');
    }
    const name = key === '--project-root' ? 'projectRoot' : 'configPath';
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: ${key}`);
    options[name] = value;
  }
  const result = await checkBackendArchitecture(options);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`[backend-check] ${error.message}`);
    process.exitCode = 1;
  });
}
