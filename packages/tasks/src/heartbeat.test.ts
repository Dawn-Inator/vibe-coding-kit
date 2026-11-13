import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendHeartbeatWake,
  migrateHeartbeatLedgerPair,
  readHeartbeatLedgerPair,
} from "vibe-coding-kit/src/supervision/heartbeat-ledger-files.mjs";
import { HeartbeatService } from "./heartbeat.js";

const PINNED_KIT_HEARTBEAT_API = fileURLToPath(
  import.meta.resolve("vibe-coding-kit/src/supervision/heartbeat-ledger-api.mjs"),
);

const ledger = (thread = "", legacy = false) =>
  `# Supervision\nthread: ${thread}\n## 2026-11-11T10:00:00Z wake (${legacy ? 8 : 10}-row ledger)\n${legacy ? "" : "contract: heartbeat/v2"}\n## Items\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| A | request | test | blocked | waiting |\n`;
const threadKey = (thread: string) => createHash("sha256").update(thread).digest("hex");
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "task-heartbeat-test-"));
  const project = resolve(root, "project");
  await mkdir(resolve(project, ".git"), { recursive: true });
  const canonicalProject = await realpath(project);
  const kitPath = resolve(root, "kit-api.mjs");
  // Project Kit inspector remains selectable; discovery and projection use the pinned Kit helpers.
  await writeFile(
    kitPath,
    `export function inspectHeartbeatLedger(text, {mode}) {
    const modern = text.includes('heartbeat/v2');
    return {mode, certifiesCurrent:mode==='current'&&modern, passed:mode!=='current'||modern,
      wakes:text.includes('wake (')?[{heading:'wake',timeMs:1794391200000,rows:[]}]:[],
      items:[{id:'A',item:'test item',status:'blocked',evidence:'waiting'}],findings:mode==='items'?[]:modern?[]:[{severity:'error',message:'legacy'}]};
  }`,
  );
  const source = resolve(canonicalProject, "heartbeat.md");
  const service = new HeartbeatService(resolve(root, "data"), {
    kitPath,
    fallbackKitPath: null,
    refreshMs: 0,
  });
  return {
    root,
    project,
    source,
    kitPath,
    service,
    close: async () => {
      service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("absent source stays hidden; unrelated unique source requires selection", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.service.view("chat-A", f.project), null);
    await writeFile(f.source, ledger("chat-B"));
    const candidates = await f.service.view("chat-A", f.project);
    assert.equal(candidates?.status, "candidates");
    assert.equal(candidates?.candidates.length, 1);
    assert.equal(candidates?.sourcePath, null);
    assert.equal((await f.service.taskProjection("chat-A", f.project)).status, "candidates");
    const selected = await f.service.bind("chat-A", f.source, f.project);
    assert.equal(selected?.status, "ready");
    assert.equal(selected?.items[0]?.status, "blocked");
    assert.equal(selected?.cadenceMinutes, null);
    assert.equal(selected?.nextWakeAt, null);
    await f.service.bind("chat-A", null, f.project);
    assert.equal(await f.service.view("chat-A", f.project), null);
    const reopened = new HeartbeatService(resolve(f.root, "data"), {
      kitPath: f.kitPath,
      refreshMs: 0,
    });
    assert.equal(await reopened.view("chat-A", f.project), null);
    reopened.close();
  } finally {
    await f.close();
  }
});

test("project heartbeat view is independent of chat associations and isolated by project root", async () => {
  const f = await fixture();
  try {
    const absent = await f.service.projectView(f.project);
    assert.equal(absent.status, "none");
    await assert.rejects(readFile(resolve(f.root, "data", "bindings.json")), {
      code: "ENOENT",
    });
    await writeFile(f.source, ledger("some-other-chat"));
    const secondProject = resolve(f.root, "second-project");
    await mkdir(resolve(secondProject, ".git"), { recursive: true });
    const secondLedger = resolve(secondProject, "heartbeat.md");
    await writeFile(secondLedger, ledger("unrelated-chat"));
    const project = await f.service.projectView(f.project);
    const otherProject = await f.service.projectView(secondProject);
    assert.equal(project.sourcePath, await realpath(f.source));
    assert.equal(project.historyPath, project.sourcePath);
    assert.equal(otherProject.sourcePath, await realpath(secondLedger));
    assert.equal(project.status, "ready");
    assert.equal(project.status, otherProject.status);
    assert.ok(project.basis === "items-inventory" || project.basis === "latest-recorded-wake");
    const history = await f.service.projectHistory(f.project);
    assert.equal(history.sourcePath, await realpath(f.source));
    assert.equal(history.historyPath, history.sourcePath);
    await assert.rejects(readFile(resolve(f.root, "data", "bindings.json")), {
      code: "ENOENT",
    });
  } finally {
    await f.close();
  }
});

