# Mass-deletion guard

> Moved verbatim from `SKILL.md` (slimming 2026-10-21). Entry: [../SKILL.md](../SKILL.md).

### Mass-deletion guard

Finish refuses — before it ever commits, merges, or pushes anything — when the branch
being finished deletes too many tracked files relative to the base branch's merge-base,
or touches a configured set of sensitive paths, whichever triggers first:

- Blocks when the branch deletes at or above a configurable file-count threshold
  (default 20) relative to `merge-base(baseBranch, HEAD)`, **or** touches any path
  matching a configured list of sensitive path prefixes regardless of count. The
  sensitive-path list is empty by default and is meant to be filled in per project —
  typical entries are things like your CI config directory, license file, top-level
  lockfiles, or infrastructure-as-code directories; adapt the list to what would be
  catastrophic to accidentally delete in *your* repo.
- The check runs against both the merge-base comparison **and** the current working
  tree (staged + unstaged), so it also catches an uncommitted deletion before finish's
  own auto-commit step ever turns it into a commit.
- On block, finish prints the exact deleted-file list and the trigger reason, and exits
  without committing, merging, or pushing anything.
- If the deletion is genuinely intentional (a real cleanup/removal task), re-run with
  `--allow-mass-deletion` to proceed.
- This is a structural guard, not an intent guard — it never tries to judge whether a
  commit message matches its diff. A large legitimate rename can also trip it if the
  diff is computed without rename detection; that's an acceptable false positive, worth
  a moment's confirmation before passing `--allow-mass-deletion`.
