#!/usr/bin/env node
// Conservative starter-kit preflight classifier. It deliberately emits only
// `full`: a consuming project may replace it with a complete project-aware
// classifier before claiming a smaller tier.
import { spawnSync } from 'node:child_process';
import { isMainModule } from '../lib/main-module.mjs';

function parseArgs(argv) {
  const options = { base: undefined, head: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--base' || arg === '--head') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a ref`);
      const key = arg.slice(2);
      if (options[key] !== undefined) throw new Error(`${arg} may be supplied once`);
      options[key] = value;
    } else throw new Error(`unknown option: ${arg}`);
  }
  if (options.head && !options.base) throw new Error('--head requires --base');
  return options;
}

function gitResult(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
}

function git(args, cwd) {
  const result = gitResult(args, cwd);
  if (result.error) throw new Error(`git ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || Buffer.alloc(0)).toString('utf8').trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function workingHead(top) {
  const headResult = gitResult(['rev-parse', '--verify', 'HEAD^{commit}'], top);
  if (headResult.error) throw new Error(`git rev-parse failed: ${headResult.error.message}`);
  if (headResult.status === 0)
    return { head: headResult.stdout.toString('utf8').trim(), headState: 'commit' };

  // Only a symbolic branch ref whose branch does not yet exist is a valid
  // unborn repository. Detached or malformed HEAD and dangling branch refs fail closed.
  const symbolic = gitResult(['symbolic-ref', '--quiet', 'HEAD'], top);
  if (symbolic.error) throw new Error(`git symbolic-ref failed: ${symbolic.error.message}`);
  if (symbolic.status !== 0)
    throw new Error('HEAD does not resolve to a commit or an unborn branch');
  const ref = symbolic.stdout.toString('utf8').trim();
  const existingRef = gitResult(['show-ref', '--verify', '--quiet', ref], top);
  if (existingRef.error) throw new Error(`git show-ref failed: ${existingRef.error.message}`);
  if (existingRef.status !== 1 || existingRef.stdout.length !== 0)
    throw new Error('HEAD points to an existing branch ref that does not resolve to a commit');
  return { head: null, headState: 'unborn' };
}

function nulPaths(buffer) {
  if (buffer.length === 0) return [];
  if (buffer[buffer.length - 1] !== 0) throw new Error('git returned an incomplete path manifest');
  return splitNul(buffer.subarray(0, -1)).map(decodeUtf8);
}

function splitNul(buffer) {
  const fields = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) {
      fields.push(buffer.subarray(start, i));
      start = i + 1;
    }
  }
  fields.push(buffer.subarray(start));
  return fields;
}

function decodeUtf8(buffer) {
  const value = buffer.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(buffer)) throw new Error('git path is not valid UTF-8');
  return value;
}

function parseNameStatus(buffer) {
  if (buffer.length === 0) return [];
  if (buffer[buffer.length - 1] !== 0)
    throw new Error('git returned an incomplete name-status manifest');
  const fields = splitNul(buffer.subarray(0, -1)).map(decodeUtf8);
  const files = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++];
    if (!/^[ACDMRTUXB](\d{0,3})?$/u.test(status))
      throw new Error('git returned an invalid change status');
    const pathCount = /^[RC]/u.test(status) ? 2 : 1;
    if (i + pathCount > fields.length) throw new Error('git returned an incomplete rename record');
    for (let n = 0; n < pathCount; n += 1) files.push(fields[i++]);
  }
  return files;
}

function buildResult(options, cwd = process.cwd()) {
  const topOutput = git(['rev-parse', '--show-toplevel'], cwd).toString('utf8');
  const top = topOutput.endsWith('\n') ? topOutput.slice(0, -1) : topOutput;
  let files;
  let source;
  let head = options.head;
  let headState = 'commit';
  let base = null;
  if (options.base) {
    // Explicitly resolve refs first so ambiguous/missing refs fail closed.
    base = git(['rev-parse', '--verify', '--end-of-options', `${options.base}^{commit}`], top)
      .toString('utf8')
      .trim();
    if (options.head)
      head = git(['rev-parse', '--verify', '--end-of-options', `${options.head}^{commit}`], top)
        .toString('utf8')
        .trim();
    else head = git(['rev-parse', '--verify', 'HEAD^{commit}'], top).toString('utf8').trim();
    files = parseNameStatus(
      git(['diff', '--no-ext-diff', '--find-renames', '--name-status', '-z', base, head], top),
    );
    source = 'refs';
  } else {
    ({ head, headState } = workingHead(top));
    // Read both sides of the index boundary. Comparing only worktree-to-HEAD can
    // hide a staged change when a later working-tree edit restores the HEAD bytes.
    const staged = parseNameStatus(
      git(['diff', '--cached', '--no-ext-diff', '--find-renames', '--name-status', '-z'], top),
    );
    const unstaged = parseNameStatus(
      git(['diff', '--no-ext-diff', '--find-renames', '--name-status', '-z'], top),
    );
    const untracked = nulPaths(git(['ls-files', '--others', '--exclude-standard', '-z'], top));
    files = [...staged, ...unstaged, ...untracked];
    source = 'working-tree';
  }
  const uniqueFiles = [...new Set(files)].sort();
  return {
    schemaVersion: 1,
    profile: 'full',
    status: uniqueFiles.length === 0 ? 'empty' : 'complete',
    source,
    base,
    head,
    headState,
    files: uniqueFiles,
    fileCount: uniqueFiles.length,
    reason: 'starter-kit default is full; lite requires a complete project-owned classifier',
  };
}

export function main(argv = process.argv.slice(2), io = console) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      io.log(
        'Usage: node .vibe-coding/kit/src/contracts/cli.mjs [--base <ref> [--head <ref>]]',
      );
      io.log(
        'Without --base, classifies staged, unstaged, and untracked files. Output is JSON; profile is always full.',
      );
      return 0;
    }
    io.log(JSON.stringify(buildResult(options)));
    return 0;
  } catch (error) {
    io.error(
      JSON.stringify({
        schemaVersion: 1,
        profile: 'full',
        status: 'error',
        files: null,
        reason: error.message,
      }),
    );
    return 2;
  }
}

if (isMainModule(import.meta.url))
  process.exitCode = main();
