import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.error?.message || 'unknown error').trim()}`);
  return result.stdout.trim();
}

export function planSecrets(root, method) {
  if (!['github', 'vault'].includes(method)) throw new Error('--secrets must be github or vault');
  if (method === 'vault') return { method: 'vault', status: 'not-provisioned' };
  const rootPath = realpathSync(root);
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: rootPath, encoding: 'utf8' });
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec((remote.stdout || '').trim());
  const owner = match?.[1] || run('gh', ['api', 'user', '--jq', '.login'], rootPath);
  const projectName = match?.[2] || basename(rootPath);
  const name = `${projectName}-secret-key`;
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name) || name.length > 100) throw new Error('Cannot derive a valid GitHub owner or secret repository name');
  const localPath = join(dirname(rootPath), name);
  if (existsSync(localPath)) throw new Error(`Secret repository destination already exists: ${localPath}; preserve it and reconcile manually`);
  return { method: 'github', repository: `${owner}/${name}`, localPath: `../${name}` };
}

export function createSecretRepository(root, plan) {
  const target = join(dirname(realpathSync(root)), basename(plan.localPath));
  if (existsSync(target)) throw new Error(`Secret repository destination already exists: ${target}`);
  try {
    run('gh', ['repo', 'create', plan.repository, '--private', '--add-readme'], root);
  } catch (error) {
    throw new Error(`Could not create private GitHub secret repository ${plan.repository}; nothing was reused. ${error.message}`);
  }
  try {
    const visibility = run('gh', ['api', `repos/${plan.repository}`, '--jq', '.visibility'], root);
    if (visibility !== 'private') throw new Error(`GitHub reported visibility ${visibility}; private is required`);
    run('gh', ['repo', 'clone', plan.repository, target], root);
  } catch (error) {
    throw new Error(`GitHub repository ${plan.repository} was created but setup did not complete. Preserve it and inspect visibility and ${target} before retrying; no rollback was attempted. ${error.message}`);
  }
}

export function verifySecretRepository(root, plan) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(plan.repository || '') || !/^\.\.\/[A-Za-z0-9_.-]+-secret-key$/.test(plan.localPath || '')) throw new Error('Invalid secrets repository or local path');
  const target = join(dirname(realpathSync(root)), basename(plan.localPath));
  if (!existsSync(target)) throw new Error(`Secret repository clone is missing: ${target}`);
  const expected = `https://github.com/${plan.repository}.git`;
  const remote = run('git', ['remote', 'get-url', 'origin'], target);
  const canonical = remote.replace(/^git@github\.com:/, 'https://github.com/').replace(/\/?$/, '').replace(/\.git$/, '');
  if (canonical !== expected.slice(0, -4)) throw new Error('Secret repository clone origin does not match the chosen GitHub repository');
  if (run('gh', ['api', `repos/${plan.repository}`, '--jq', '.visibility'], root) !== 'private') throw new Error('Secret repository must be private');
}
