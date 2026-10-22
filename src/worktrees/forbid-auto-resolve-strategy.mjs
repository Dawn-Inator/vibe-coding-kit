// worktree-guard/forbid-auto-resolve-strategy.mjs
//
// Landing tooling must never auto-resolve conflicts by taking one side wholesale.
//
// `-X theirs` / `-X ours` (and `-s ours`) make git pick a side for EVERY conflicting hunk without a
// human or a test seeing it, so a land "succeeds" while silently reverting someone else's change (in
// the production project this kit comes from, a remediation batch landed through `git rebase -X theirs`
// rolled back other work and only part of the damage was ever audited). The finish path therefore fails
// closed on a conflict (abort + hand-resolve) and refuses these options outright, including when they
// arrive through an operator-controlled value (e.g. a base ref of `-Xtheirs` ends up as a `git rebase`
// positional).

const GUARDED_SUBCOMMANDS = new Set(['rebase', 'merge', 'cherry-pick', 'pull', 'revert']);
const FLAGS_WITH_SEPARATE_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace']);
// -X<opt>, -X <opt>, --strategy-option[=<opt>]: any strategy option is refused (ours/theirs/patience... all
// change conflict handling and none is used by the landing path). -s ours / --strategy=ours discards the
// other side entirely.
const STRATEGY_OPTION = /^(?:-X.*|--strategy-option(?:=.*)?)$/u;
const STRATEGY_FLAG_WITH_VALUE = /^(?:-s|--strategy)$/u;
const STRATEGY_OURS_INLINE = /^(?:-sours|--strategy=ours)$/u;

export function findForbiddenMergeStrategy(args) {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (typeof arg !== 'string' || !arg.startsWith('-')) break;
    i += FLAGS_WITH_SEPARATE_VALUE.has(arg) ? 2 : 1;
  }
  if (!GUARDED_SUBCOMMANDS.has(args[i])) return null;
  for (let j = i + 1; j < args.length; j += 1) {
    const arg = args[j];
    if (typeof arg !== 'string') continue;
    if (arg === '--') break;
    if (STRATEGY_OPTION.test(arg) || STRATEGY_OURS_INLINE.test(arg)) return arg;
    if (STRATEGY_FLAG_WITH_VALUE.test(arg) && args[j + 1] === 'ours') return `${arg} ours`;
  }
  return null;
}

export function assertNoForbiddenMergeStrategy(args) {
  const offending = findForbiddenMergeStrategy(args);
  if (offending) {
    throw new Error(
      `refusing \`git ${args.join(' ')}\`: ${offending} auto-resolves conflicts by taking one side and silently ` +
        'rolls back other work. Landing never uses -X theirs / -X ours / -s ours; ' +
        'resolve the conflict by hand instead.',
    );
  }
}