test("project history pages reuse the selected pair, fail closed on changes, and reject escaped paths", async () => {
  const f = await fixture();
  const inspectorPath = resolve(f.root, "pair-history-inspector.mjs");
  const service = new HeartbeatService(resolve(f.root, "pair-history-data"), {
    kitPath: inspectorPath,
    fallbackKitPath: null,
    refreshMs: 60_000,
  });
  const source = resolve(f.project, "heartbeat.md");
  const original = [
    "# Supervision",
    "thread: project-chat",
    "## 2026-11-11T09:00:00Z wake (10-row ledger)",
    "contract: heartbeat/v2",
    "## Items",
    "| id | source | item | status | evidence |",
    "| --- | --- | --- | --- | --- |",
    "| H1 | request | Original project source | pending | - |",
    "## 2026-11-11T10:00:00Z wake (10-row ledger)",
    "contract: heartbeat/v2",
    "",
  ].join("\n");
  const competitor = original
    .replaceAll("project-chat", "different-chat")
    .replace("2026-11-11T09:00:00Z", "2026-11-11T12:00:00Z")
    .replace("2026-11-11T10:00:00Z", "2026-11-11T12:00:00Z");
  const historyInspector = `export function inspectHeartbeatLedger(text,{mode}) {
    const lines=text.split('\\n');
    const headings=lines.filter(line=>/^#{1,6}\\s+\\d{4}-\\d\\d-\\d\\dT.* wake \\(/i.test(line));
    const selected=mode==='history'?headings:headings.slice(-1);
    const wakes=selected.map(heading=>({heading:heading.trim(),timeMs:Date.parse(heading.match(/\\d{4}-\\d\\d-\\d\\dT[^ ]+/)?.[0]||''),line:lines.indexOf(heading)+1,rows:[]}));
    const items=lines.flatMap((line,index)=>{if(!/^\\| H/.test(line))return [];const cells=line.slice(1,-1).split('|').map(cell=>cell.trim());return [{id:cells[0],source:cells[1],item:cells[2],status:cells[3],evidence:cells[4],line:index+1}];});
    return {mode,certifiesCurrent:mode==='current',passed:true,wakeCount:wakes.length,itemCount:items.length,wakes,items,findings:[]};
  }`;
  try {
    await writeFile(inspectorPath, historyInspector);
    await writeFile(source, original);
    const canonicalRoot = await realpath(f.project);
    const canonicalSource = await realpath(source);
    const legacyPair = readHeartbeatLedgerPair({ root: canonicalRoot, path: canonicalSource });
    const pair = migrateHeartbeatLedgerPair({
      root: canonicalRoot,
      path: canonicalSource,
      legacyWritersQuiescent: true,
      expectedContentHash: legacyPair.contentHash,
    });
    const originalPair = readHeartbeatLedgerPair({ root: canonicalRoot, path: canonicalSource });
    const view = await service.projectView(f.project);
    assert.equal(view.status, "ready");
    assert.equal(view.sourcePath, canonicalSource);
    assert.equal(view.historyPath, pair.historyPath);

    await writeFile(resolve(f.project, "heartbeat-later.md"), competitor);
    const newest = await service.projectHistory(f.project, { limit: 1 });
    assert.equal(newest.sourcePath, canonicalSource);
    assert.equal(newest.historyPath, pair.historyPath);
    assert.equal(newest.contentHash, originalPair.contentHash);
    assert.equal(newest.total, 2);
    assert.match(String(newest.wakes[0]?.heading), /2026-11-11T10:00:00Z wake/);
    assert.ok(newest.nextCursor);
    const older = await service.projectHistory(f.project, {
      cursor: newest.nextCursor,
      limit: 1,
    });
    assert.equal(older.sourcePath, canonicalSource);
    assert.equal(older.total, 2);
    assert.match(String(older.wakes[0]?.heading), /2026-11-11T09:00:00Z wake/);

    appendHeartbeatWake({
      root: canonicalRoot,
      path: canonicalSource,
      legacyWritersQuiescent: true,
      expectedContentHash: originalPair.contentHash,
      wakeText: "## 2026-11-11T11:00:00Z wake (10-row ledger)\ncontract: heartbeat/v2\n",
    });
    const changed = await service.projectHistory(f.project, { limit: 1 });
    assert.equal(changed.sourcePath, canonicalSource);
    assert.equal(changed.total, 0);
    assert.deepEqual(changed.wakes, []);
    assert.match(changed.error ?? "", /changed while reading history/);

    const outside = resolve(f.root, "outside-heartbeat.md");
    await writeFile(outside, original);
    await rm(source);
    await symlink(outside, source, "file");
    const escaped = await service.projectHistory(f.project, { limit: 1 });
    assert.equal(escaped.sourcePath, canonicalSource);
    assert.deepEqual(escaped.wakes, []);
    assert.match(escaped.error ?? "", /outside its verified project path/);
  } finally {
    service.close();
    await f.close();
  }
});

