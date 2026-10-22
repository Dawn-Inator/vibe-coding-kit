# Heavy Process Limits, Memory Watch, Verification Shape

Moved verbatim from SKILL.md (slimming); the SKILL.md entry keeps the digest and pinned rules.

## Core Rule

Maximize safe agent parallelism, but globally limit heavy processes **per host**.

- Read/grep/edit agent work is cheap; it costs no meaningful local memory.
- `tsc`/type-checking, dev servers, browser/e2e stacks, builds, installs, full lint runs, a native
  firmware/mobile build, and a golden-file/pipeline replay rerun are all heavy. A "heavy process group" =
  one typecheck, one dev-server-plus-browser group, one build/install group, one native-build group, or one
  golden-replay group; one e2e run counts as one group.
- **Starting default until you've measured your own machines**: at most 2 concurrent heavy groups on a
  ≥10-core host, at most 1 on fewer — correct this once you have your own memory-pressure/load data. See
  your project's tutorial for the incident this default is based on.

### Heavy Process Limits Per Host

Measure your own machines and set explicit concurrency ceilings — do not guess, and do not copy a number
from another project's hardware.

| Host | Typical constraint | Concurrent heavy groups |
| --- | --- | --- |
| Local developer machine | Fixed RAM, shared with the OS and other apps, often already under memory pressure | Usually **1** — verify with a memory-pressure check before raising it |
| Dedicated cloud test runner (if you have one) | More CPU/RAM, but browser/e2e stacks are still memory-heavy per worker count | Set a ceiling per resource type; cap browser/e2e groups tightly even when other heavy groups have more headroom |

**A larger cloud runner does not mean unlimited heavy groups.** Give browser/e2e groups their own tight
ceiling (often 1), separate from other heavy-group types (typecheck, build, a non-browser test suite), and
let a queueing mechanism hold extra requests rather than fail them outright. **Host limits are tuned
independently** — sending heavy work to a bigger remote host does not raise the local limit.

**Agent parallelism remains orthogonal to heavy-process limits.** Agent count is not a memory variable —
throttling agent parallelism "to save memory" throttles the wrong object: it costs throughput and saves
nothing, because the LLM itself runs off-host and a read/grep/edit agent costs the local machine only tens
of MB. Speed comes from agent parallelism; memory safety comes from heavy-process limiting.

**Prefer machine-enforced worker lifecycle over prose alone, where you can build it.** If your project has
a worktree/lifecycle guard, have it: reject an installer flag before it can spawn dependencies inside a
worker worktree, mark worker worktrees so heavy steps (like a full workspace typecheck) are automatically
skipped during finish/merge, and default a shared test runner to low concurrency unless a controlled lane
explicitly raises it after acquiring a host lock. This does not claim to identify an agent that invokes
arbitrary shell commands directly — a worker that runs installs or bumps concurrency by hand remains a
residual gap that supervision must detect and terminate, not something a guard script alone can fully
close.

## Memory Watch

For large local runs, start or plan a lightweight memory watch before heavy verification. When memory
drops, kill restartable heavy processes first, not the agent wave. The example below uses macOS's
`memory_pressure`; substitute your platform's own equivalent (e.g. `free`/`vmstat` on Linux) if you're not
on macOS.

This watchdog samples the **local** machine only. Once heavy work moves to a dedicated remote host, local
pressure alarms go quiet — that is expected, and it is not evidence the remote run is healthy. Judge a
remote run by its exit code, never by local memory being calm.

```bash
while true; do
  pct=$(memory_pressure 2>/dev/null | awk '/free percentage/ {gsub("%","",$NF); print int($NF)}')
  if [ -n "$pct" ] && [ "$pct" -lt 15 ]; then
    echo "MEM_LOW free=${pct}% top:$(ps aux | sort -k4 -rn | head -3 | awk '{printf "%s%%_%s ", $4, $11}')"
    sleep 60
  fi
  sleep 20
done
```

## Verification Shape

- An agent wave can run while heavy groups are running (within each host's limit) if the wave itself does
  not launch heavy commands.
- Type-checking is run once centrally after a batch, not once per worker, and ideally on a dedicated test
  host rather than the orchestrator's own local machine.
- If a workflow hits session/usage limits, keep completed checkpointed changes and rerun only the failed
  batch after cleaning up any partial edits.
