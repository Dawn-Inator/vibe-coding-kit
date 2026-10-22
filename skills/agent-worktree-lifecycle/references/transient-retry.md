# Automatic transient git retry

> Moved verbatim from `SKILL.md` (slimming 2026-10-21). Entry: [../SKILL.md](../SKILL.md).

### Automatic transient git retry

Every git call the tool makes retries up to 3 attempts with 1s then 3s backoff, logging
`git <sub> hit a transient error (<class>, attempt n/3); retrying`. The retryable set is
closed:

- Any command: ref-lock collisions (`Unable to create '*.lock'`, `packed-refs.lock`,
  `cannot lock ref`).
- `fetch`/`push` only: transport errors (`Could not resolve host`, `Connection reset by
  peer`, `Connection timed out`, `The remote end hung up unexpectedly`, `RPC failed`,
  `early EOF`, `SSL_ERROR_SYSCALL`).

Never retried: non-fast-forward / `fetch first` (finish's own integrate loop owns that),
authentication or permission failures, HTTP 40x, hook refusals, a permanent
`cannot lock ref ... exists; cannot create` conflict, and timeouts. Do not wrap the tool
in a retry loop of your own.

Because finish can legitimately take a long time (queue wait plus the fetch/rebase/push
work itself), never invoke it as a single blocking foreground call in an environment
with a foreground command timeout. Launch it detached and poll the log instead:

```bash
nohup node .vibe-coding/kit/cli.mjs worktree finish --message-file /tmp/commit-msg.txt > /tmp/worktree-end.log 2>&1 &
disown
# repeat until the log shows push success/failure or a fatal error:
timeout 110 sh -c 'tail -5 /tmp/worktree-end.log; sleep 60'
```