test("pinned Kit inspector pages the bound source independently from the project latest ledger", async () => {
  const f = await fixture();
  const service = new HeartbeatService(resolve(f.root, "pinned-kit-data"), {
    kitPath: PINNED_KIT_HEARTBEAT_API,
    fallbackKitPath: null,
    refreshMs: 0,
  });
  const tenRowWake = (time: string, state: string) =>
    [
      `## ${time} wake (10-row ledger)`,
      "contract: heartbeat/v2",
      "| # | category | state |",
      "| --- | --- | --- |",
      ...Array.from(
        { length: 10 },
        (_, index) => `| ${index + 1} | audit ${index + 1} | ${state} |`,
      ),
      "",
    ].join("\n");
  const sourceText = [
    "# Supervision",
    "## Items",
    "| id | source | item | status | evidence | children | owner | repository | worktree | mode | write_set | dispatch_ref |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| H1 | request | Bound task | pending | - | [] | - | - | - | - | - | - |",
    "",
    "thread: actual-chat",
    "",
    tenRowWake("2026-11-11T10:00Z", "done"),
    tenRowWake("2026-11-11T11:00Z", "done"),
  ].join("\n");
  const latestText = [
    "# Supervision",
    "## Items",
    "| id | source | item | status | evidence | children | owner | repository | worktree | mode | write_set | dispatch_ref |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| H2 | request | Other chat | pending | - | [] | - | - | - | - | - | - |",
    "",
    "thread: unrelated-chat",
    "",
    tenRowWake("2026-11-11T12:00Z", "done"),
  ].join("\n");
  const source = resolve(f.project, "heartbeat-bound.md");
  const latest = resolve(f.project, "heartbeat-latest.md");
  const localEventsPath = resolve(
    f.project,
    ".workspace/codex-task-progress/tasks/v3",
    threadKey("actual-chat"),
    "taskhistory.md",
  );
  await mkdir(
    resolve(f.project, ".workspace/codex-task-progress/tasks/v3", threadKey("actual-chat")),
    { recursive: true },
  );
  await writeFile(source, sourceText);
  await writeFile(latest, latestText);
  await writeFile(localEventsPath, '{"type":"local-task.event","keep":true}\n');
  const localEventsBefore = await readFile(localEventsPath, "utf8");
  try {
    const taskProjection = await service.taskProjection("actual-chat", f.project);
    assert.equal(taskProjection.status, "error");
    assert.match(taskProjection.error ?? "", /Cannot project invalid heartbeat Items report/);
    const page = await service.history("actual-chat", f.project, { limit: 1 });
    assert.equal(page.error, undefined);
    assert.equal(page.sourcePath, await realpath(source));
    assert.equal(page.historyPath, await realpath(source));
    await assert.rejects(
      readFile(resolve(await realpath(f.project), "heartbeat-bound.taskhistory.md")),
      { code: "ENOENT" },
    );
    assert.equal(page.total, 2);
    assert.match(String(page.wakes[0]?.heading), /2026-11-11T11:00Z/);
    assert.equal(page.wakes[0]?.line, 24);
    const rows = page.wakes[0]?.rows as {
      num: number;
      category: string;
      state: string;
      line: number;
    }[];
    assert.equal(rows.length, 10);
    assert.deepEqual(rows[0], {
      num: 1,
      category: "audit 1",
      state: "done",
      line: 28,
      sourcePath: await realpath(source),
    });
    assert.equal(page.wakes[0]?.sourcePath, await realpath(source));
    assert.equal(page.historyPath, await realpath(source));
    assert.ok(page.nextCursor);
    const older = await service.history("actual-chat", f.project, {
      cursor: page.nextCursor,
      limit: 1,
    });
    assert.match(String(older.wakes[0]?.heading), /2026-11-11T10:00Z/);
    assert.equal(older.total, 2);
    const projectLatest = await service.projectHistory(f.project, { limit: 1 });
    assert.equal(projectLatest.sourcePath, await realpath(latest));
    assert.notEqual(projectLatest.sourcePath, page.sourcePath);
    const emptySource = resolve(f.project, "heartbeat-empty.md");
    await writeFile(
      emptySource,
      sourceText
        .replaceAll("actual-chat", "empty-chat")
        .replace(tenRowWake("2026-11-11T10:00Z", "done"), "")
        .replace(tenRowWake("2026-11-11T11:00Z", "done"), ""),
    );
    const empty = await service.history("empty-chat", f.project);
    assert.equal(empty.sourcePath, await realpath(emptySource));
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.wakes, []);
    await assert.rejects(service.history("actual-chat", f.project, { cursor: "bad" }), /cursor/);
    await assert.rejects(service.history("actual-chat", f.project, { limit: 100 }), /limit/);
    assert.equal(await readFile(source, "utf8"), sourceText);
    assert.equal(await readFile(latest, "utf8"), latestText);
    assert.equal(await readFile(localEventsPath, "utf8"), localEventsBefore);
  } finally {
    service.close();
    await f.close();
  }
});

