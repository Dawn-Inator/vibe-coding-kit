import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
const readSkill = (name) => readFileSync(join(SKILLS_ROOT, name, 'SKILL.md'), 'utf8');

function assertDispatchBoundary(entry, recovery) {
  assert.match(entry, /spawn_agent.*shares the current directory/);
  assert.match(entry, /does not create an isolated worktree/);
  assert.match(entry, /disjoint file write sets/);
  assert.match(entry, /only the orchestrator stages, commits and finishes/);
  assert.match(entry, /fork_turns: "none"/);
  assert.match(entry, /full-history fork inherits the parent and rejects overrides/);
  assert.match(entry, /exactly one.*final structured handoff privately/);
  assert.match(recovery, /process tree/);
  assert.match(recovery, /background tasks/);
  assert.match(recovery, /own worktree `git status` and `git log`/);
  assert.match(recovery, /liveness is unknown[\s\S]*do not edit/i);
  assert.match(recovery, /confirmed gone[\s\S]*fresh managed worktree[\s\S]*cherry-pick/);
  assert.match(recovery, /completed[\s\S]*not proof/);
}

test('Codex dispatch and takeover protect actual writers, not lifecycle status', () => {
  const entry = readSkill('agent-orchestration-guardrails');
  const recovery = readFileSync(
    join(SKILLS_ROOT, 'agent-orchestration-guardrails/references/ownership-and-recovery.md'),
    'utf8',
  );
  assertDispatchBoundary(entry, recovery);
  assert.match(
    readSkill('agent-worktree-lifecycle'),
    /Worker takeover[\s\S]*process tree[\s\S]*background tasks/,
  );
  // Negative mutations guard the same contract across the two entry points and references.
  assert.throws(() =>
    assertDispatchBoundary(
      entry.replace('does not create an isolated worktree', 'isolates files'),
      recovery,
    ),
  );
  assert.throws(() =>
    assertDispatchBoundary(entry.replace('fork_turns: "none"', 'fork_turns: "all"'), recovery),
  );
  assert.throws(() =>
    assertDispatchBoundary(entry, recovery.replace('confirmed gone', 'reported complete')),
  );
});
