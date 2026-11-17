# Hook-bypass guard

AI agents never bypass git hooks and never use `git stash` in a managed worktree. Prompt text alone does not stop a
reflexive `git commit --no-verify`, so the kit ships a mechanical PreToolUse guard for the `Bash` tool.

**Where it lives.** `src/worktrees/hook-bypass-guard.mjs` (decision logic), `hook-bypass-guard-lexer.mjs` (shell lexer) and
`hook-bypass-guard-hook.mjs` (hook CLI). The settings snippet `templates/claude-settings-snippet.json` wires it on the `Bash`
matcher next to the primary-write guard. It runs only inside Claude Code agent sessions; a human's own terminal never passes
through it. Other agent hosts without a PreToolUse hook surface are not covered (the rule stays prompt text there).

**Denied** (the rule id appears in the deny message):

| id | forms |
| --- | --- |
| `no-verify` | `--no-verify` on any git subcommand (and unambiguous prefixes such as `--no-ver`); `git commit -n` incl. clusters (`-nm`, `-anm`). `git push -n` is `--dry-run` and stays allowed. |
| `hooks-path` | `-c core.hooksPath=...`, `-ccore.hooksPath=...`, `--config core.hooksPath`, `--config-env=core.hooksPath=...`, `git config core.hooksPath <v>` (write), `GIT_CONFIG_KEY_n=core.hooksPath`, `GIT_CONFIG_PARAMETERS` |
| `husky-skip` | `HUSKY=0`, `HUSKY_SKIP_HOOKS=...`, `SKIP=...` as env prefix / `env` / `export` / bare assignment, plus project-configured names |
| `git-stash` | `git stash` in any form, also behind `-C dir`, `-c k=v`, `--git-dir=...` (`refs/stash` is shared by every worktree) |

**Parsing.** A real shell lexer (quotes, backslash, `$'...'`, comments, `&& || ; | &`, `$(...)`, backticks, `<(...)`, heredocs,
here-strings), then per simple command: leading `VAR=val`, wrappers (`env`, `command`, `sudo`, `nohup`, `time`, `timeout`,
`xargs`, `pnpm|npm|yarn exec`, `npx`), recursion into `bash|sh|zsh -c "..."`, `eval`, and heredocs fed to a stdin-reading shell.
Only the argv of a recognised git command is inspected, so `grep -- --no-verify f`, `echo "git commit --no-verify"`, a heredoc
body to `cat`, a `# --no-verify` comment and `git commit -m "--no-verify"` are allowed.

**Fail-safe.** An unparseable command (unterminated quote or `$(`) or a dynamic program word (`$GIT commit --no-verify`) is
judged as if it were git, and a coarse text fallback denies a bypass token next to `git`. A guard bug (any exception, bad stdin)
fails open: the hook always exits 0 and a broken guard never blocks a legitimate call.

**Limits (not covered).** Bypasses assembled at run time (`--no-$X`, `eval "$(printf ...)"`), scripts or package scripts that run
git internally, git aliases (`alias.c = commit -n`), data via `xargs`/pipes (`echo --no-verify | xargs git commit`), and
`GIT_CONFIG_GLOBAL` files that set `hooksPath`. This is a guardrail against reflexive misuse, not a security boundary.

**Project configuration.** Config key `hookBypassGuard` (defaults in `src/worktrees/config.mjs`; in a consumer, under `worktrees`
in `.vibe-coding/project.config.json`). Like every kit config key it replaces the default as a whole, but omitted fields fall
back to their defaults at read time.

| field | meaning |
| --- | --- |
| `disabledRules` | rule ids to switch off, e.g. `["git-stash"]` |
| `skipSensitivePrograms` | programs before which a bare `SKIP=...` counts as a pre-commit skip list |
| `extraBypassEnvNames` | extra variable names that disable the project's own hooks (denied under `husky-skip`) |
| `hints` | per-rule remediation text appended to the deny message; put project commands and doc links here |

**Tests.** `tests/worktrees/hook-bypass-guard.test.mjs`: table of positive and negative cases, per-rule mutation proof, config
knobs, lexer, hook CLI, and a class guard on the settings snippet. A new bypass form is a new table row first.