test("large project inventory keeps status aggregation bounded and preserves source totals", async () => {
  const f = await fixture();
  try {
    const count = 4_000;
    const rows = Array.from(
      { length: count },
      (_, index) =>
        `| I${index} | request | Item ${index} | custom-status-${index} | Evidence ${index} |`,
    );
    await writeFile(
      f.source,
      [
        "# Supervision",
        "## Items",
        "| id | source | item | status | evidence |",
        "| --- | --- | --- | --- | --- |",
        ...rows,
        "",
      ].join("\n"),
    );
    const view = await f.service.projectView(f.project);
    assert.equal(view.status, "ready");
    assert.equal(view.itemCount, count);
    assert.deepEqual(view.itemStatusCounts, { unknown: count });
    assert.equal(Object.keys(view.itemStatusCounts).length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(view)) < 192 * 1024);
  } finally {
    await f.close();
  }
});

test("first unique association latches; an initially ambiguous set requires selection", async () => {
  const f = await fixture();
  try {
    await writeFile(f.source, ledger("chat-AB"));
    assert.equal((await f.service.view("chat-A", f.project))?.status, "candidates");
    await writeFile(f.source, ledger("chat-A"));
    const view = await f.service.view("chat-A", f.project);
    assert.equal(view?.status, "ready");
    assert.equal(view?.certifiesCurrent, true);
    await writeFile(resolve(f.project, "second.md"), ledger("chat-A"));
    const latched = await f.service.view("chat-A", f.project);
    assert.equal(latched?.status, "ready");
    assert.equal(latched?.sourcePath, f.source);
    await f.service.bind("chat-A", null, f.project);
    const ambiguousService = new HeartbeatService(resolve(f.root, "ambiguous-data"), {
      kitPath: f.kitPath,
      refreshMs: 0,
    });
    const ambiguous = await ambiguousService.view("chat-A", f.project);
    assert.equal(ambiguous?.status, "candidates");
    assert.equal(ambiguous?.candidates.length, 2);
    const ambiguousTask = await ambiguousService.taskProjection("chat-A", f.project);
    assert.equal(ambiguousTask.status, "pending-selection");
    assert.match(ambiguousTask.error ?? "", /Multiple heartbeat ledgers/);
    ambiguousService.close();
  } finally {
    await f.close();
  }
});

test("automatic source remains latched and stale through loss of association, deletion, and restart", async () => {
  const f = await fixture();
  try {
    await writeFile(f.source, ledger("chat-A"));
    const selected = await f.service.view("chat-A", f.project);
    assert.equal(selected?.status, "ready");
    const replacement = resolve(f.project, "replacement.md");
    await writeFile(f.source, ledger("chat-B"));
    await writeFile(replacement, ledger("chat-A"));
    const invalidated = await f.service.view("chat-A", f.project);
    assert.equal(invalidated?.status, "stale");
    assert.equal(invalidated?.sourcePath, f.source);
    assert.equal((await f.service.taskProjection("chat-A", f.project)).status, "stale");
    await rm(f.source);
    f.service.close();
    const reopened = new HeartbeatService(resolve(f.root, "data"), {
      kitPath: f.kitPath,
      fallbackKitPath: null,
      refreshMs: 0,
    });
    const afterRestart = await reopened.view("chat-A", f.project);
    assert.equal(afterRestart?.status, "stale");
    assert.equal(afterRestart?.sourcePath, f.source);
    assert.equal((await reopened.taskProjection("chat-A", f.project)).status, "stale");
    reopened.close();
  } finally {
    await f.close();
  }
});

