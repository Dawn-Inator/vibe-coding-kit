// Test helper: make a linked worktree's REFLOG look old.
//
// The worktree reclaim activity probe counts the last HEAD / branch reflog entry as real activity,
// by the timestamp written inside the entry (not the file mtime). A fixture that fakes "idle for N
// days" with utimes alone therefore still reads as freshly committed; rewrite the entry timestamps too.
//
// Node built-ins only, zero third-party dependencies, ESM.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The `.git/worktrees/<name>` admin dir of a linked worktree. */
export function worktreeAdminDir(worktreePath) {
  return /^gitdir:\s*(.+)$/m.exec(readFileSync(join(worktreePath, '.git'), 'utf8'))[1].trim();
}

/** HEAD reflog (admin dir) and the checked-out branch's reflog (common dir) that exist. */
export function worktreeReflogPaths(worktreePath) {
  const admin = worktreeAdminDir(worktreePath);
  const logs = [join(admin, 'logs', 'HEAD')];
  const head = /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(join(admin, 'HEAD'), 'utf8'));
  if (head) {
    const common = resolve(admin, readFileSync(join(admin, 'commondir'), 'utf8').trim());
    logs.push(join(common, 'logs', 'refs', 'heads', head[1].trim()));
  }
  return logs.filter((log) => existsSync(log));
}

/** Rewrite every entry timestamp of this worktree's HEAD and branch reflogs to `ms`. */
export function ageWorktreeReflogs(worktreePath, ms) {
  const seconds = String(Math.floor(ms / 1000));
  for (const log of worktreeReflogPaths(worktreePath)) {
    writeFileSync(log, readFileSync(log, 'utf8').replace(/> \d{9,} ([+-]\d{4})(\t|$)/gm, `> ${seconds} $1$2`));
  }
}
