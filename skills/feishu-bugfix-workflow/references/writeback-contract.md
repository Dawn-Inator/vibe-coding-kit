# Managed writeback contract

### Bypassing the managed script is bypassing the permission guard

Your project's managed writeback script is the **only** approved write entry point, and it should
be built so it can physically only touch the one status field (the field ID that maps to it
hard-coded in the script), with a drift guard that refuses to touch any row already snapshotted as
`<verified>`. **That design is correct — do not weaken it.** Calling the underlying API/CLI
directly to write this table, even to write the one allowed field, is itself a signal of going
around the guard, regardless of which field gets written.

What the managed script itself must guarantee, so the guard does not depend on the caller behaving:

- **Tracked in the repository.** A writeback script living in a temp directory or on one machine
  disappears with that machine, and the next session improvises a direct API call instead. Keep it
  under version control next to the rest of your automation.
- **Compare-and-set on the current value.** Read the row right before writing and refuse unless its
  status is exactly the expected source state (`<active>`); blank, already-advanced, or any other
  value is a refusal, not something to overwrite.
- **Preconditions as arguments, checked by the script.** The fix commit(s) must already be on the
  shared branch, and both regression layers (local regression + class-level guard) must be named as
  `<file>::<test>` and actually exist in tracked files. Missing either layer refuses the write.
- **Dry-run by default; write only with an explicit flag; read back after writing** and verify the
  status changed and no other field did. Emit a machine-readable receipt.
- Repeatable flags (`--tests a --tests b`) rather than comma-joined lists, so a test name may contain
  a comma.

### "active → `<write-target>`" still requires an actual fix and an actual verification

The rule permitting this direction does not mean it is safe to flip casually. If a row scoped to
one platform (say, iOS) had every verification this round done on a different platform (say,
Android) and the underlying issue was never touched, leave it `active`. Marking a row
`<write-target>` when nothing about it was actually fixed or verified sends the reporter/tester to
re-test something that never changed, wasting their next round.