test("incomplete file and depth scans block automatic selection but allow explicit candidate binding", async () => {
  const f = await fixture();
  try {
    await writeFile(f.source, ledger("chat-A"));
    await writeFile(resolve(f.project, "other.md"), ledger("chat-A"));
    const fileLimited = new HeartbeatService(resolve(f.root, "file-limited"), {
      kitPath: f.kitPath,
      fallbackKitPath: null,
      maxFiles: 1,
      refreshMs: 0,
    });
    const pending = await fileLimited.view("chat-A", f.project);
    assert.equal(pending?.discoveryComplete, false);
    const fileLimitedTask = await fileLimited.taskProjection("chat-A", f.project);
    assert.equal(fileLimitedTask.status, "pending-selection");
    assert.match(fileLimitedTask.error ?? "", /discovery was incomplete/);
    const selected = await fileLimited.bind(
      "chat-A",
      pending?.candidates[0]?.path ?? f.source,
      f.project,
    );
    assert.equal(selected?.status, "ready");
    fileLimited.close();

    const nested = resolve(f.project, "nested");
    await mkdir(nested);
    await writeFile(resolve(nested, "nested.md"), ledger("chat-Z"));
    const depthLimited = new HeartbeatService(resolve(f.root, "depth-limited"), {
      kitPath: f.kitPath,
      fallbackKitPath: null,
      maxDepth: 0,
      refreshMs: 0,
    });
    const depthView = await depthLimited.view("chat-Z", f.project);
    assert.equal(depthView?.discoveryComplete, false);
    const depthLimitedTask = await depthLimited.taskProjection("chat-Z", f.project);
    assert.equal(depthLimitedTask.status, "pending-selection");
    assert.match(depthLimitedTask.error ?? "", /discovery was incomplete/);
    const projectView = await depthLimited.projectView(f.project);
    assert.equal(projectView.status, "ready");
    assert.match(projectView.warning ?? "", /discovery was incomplete/);
    depthLimited.close();
  } finally {
    await f.close();
  }
});

test("explicit binding persists and deletion preserves stale data until recovery", async () => {
  const f = await fixture();
  try {
    await writeFile(f.source, ledger());
    await f.service.bind("chat-A", f.source, f.project);
    await rm(f.source);
    const stale = await f.service.view("chat-A", f.project);
    assert.equal(stale?.status, "stale");
    assert.equal(stale?.certifiesCurrent, false);
    assert.equal(stale?.items.length, 1);
    const unavailableTask = await f.service.taskProjection("chat-A", f.project);
    assert.equal(unavailableTask.status, "stale");
    assert.equal(unavailableTask.task, null);
    assert.equal(unavailableTask.sourcePath, f.source);
    await writeFile(f.source, ledger());
    assert.equal((await f.service.view("chat-A", f.project))?.status, "ready");
    const reopened = new HeartbeatService(resolve(f.root, "data"), {
      kitPath: f.kitPath,
      refreshMs: 0,
    });
    assert.equal((await reopened.view("chat-A", f.project))?.sourcePath, f.source);
    reopened.close();
  } finally {
    await f.close();
  }
});

test("legacy records remain readable without current certification; cadence only from config", async () => {
  const f = await fixture();
  try {
    await writeFile(f.source, ledger("chat-A", true));
    await writeFile(
      resolve(f.project, ".codex-task-progress.json"),
      JSON.stringify({ heartbeat: { cadenceMinutes: 20 } }),
    );
    const view = await f.service.view("chat-A", f.project);
    assert.equal(view?.status, "ready");
    assert.equal(view?.certifiesCurrent, false);
    assert.equal(view?.passed, false);
    assert.equal(view?.wakes.length, 1);
    assert.equal(view?.cadenceMinutes, 20);
    assert.equal(view?.nextWakeAt, null, "Kit cadence requires a canonical full ten-row audit");
    const before = await readFile(f.source, "utf8");
    await f.service.view("chat-A", f.project);
    assert.equal(await readFile(f.source, "utf8"), before);
  } finally {
    await f.close();
  }
});

test("associated ledger projects a read-only Kit task without changing source text", async () => {
  const f = await fixture();
  try {
    const original = ledger("chat-A");
    await writeFile(f.source, original);
    await f.service.view("chat-A", f.project);
    const projected = await f.service.taskProjection("chat-A", f.project);
    assert.equal(projected.status, "ready");
    assert.equal(projected.task?.source?.kind, "kit-heartbeat");
    assert.equal(projected.task?.source?.readOnly, true);
    assert.equal(projected.task?.source?.path, f.source);
    assert.equal(projected.itemStatuses?.A, "blocked");
    assert.equal(projected.task?.objectives[0]?.status, "blocked");
    assert.equal(await readFile(f.source, "utf8"), original);
  } finally {
    await f.close();
  }
});

test("missing Kit is an actionable error, unrelated ignored directories never appear", async () => {
  const f = await fixture();
  try {
    await mkdir(resolve(f.project, "node_modules"));
    await writeFile(resolve(f.project, "node_modules/ignored.md"), ledger("chat-A"));
    assert.equal(await f.service.view("chat-A", f.project), null);
    await writeFile(f.source, ledger("chat-A"));
    const missingKit = new HeartbeatService(resolve(f.root, "other"), {
      fallbackKitPath: null,
      refreshMs: 0,
    });
    const view = await missingKit.view("chat-A", f.project);
    assert.equal(view?.status, "error");
    assert.match(view?.error ?? "", /Kit heartbeat API unavailable/);
    assert.equal(view?.sourcePath, f.source);
    missingKit.close();
  } finally {
    await f.close();
  }
});

test("unrecognized paths cannot be bound", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.bind("chat-A", resolve(f.root, "outside.md"), f.project),
      /discovered project ledger/,
    );
  } finally {
    await f.close();
  }
});

test("source relation survives cache deletion and restart without JSON bindings or observed event logs", async () => {
  const f = await fixture();
  try {
    await writeFile(f.source, ledger("chat-A"));
    await f.service.view("chat-A", f.project);
    await f.service.view("chat-A", f.project);
    const historyPath = resolve(f.root, "data/tasks/v3", threadKey("chat-A"), "taskhistory.md");
    assert.match(await readFile(historyPath, "utf8"), /source-binding/);
    await rm(resolve(f.root, "data/.tmpcache"), { recursive: true, force: true });
    const recovered = new HeartbeatService(resolve(f.root, "data"), {
      kitPath: f.kitPath,
      refreshMs: 0,
    });
    const recoveredView = await recovered.view("chat-A", f.project);
    assert.equal(recoveredView?.status, "ready");
    assert.equal((await recovered.taskProjection("chat-A", f.project)).status, "ready");
    const recoveredHistory = await recovered.history("chat-A", f.project);
    assert.equal(recoveredHistory.total, 1);
    assert.equal(recoveredHistory.sourcePath, await realpath(f.source));
    recovered.close();

    await rm(f.source);
    const reopened = new HeartbeatService(resolve(f.root, "data"), {
      kitPath: f.kitPath,
      refreshMs: 0,
    });
    const stale = await reopened.view("chat-A", f.project);
    assert.equal(stale?.status, "stale");
    reopened.close();
    const { readdir } = await import("node:fs/promises");
    const activeFiles = await readdir(resolve(f.root, "data"));
    assert.equal(activeFiles.includes("bindings.json"), false);
    assert.equal(
      activeFiles.some((name) => name.endsWith(".jsonl")),
      false,
    );
    assert.match(await readFile(historyPath, "utf8"), /source-binding/);
  } finally {
    await f.close();
  }
});

test("corrupt or unavailable heartbeat cache never blocks Kit source, task, or history reads", async () => {
  const f = await fixture();
  const cacheRoot = resolve(f.root, "heartbeat-cache");
  const service = new HeartbeatService(resolve(f.root, "cache-data"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    cacheRoot,
    refreshMs: 0,
  });
  const services: HeartbeatService[] = [service];
  try {
    await writeFile(f.source, ledger("chat-A"));
    assert.equal((await service.view("chat-A", f.project))?.status, "ready");
    const snapshotPath = resolve(cacheRoot, `${threadKey("chat-A")}.snapshot.json`);
    await writeFile(snapshotPath, '{"view":');

    const corruptCache = new HeartbeatService(resolve(f.root, "cache-data"), {
      kitPath: f.kitPath,
      fallbackKitPath: null,
      cacheRoot,
      refreshMs: 0,
    });
    services.push(corruptCache);
    assert.equal((await corruptCache.view("chat-A", f.project))?.status, "ready");
    assert.equal((await corruptCache.taskProjection("chat-A", f.project)).status, "ready");
    assert.equal((await corruptCache.history("chat-A", f.project)).total, 1);
    assert.equal(JSON.parse(await readFile(snapshotPath, "utf8")).view.status, "ready");

    const blockedCacheRoot = resolve(f.root, "cache-root-is-a-file");
    await writeFile(blockedCacheRoot, "cache I/O failure");
    const unavailableCache = new HeartbeatService(resolve(f.root, "cache-data"), {
      kitPath: f.kitPath,
      fallbackKitPath: null,
      cacheRoot: blockedCacheRoot,
      refreshMs: 0,
    });
    services.push(unavailableCache);
    assert.equal((await unavailableCache.view("chat-A", f.project))?.status, "ready");
    assert.equal((await unavailableCache.taskProjection("chat-A", f.project)).status, "ready");
    const unavailableHistory = await unavailableCache.history("chat-A", f.project);
    assert.equal(unavailableHistory.total, 1);
    assert.equal(unavailableHistory.sourcePath, await realpath(f.source));
    assert.equal(await readFile(blockedCacheRoot, "utf8"), "cache I/O failure");

    const relationHistory = resolve(
      f.root,
      "cache-data/tasks/v3",
      threadKey("chat-A"),
      "taskhistory.md",
    );
    const validRelationHistory = await readFile(relationHistory, "utf8");
    const corruptRelationHistory = "# damaged authoritative relation history\n";
    await writeFile(relationHistory, corruptRelationHistory);
    const authoritativeError = new HeartbeatService(resolve(f.root, "cache-data"), {
      kitPath: f.kitPath,
      fallbackKitPath: null,
      cacheRoot,
      refreshMs: 0,
    });
    services.push(authoritativeError);
    const failedClosed = await authoritativeError.view("chat-A", f.project);
    assert.equal(failedClosed?.status, "stale");
    assert.match(failedClosed?.error ?? "", /Corrupt Markdown records/);
    assert.equal(await readFile(relationHistory, "utf8"), corruptRelationHistory);
    await writeFile(relationHistory, validRelationHistory);
  } finally {
    for (const current of services) current.close();
    await f.close();
  }
});

test("a stored source remains readable when discovery budgets hide it from the project scan", async () => {
  const f = await fixture();
  const nestedSource = resolve(f.project, ".workspace", "deep", "heartbeat.md");
  const bounded = new HeartbeatService(resolve(f.root, "data"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    maxFiles: 1,
    maxDepth: 0,
    refreshMs: 0,
  });
  try {
    await mkdir(resolve(f.project, ".workspace", "deep"), { recursive: true });
    await writeFile(nestedSource, ledger("chat-A"));
    const initial = await f.service.view("chat-A", f.project);
    assert.equal(initial?.status, "ready");
    assert.equal(initial?.sourcePath, await realpath(nestedSource));

    const current = await bounded.view("chat-A", f.project);
    assert.equal(current?.status, "ready");
    assert.equal(current?.sourcePath, await realpath(nestedSource));
    assert.equal(current?.discoveryComplete, false);
    assert.deepEqual(current?.discoveryLimits, { maxFiles: 1, maxDepth: 0 });
    assert.equal((await bounded.taskProjection("chat-A", f.project)).status, "ready");
    const page = await bounded.history("chat-A", f.project);
    assert.equal(page.sourcePath, await realpath(nestedSource));
    assert.equal(page.total, 1);
  } finally {
    bounded.close();
    await f.close();
  }
});

test("project kitPath accepts either the Kit root directory or exact API module", async () => {
  const f = await fixture();
  const services: HeartbeatService[] = [];
  try {
    const modulePath = resolve(
      f.project,
      ".vibe-coding/kit/src/supervision/heartbeat-ledger-api.mjs",
    );
    await mkdir(resolve(f.project, ".vibe-coding/kit/src/supervision"), { recursive: true });
    await writeFile(modulePath, await readFile(f.kitPath, "utf8"));
    await writeFile(f.source, ledger("chat-A"));
    for (const kitPath of [
      ".vibe-coding/kit",
      ".vibe-coding/kit/src/supervision/heartbeat-ledger-api.mjs",
    ]) {
      await writeFile(
        resolve(f.project, ".codex-task-progress.json"),
        JSON.stringify({ heartbeat: { kitPath } }),
      );
      const service = new HeartbeatService(resolve(f.root, `data-${services.length}`), {
        fallbackKitPath: null,
        refreshMs: 0,
      });
      services.push(service);
      const view = await service.view("chat-A", f.project);
      assert.equal(view?.status, "ready");
      assert.equal(view.certifiesCurrent, true);
    }
  } finally {
    for (const service of services) service.close();
    await f.close();
  }
});

test("heartbeat-named Items-only inventory is readable without an invented wake", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.source,
      ledger("chat-A").replace(/^## .+wake .+\ncontract: heartbeat\/v2\n/m, ""),
    );
    const view = await f.service.view("chat-A", f.project);
    assert.equal(view?.status, "ready");
    assert.equal(view?.items.length, 1);
    assert.equal(view?.wakes.length, 0);
    assert.equal(view?.lastWakeAt, null);
    assert.equal(view?.certifiesCurrent, false);
  } finally {
    await f.close();
  }
});

test("bounded discovery prioritizes workspace ledgers over large unrelated directories", async () => {
  const f = await fixture();
  let bounded: HeartbeatService | undefined;
  try {
    await mkdir(resolve(f.project, ".a-cache"));
    for (let i = 0; i < 20; i++)
      await writeFile(resolve(f.project, ".a-cache", `${i}.txt`), "unrelated");
    await mkdir(resolve(f.project, ".workspace"));
    const workspaceSource = resolve(f.project, ".workspace/heartbeat.md");
    await writeFile(workspaceSource, ledger("chat-A"));
    bounded = new HeartbeatService(resolve(f.root, "bounded"), {
      kitPath: f.kitPath,
      refreshMs: 0,
      maxFiles: 10,
    });
    const view = await bounded.view("chat-A", f.project);
    assert.equal(view?.status, "ready");
    assert.equal(view?.sourcePath, await realpath(workspaceSource));
  } finally {
    bounded?.close();
    await f.close();
  }
});

test("documentation markers and fenced heartbeat examples do not become ledger candidates", async () => {
  const f = await fixture();
  try {
    await writeFile(
      resolve(f.project, "SKILL.md"),
      "# Policy\nUse contract: heartbeat/v2 when recording an audit.\n",
    );
    await writeFile(
      resolve(f.project, "ledger-api.md"),
      "# API\ncontract: heartbeat/v2\n## not-a-time wake (10-row ledger)\n",
    );
    await writeFile(
      resolve(f.project, "heartbeat-guide.md"),
      `# Example\n\`\`\`markdown\n${ledger("chat-A")}\n\`\`\`\n`,
    );
    assert.equal(await f.service.view("chat-A", f.project), null);
    await writeFile(f.source, ledger("chat-A", true));
    assert.equal((await f.service.view("chat-A", f.project))?.sourcePath, f.source);
  } finally {
    await f.close();
  }
});

test("large canonical reports stay below IPC budget and all wakes are paged without raw section text", async () => {
  const f = await fixture();
  let service: HeartbeatService | undefined;
  try {
    const hugeKit = resolve(f.root, "large-kit.mjs");
    await writeFile(
      hugeKit,
      `export function inspectHeartbeatLedger(text,{mode}) {
      const repeated = '审计状态'.repeat(3000);
      const count = text.includes('new wake appended') ? 81 : 80;
      return {mode,certifiesCurrent:true,passed:true,
        wakes:Array.from({length:count},(_,i)=>({heading:'wake-'+i,timeMs:1794391200000+i*1000,line:i+1,sectionLines:[repeated],rows:Array.from({length:10},(_,r)=>({num:r+1,category:repeated,state:repeated,line:r+1}))})),
        items:Array.from({length:1000},(_,i)=>({id:'I'+i,item:repeated,status:i%2?'blocked ← reason':'done',evidence:repeated,customSecretText:repeated,line:i+1})),
        findings:Array.from({length:500},()=>({severity:'error',message:repeated,rule:repeated}))};
    }`,
    );
    await writeFile(f.source, ledger("chat-A"));
    service = new HeartbeatService(resolve(f.root, "large-data"), {
      kitPath: hugeKit,
      refreshMs: 0,
    });
    const view = await service.view("chat-A", f.project);
    assert.equal(view?.status, "ready");
    const invalidItemsProjection = await service.taskProjection("chat-A", f.project);
    assert.equal(invalidItemsProjection.status, "error");
    assert.match(
      invalidItemsProjection.error ?? "",
      /Cannot project invalid heartbeat Items report/,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(view)) < 256 * 1024);
    assert.equal(view.itemCount, 1000);
    assert.equal(view.wakeCount, 80);
    assert.equal(view.itemStatusCounts.blocked, 500);
    assert.equal(view.itemStatusCounts.done, 500);
    assert.equal(view.itemsTruncated, true);
    assert.equal(view.wakesTruncated, true);
    assert.ok(view.items.length <= 20);
    assert.ok(view.wakes.length <= 5);
    assert.equal(view.wakes[0]?.sectionLines, undefined);
    assert.equal(view.items[0]?.customSecretText, undefined);
    const first = await service.history("chat-A", f.project, { limit: 5 });
    assert.equal(first.error, undefined);
    assert.equal(first.total, 80);
    assert.equal(first.wakes[0]?.heading, "wake-79");
    assert.ok(first.nextCursor);
    await writeFile(f.source, `${ledger("chat-A")}\nnew wake appended`);
    const second = await service.history("chat-A", f.project, {
      cursor: first.nextCursor,
      limit: 5,
    });
    assert.equal(second.wakes[0]?.heading, "wake-74");
    assert.equal(second.total, 81);
    assert.ok(Buffer.byteLength(JSON.stringify(second)) < 256 * 1024);
    const seen = new Set(first.wakes.map((wake) => wake.heading));
    let cursor: string | null = first.nextCursor;
    while (cursor !== null) {
      const page = await service.history("chat-A", f.project, { cursor, limit: 10 });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024);
      for (const wake of page.wakes) {
        assert.ok(!seen.has(wake.heading));
        seen.add(wake.heading);
      }
      cursor = page.nextCursor;
    }
    assert.equal(seen.size, 80);
    await assert.rejects(service.history("chat-A", f.project, { cursor: "wrong" }), /cursor/);
    await assert.rejects(service.history("chat-A", f.project, { limit: 100 }), /limit/);
  } finally {
    service?.close();
    await f.close();
  }
});
