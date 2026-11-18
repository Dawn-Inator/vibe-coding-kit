import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendHeartbeatWake,
  migrateHeartbeatLedgerPair,
  readHeartbeatLedgerPair,
} from "vibe-coding-kit/src/supervision/heartbeat-ledger-files.mjs";
import {
  discoverHeartbeatLedgerSources,
  HEARTBEAT_BOUND_MAX_BYTES,
  HeartbeatDiscoveryIndex,
  HeartbeatDiscoveryInvalidatedError,
} from "vibe-coding-kit/src/tasks/heartbeat-task-source.mjs";
import { HeartbeatProjectViewCache, HeartbeatService, type HeartbeatView } from "./heartbeat.js";

const PINNED_KIT_HEARTBEAT_API = fileURLToPath(
  import.meta.resolve("vibe-coding-kit/src/supervision/heartbeat-ledger-api.mjs"),
);

const ledger = (thread = "", legacy = false) =>
  `# Supervision\nthread: ${thread}\n## 2026-11-11T10:00:00Z wake (${legacy ? 8 : 10}-row ledger)\n${legacy ? "" : "contract: heartbeat/v2"}\n## Items\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| A | request | test | blocked | waiting |\n`;
const threadKey = (thread: string) => createHash("sha256").update(thread).digest("hex");

test("project heartbeat carries Kit orchestration projections without changing ledger bytes", async () => {
  const f = await fixture();
  const service = new HeartbeatService(resolve(f.root, "orchestration-data"), {
    kitPath: PINNED_KIT_HEARTBEAT_API,
    fallbackKitPath: null,
    refreshMs: 0,
  });
  try {
    const wake = (hour: string) =>
      [
        `## 2026-11-11T${hour}:00:00Z wake (10-row ledger)`,
        "contract: heartbeat/v2",
        "| # | category | state |",
        "| --- | --- | --- |",
        ...Array.from({ length: 10 }, (_, i) => `| ${i + 1} | audit | done |`),
        "",
      ].join("\n");
    const invalidWake = wake("08").replace("\n", "\norchestration: {invalid}\n");
    const legacy = `# Supervision\n\n${invalidWake}\n${wake("09")}\n## Items\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| A | request | example | blocked | waiting |\n`;
    await writeFile(f.source, legacy);
    const root = await realpath(f.project);
    const path = await realpath(f.source);
    let pair = migrateHeartbeatLedgerPair({
      root,
      path,
      legacyWritersQuiescent: true,
      expectedContentHash: readHeartbeatLedgerPair({ root, path }).contentHash,
    });
    const observation = (activeAgents: number) => ({
      activeAgents,
      observedAt: "2026-11-11T10:00:00Z",
      evidence: "agent snapshot",
    });
    const snapshots = [
      {
        scope: "session",
        before: observation(2),
        after: observation(4),
        blockedTasks: [],
        blockersEvidence: "checked",
      },
      {
        scope: "session",
        before: observation(0),
        after: null,
        blockedTasks: null,
        blockersEvidence: null,
      },
      ...[false, null].map((requiresOwner) => ({
        scope: "session",
        before: null,
        after: null,
        blockedTasks: [{ id: "B", title: "Task", reason: "waiting", requiresOwner }],
        blockersEvidence: "reviewed",
      })),
      {
        scope: "session",
        before: null,
        after: observation(0),
        blockedTasks: Array.from({ length: 30 }, (_, i) => ({
          id: `B${i}`,
          title: `Task ${i} ${"项".repeat(500)}`,
          reason: "等".repeat(2000),
          requiresOwner: i === 29 ? true : i === 28 ? null : false,
        })),
        blockersEvidence: "reviewed",
      },
    ];
    for (const [index, orchestration] of snapshots.entries()) {
      pair = appendHeartbeatWake({
        root,
        path,
        legacyWritersQuiescent: true,
        expectedContentHash: pair.contentHash,
        wakeText: wake(String(10 + index)),
        orchestration,
      });
    }
    const headBefore = await readFile(path);
    const historyBefore = await readFile(pair.historyPath);
    assert.ok(historyBefore.includes(Buffer.from(wake("09").trim())));
    const view = await service.projectView(f.project);
    const page = await service.projectHistory(f.project, { limit: 10 });
    assert.equal(view.status, "ready");
    assert.equal(page.wakes.length, 7);
    assert.deepEqual(view.wakes.at(-1)?.orchestration, page.wakes[0]?.orchestration);
    const latest = page.wakes[0]?.orchestration as Record<string, unknown>;
    assert.equal(latest.scope, "session");
    assert.equal((latest.after as { activeAgents: number }).activeAgents, 0);
    assert.equal(latest.before, null);
    assert.equal(latest.blockedTaskCount, 30);
    assert.equal(latest.ownerInterventionCount, 1);
    assert.equal(latest.requiresOwner, true);
    const preview = latest.blockedTasks as { id: string; requiresOwner: boolean | null }[];
    assert.ok(preview.length >= 3 && preview.length < 20);
    assert.equal(preview[0]?.id, "B29");
    assert.equal(preview[0]?.requiresOwner, true);
    assert.equal(latest.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 192 * 1024);
    assert.equal(
      (page.wakes[1]?.orchestration as Record<string, unknown> | undefined)?.requiresOwner,
      null,
    );
    assert.equal(
      (page.wakes[2]?.orchestration as Record<string, unknown> | undefined)?.requiresOwner,
      false,
    );
    const unknown = page.wakes[3]?.orchestration as Record<string, unknown>;
    assert.equal((unknown.before as { activeAgents: number }).activeAgents, 0);
    assert.equal(unknown.after, null);
    assert.equal(unknown.blockedTaskCount, null);
    assert.equal(unknown.requiresOwner, null);
    const first = page.wakes[4]?.orchestration as Record<string, unknown>;
    assert.equal((first.before as { activeAgents: number }).activeAgents, 2);
    assert.equal((first.after as { activeAgents: number }).activeAgents, 4);
    assert.equal(first.blockedTaskCount, 0);
    assert.equal(first.requiresOwner, false);
    assert.equal(page.wakes[5]?.orchestration, undefined);
    assert.equal(page.wakes[5]?.orchestrationError, undefined);
    assert.equal(page.wakes[6]?.orchestration, undefined);
    assert.match(String(page.wakes[6]?.orchestrationError), /invalid/i);
    assert.ok(!JSON.stringify(page.wakes[6]).includes("{invalid}"));
    assert.deepEqual(await readFile(path), headBefore);
    assert.deepEqual(await readFile(pair.historyPath), historyBefore);
  } finally {
    service.close();
    await f.close();
  }
});
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

test("project summaries share only within matching root and config scope, dedupe refreshes, and expire", async () => {
  const f = await fixture();
  const shared = new HeartbeatProjectViewCache();
  let clock = 1_000;
  const now = () => new Date(clock);
  const options = {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 60_000,
    now,
    projectViewCache: shared,
  };
  const first = new HeartbeatService(resolve(f.root, "thread-a"), options);
  const second = new HeartbeatService(resolve(f.root, "thread-b"), options);
  const differentConfig = new HeartbeatService(resolve(f.root, "thread-c"), {
    ...options,
    maxFiles: 1,
  });
  try {
    const [initialA, initialB] = await Promise.all([
      first.projectView(f.project),
      second.projectView(f.project),
    ]);
    assert.strictEqual(initialA, initialB);
    assert.equal(initialA.status, "none");

    await writeFile(f.source, ledger("another-chat"));
    clock += 1_000;
    assert.strictEqual(await second.projectView(f.project), initialA);

    // Different effective discovery bounds must not inherit another service's cached view.
    const bounded = await differentConfig.projectView(f.project);
    assert.notStrictEqual(bounded, initialA);
    assert.equal(bounded.discoveryLimits?.maxFiles, 1);

    const secondProject = resolve(f.root, "second-project");
    await mkdir(resolve(secondProject, ".git"), { recursive: true });
    const secondLedger = resolve(secondProject, "heartbeat.md");
    await writeFile(secondLedger, ledger("other-project-chat"));
    const isolated = await second.projectView(secondProject);
    assert.equal(isolated.sourcePath, await realpath(secondLedger));
    assert.notEqual(isolated.sourcePath, await realpath(f.source));

    clock += 61_000;
    const refreshed = await second.projectView(f.project);
    assert.notStrictEqual(refreshed, initialA);
    assert.equal(refreshed.sourcePath, await realpath(f.source));
    assert.equal(refreshed.status, "ready");
  } finally {
    first.close();
    second.close();
    differentConfig.close();
    shared.clear();
    await f.close();
  }
});

test("expired project snapshots retain only the matching scoped summary while refreshing", async () => {
  const f = await fixture();
  const shared = new HeartbeatProjectViewCache();
  let clock = 1_000;
  const now = () => new Date(clock);
  const service = new HeartbeatService(resolve(f.root, "snapshot-data"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 100,
    now,
    projectViewCache: shared,
  });
  const otherScope = new HeartbeatService(resolve(f.root, "other-scope"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 100,
    now,
    maxFiles: 1,
    projectViewCache: shared,
  });
  try {
    await writeFile(f.source, ledger("chat"));
    const cold = await service.projectViewSnapshot(f.project);
    assert.equal(cold.view, null);
    assert.equal(cold.pending, true);
    const initial = await service.projectView(f.project);
    assert.equal(initial.status, "ready");
    clock += 101;
    const stale = await service.projectViewSnapshot(f.project);
    assert.equal(stale.pending, true);
    assert.equal(stale.view?.sourcePath, initial.sourcePath);
    assert.equal(stale.view?.certifiesCurrent, false);
    const isolated = await otherScope.projectViewSnapshot(f.project);
    assert.equal(isolated.view, null);
    assert.equal(isolated.pending, true);
    await Promise.all([service.projectView(f.project), otherScope.projectView(f.project)]);
    assert.equal((await service.projectViewSnapshot(f.project)).pending, false);
  } finally {
    service.close();
    otherScope.close();
    shared.close();
    await f.close();
  }
});

test("a slow project read starts its cache lifetime on completion", async () => {
  const f = await fixture();
  let calls = 0;
  const now = () => new Date(++calls === 1 ? 1_000 : 61_000);
  const service = new HeartbeatService(resolve(f.root, "slow-read-data"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 30_000,
    now,
  });
  try {
    await writeFile(f.source, ledger("chat"));
    const view = await service.projectView(f.project);
    assert.equal(view.refreshedAt, new Date(1_000).toISOString());
    const snapshot = await service.projectViewSnapshot(f.project);
    assert.equal(snapshot.pending, false);
    assert.strictEqual(snapshot.view, view);
    assert.strictEqual(await service.projectView(f.project), view);
  } finally {
    service.close();
    await f.close();
  }
});

test("a slow thread read starts its cache lifetime on completion", async () => {
  const f = await fixture();
  let calls = 0;
  const now = () => new Date(++calls === 1 ? 1_000 : 61_000);
  const service = new HeartbeatService(resolve(f.root, "slow-thread-data"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 30_000,
    now,
  });
  try {
    await writeFile(f.source, ledger("other-chat"));
    const view = await service.view("chat", f.project);
    assert.equal(view?.status, "candidates");
    assert.strictEqual(await service.view("chat", f.project), view);
  } finally {
    service.close();
    await f.close();
  }
});

test("project summary retains its selected pair while discovery index is invalidated", async () => {
  const f = await fixture();
  let onChange: ((event: string, filename: string) => void) | undefined;
  const watcher = Object.assign(new EventEmitter(), { close() {} });
  const index = new HeartbeatDiscoveryIndex({
    watchFactory: ((_root: unknown, _options: unknown, callback: typeof onChange) => {
      onChange = callback;
      return watcher;
    }) as unknown as typeof import("node:fs").watch,
  });
  const service = new HeartbeatService(resolve(f.root, "history-stable"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 60_000,
    discoveryIndex: index,
  });
  try {
    await writeFile(f.source, ledger("chat"));
    const original = await service.projectView(f.project);
    assert.equal(original.status, "ready");
    await writeFile(f.source, ledger("different"));
    onChange?.("change", "heartbeat.md");
    const same = await service.projectView(f.project);
    assert.strictEqual(same, original);
    assert.equal(same.contentHash, original.contentHash);
  } finally {
    service.close();
    index.close();
    await f.close();
  }
});

test("two services share an indexed discovery while retaining exact thread associations", async () => {
  const f = await fixture();
  let scans = 0;
  const watcher = Object.assign(new EventEmitter(), { close() {} });
  const index = new HeartbeatDiscoveryIndex({
    watchFactory: (() => watcher) as unknown as typeof import("node:fs").watch,
    scanFactory: async (options) => {
      scans += 1;
      return discoverHeartbeatLedgerSources(options);
    },
  });
  const first = new HeartbeatService(resolve(f.root, "first-index"), {
    kitPath: f.kitPath,
    discoveryIndex: index,
  });
  const second = new HeartbeatService(resolve(f.root, "second-index"), {
    kitPath: f.kitPath,
    discoveryIndex: index,
  });
  try {
    await writeFile(f.source, ledger("chat-A"));
    const [a, b] = await Promise.all([
      first.view("chat-A", f.project),
      second.view("chat-B", f.project),
    ]);
    assert.equal(a?.status, "ready");
    assert.equal(b?.status, "candidates");
    assert.equal(scans, 1);
  } finally {
    first.close();
    second.close();
    index.close();
    await f.close();
  }
});

test("forced projection refreshes a cached negative even before watcher delivery", async () => {
  const f = await fixture();
  const watcher = Object.assign(new EventEmitter(), { close() {} });
  const index = new HeartbeatDiscoveryIndex({
    watchFactory: (() => watcher) as unknown as typeof import("node:fs").watch,
  });
  const service = new HeartbeatService(resolve(f.root, "forced-authority"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 60_000,
    discoveryIndex: index,
  });
  try {
    assert.equal((await service.taskProjection("chat-A", f.project)).status, "none");
    await writeFile(f.source, ledger("chat-A"));
    const refreshed = await service.taskProjection("chat-A", f.project, { forceDiscovery: true });
    assert.equal(refreshed.sourcePath, await realpath(f.source));
    assert.equal(refreshed.status, "ready");
  } finally {
    service.close();
    index.close();
    await f.close();
  }
});

test("failed project refresh stays visible without becoming a successful cache hit, then retry recovers", async () => {
  const f = await fixture();
  const shared = new HeartbeatProjectViewCache();
  const service = new HeartbeatService(resolve(f.root, "failure-data"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    projectViewCache: shared,
  });
  const configPath = resolve(f.project, ".codex-task-progress.json");
  try {
    await writeFile(configPath, "{invalid-json");
    const initial = await service.projectViewSnapshot(f.project);
    assert.equal(initial.view, null);
    assert.equal(initial.pending, true);

    const failedRefresh = await service.projectView(f.project);
    assert.equal(failedRefresh.status, "error");
    assert.match(failedRefresh.error ?? "", /Cannot read \.codex-task-progress\.json/i);
    const failedSnapshot = await service.projectViewSnapshot(f.project);
    assert.equal(failedSnapshot.view?.status, "error");
    assert.match(failedSnapshot.view?.error ?? "", /Cannot read \.codex-task-progress\.json/i);
    assert.equal(failedSnapshot.pending, true);

    await rm(configPath);
    await service.projectView(f.project);
    const recovered = await service.projectViewSnapshot(f.project);
    assert.equal(recovered.view?.status, "none");
    assert.equal(recovered.pending, false);
  } finally {
    service.close();
    shared.close();
    await f.close();
  }
});

test("project invalidation epochs reject late reads and preserve newer in-flight ownership", async () => {
  const cache = new HeartbeatProjectViewCache();
  const root = "/tmp/heartbeat-epoch-project";
  const key = `${root}\0scope`;
  const makeView = (status: HeartbeatView["status"], refreshedAt: string): HeartbeatView => ({
    status,
    sourcePath: null,
    candidates: [],
    refreshedAt,
    modifiedAt: null,
    lastWakeAt: null,
    nextWakeAt: null,
    cadenceMinutes: null,
    certifiesCurrent: false,
    passed: false,
    items: [],
    wakes: [],
    findings: [],
    itemCount: 0,
    wakeCount: 0,
    itemStatusCounts: {},
    itemsTruncated: false,
    wakesTruncated: false,
  });
  const oldOwner = {};
  const newOwner = {};
  const resolvers: { old?: (view: HeartbeatView) => void; new?: (view: HeartbeatView) => void } =
    {};
  const oldRead = new Promise<HeartbeatView>((resolve) => {
    resolvers.old = resolve;
  });
  const newRead = new Promise<HeartbeatView>((resolve) => {
    resolvers.new = resolve;
  });
  const oldEpoch = cache.epoch(root);
  cache.setPending(key, root, oldEpoch, oldOwner, oldRead);
  cache.invalidateProject(root);
  const newEpoch = cache.epoch(root);
  cache.setPending(key, root, newEpoch, newOwner, newRead);

  const oldFailure = makeView("error", "old-read");
  resolvers.old?.(oldFailure);
  await oldRead;
  cache.setFailure(key, root, oldEpoch, oldFailure);
  cache.setValue(key, root, oldEpoch, {
    time: Date.now(),
    value: makeView("ready", "stale-old-read"),
  });
  cache.clearPendingIfOwner(key, oldOwner);
  assert.equal(cache.failure(key), undefined);
  assert.equal(cache.get(key), undefined);
  assert.strictEqual(cache.pending(key, root, newEpoch), newRead);

  const newView = makeView("ready", "new-read");
  resolvers.new?.(newView);
  await newRead;
  cache.setValue(key, root, newEpoch, { time: Date.now(), value: newView });
  cache.clearPendingIfOwner(key, newOwner);
  assert.strictEqual(cache.get(key)?.value, newView);

  cache.close();
  cache.setValue(key, root, newEpoch, { time: Date.now(), value: oldFailure });
  assert.equal(cache.get(key), undefined);
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

    const originalHistory = await readFile(pair.historyPath);
    await truncate(pair.historyPath, HEARTBEAT_BOUND_MAX_BYTES + 1);
    const oversized = await service.projectHistory(f.project, { limit: 1 });
    assert.equal(oversized.sourcePath, canonicalSource);
    assert.equal(oversized.total, 0);
    assert.deepEqual(oversized.wakes, []);
    assert.match(oversized.error ?? "", /limit|size|exceed|bytes/i);
    await writeFile(pair.historyPath, originalHistory);

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
    assert.equal(view?.certifiesCurrent, false);
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

test("fresh projects use bundled inspection without probing a developer checkout", async () => {
  const f = await fixture();
  const service = new HeartbeatService(resolve(f.root, "bundled-inspection"), { refreshMs: 0 });
  const developerRoot = resolve(homedir(), "Workspace/Project/vibe-coding-kit");
  const originalStat = fs.promises.stat;
  const probes: string[] = [];
  try {
    await writeFile(f.source, ledger("chat-A"));
    fs.promises.stat = (async (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith(developerRoot)) probes.push(args[0]);
      return Reflect.apply(originalStat, fs.promises, args);
    }) as typeof originalStat;
    syncBuiltinESMExports();
    const view = await service.view("chat-A", f.project);
    assert.equal(view?.status, "ready");
    assert.equal(view?.items[0]?.item, "test");
    assert.deepEqual(probes, []);
  } finally {
    fs.promises.stat = originalStat;
    syncBuiltinESMExports();
    service.close();
    await f.close();
  }
});

test("project-configured and explicit fallback inspectors retain priority over the bundle", async () => {
  const f = await fixture();
  const project = new HeartbeatService(resolve(f.root, "project-inspection"), { refreshMs: 0 });
  const fallback = new HeartbeatService(resolve(f.root, "fallback-inspection"), {
    fallbackKitPath: f.kitPath,
    refreshMs: 0,
  });
  const pinned = new HeartbeatService(resolve(f.root, "pinned-project-inspection"), {
    refreshMs: 0,
  });
  try {
    await writeFile(f.source, ledger("chat-A"));
    await writeFile(
      resolve(f.project, ".codex-task-progress.json"),
      JSON.stringify({ heartbeat: { kitPath: f.kitPath } }),
    );
    const selected = await project.view("chat-A", f.project);
    assert.equal(selected?.status, "ready");
    assert.equal(selected?.items[0]?.item, "test item");
    await rm(resolve(f.project, ".codex-task-progress.json"));
    const explicit = await fallback.view("chat-A", f.project);
    assert.equal(explicit?.status, "ready");
    assert.equal(explicit?.items[0]?.item, "test item");
    const pinnedPath = resolve(
      f.project,
      ".vibe-coding/kit/src/supervision/heartbeat-ledger-api.mjs",
    );
    await mkdir(resolve(pinnedPath, ".."), { recursive: true });
    await writeFile(pinnedPath, await readFile(f.kitPath, "utf8"));
    const pinnedView = await pinned.view("chat-A", f.project);
    assert.equal(pinnedView?.status, "ready");
    assert.equal(pinnedView?.items[0]?.item, "test item");
  } finally {
    project.close();
    fallback.close();
    pinned.close();
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
      /cannot be resolved|within the project root/,
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

test("bound read-only views inspect only their source; forced projection scans the project", async () => {
  const f = await fixture();
  const service = new HeartbeatService(resolve(f.root, "bound-only-data"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 0,
  });
  const originalReadDir = fs.promises.readdir;
  const root = await realpath(f.project);
  let scans = 0;
  try {
    await writeFile(f.source, ledger("chat-A"));
    assert.equal((await service.view("chat-A", f.project))?.status, "ready");
    fs.promises.readdir = (async (...args: unknown[]) => {
      if (typeof args[0] === "string" && (args[0] === root || args[0].startsWith(`${root}/`)))
        scans += 1;
      return Reflect.apply(originalReadDir, fs.promises, args);
    }) as typeof originalReadDir;
    syncBuiltinESMExports();
    const bound = await service.view("chat-A", f.project);
    assert.equal(bound?.status, "ready");
    assert.equal(bound?.sourcePath, f.source);
    assert.equal(bound?.discoveryComplete, false);
    assert.deepEqual(bound?.discoveryReasons, ["source-only"]);
    assert.equal((await service.taskProjection("chat-A", f.project)).status, "ready");
    assert.equal(scans, 0);
    assert.equal(
      (await service.taskProjection("chat-A", f.project, { forceDiscovery: true })).status,
      "ready",
    );
    assert.ok(scans > 0);
    await writeFile(f.source, ledger("another-chat"));
    const lost = await service.taskProjection("chat-A", f.project);
    assert.equal(lost.status, "stale");
    assert.equal(lost.sourcePath, f.source);
    assert.equal(lost.task, null);
    await rm(f.source);
    const missing = await service.taskProjection("chat-A", f.project);
    assert.equal(missing.status, "stale");
    assert.equal(missing.sourcePath, f.source);
    assert.equal(missing.task, null);
  } finally {
    fs.promises.readdir = originalReadDir;
    syncBuiltinESMExports();
    service.close();
    await f.close();
  }
});

test("unrelated project changes during bound reads do not repeat source audits", async () => {
  const f = await fixture();
  let notify: ((_event: string, filename: string) => void) | undefined;
  const watcher = Object.assign(new EventEmitter(), { close() {} });
  const index = new HeartbeatDiscoveryIndex({
    watchFactory: ((_root: unknown, _options: unknown, callback: typeof notify) => {
      notify = callback;
      return watcher;
    }) as unknown as typeof import("node:fs").watch,
  });
  const service = new HeartbeatService(resolve(f.root, "data"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 0,
    discoveryIndex: index,
  });
  const hookTarget = globalThis as typeof globalThis & { __boundAuditHook?: () => void };
  try {
    const inspector = (await readFile(f.kitPath, "utf8")).replace(
      "export function inspectHeartbeatLedger(text, {mode}) {",
      "export function inspectHeartbeatLedger(text, {mode}) { globalThis.__boundAuditHook?.();",
    );
    assert.match(inspector, /__boundAuditHook/);
    await writeFile(f.kitPath, inspector);
    await writeFile(f.source, ledger("chat-A"));
    assert.equal((await f.service.view("chat-A", f.project))?.status, "ready");
    await index.discover({ root: f.project });
    assert.ok(notify);
    let audits = 0;
    hookTarget.__boundAuditHook = () => {
      audits += 1;
    };
    const baseline = await service.taskProjection("chat-A", f.project);
    const baselineAudits = audits;
    assert.equal(baseline.status, "ready");
    assert.ok(baselineAudits > 0);
    audits = 0;
    hookTarget.__boundAuditHook = () => {
      audits += 1;
      fs.writeFileSync(resolve(f.project, "unrelated.md"), `unrelated ${audits}\n`);
      notify?.("change", "unrelated.md");
    };
    const underChanges = await service.taskProjection("chat-A", f.project);
    assert.equal(underChanges.status, "ready");
    assert.equal(underChanges.sourcePath, baseline.sourcePath);
    assert.equal(underChanges.contentHash, baseline.contentHash);
    assert.equal(audits, baselineAudits);
  } finally {
    delete hookTarget.__boundAuditHook;
    service.close();
    index.close();
    await f.close();
  }
});

test("source changes during a bound audit cannot publish an old cached hash", async () => {
  const f = await fixture();
  const service = new HeartbeatService(resolve(f.root, "data"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 60_000,
  });
  const hookTarget = globalThis as typeof globalThis & { __boundAuditHook?: () => void };
  try {
    const inspector = (await readFile(f.kitPath, "utf8")).replace(
      "export function inspectHeartbeatLedger(text, {mode}) {",
      "export function inspectHeartbeatLedger(text, {mode}) { globalThis.__boundAuditHook?.();",
    );
    await writeFile(f.kitPath, inspector);
    await writeFile(f.source, ledger("chat-A"));
    assert.equal((await f.service.view("chat-A", f.project))?.status, "ready");
    const old = readHeartbeatLedgerPair({
      root: await realpath(f.project),
      path: f.source,
      maxBytes: 8 * 1024 * 1024,
    }).contentHash;
    let changed = false;
    hookTarget.__boundAuditHook = () => {
      if (!changed) {
        changed = true;
        fs.writeFileSync(f.source, `${ledger("chat-A")}\nchanged during audit\n`);
      }
    };
    const during = await service.taskProjection("chat-A", f.project);
    assert.equal(changed, true);
    assert.notEqual(during.contentHash, old, "a changed snapshot must not be projected as current");
    const result = await service.taskProjection("chat-A", f.project);
    assert.equal(result.status, "ready", result.error);
    assert.notEqual(result.contentHash, old);
    assert.equal(
      result.contentHash,
      readHeartbeatLedgerPair({
        root: await realpath(f.project),
        path: f.source,
        maxBytes: 8 * 1024 * 1024,
      }).contentHash,
    );
    assert.equal(
      (await service.taskProjection("chat-A", f.project)).contentHash,
      result.contentHash,
    );
  } finally {
    delete hookTarget.__boundAuditHook;
    service.close();
    await f.close();
  }
});

test("warm bound cache revalidates source hash and newly introduced Git boundaries", async () => {
  const f = await fixture();
  const nested = resolve(await realpath(f.project), "cache-bound");
  const source = resolve(nested, "heartbeat.md");
  const service = new HeartbeatService(resolve(f.root, "warm-bound-data"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 60_000,
  });
  try {
    await mkdir(nested);
    await writeFile(source, ledger("chat-A"));
    assert.equal((await service.view("chat-A", f.project))?.status, "ready");
    assert.equal((await service.view("chat-A", f.project))?.discoveryComplete, false);
    const prior = await service.taskProjection("chat-A", f.project);
    await writeFile(source, `${ledger("chat-A")}\nchanged same source\n`);
    const changed = await service.taskProjection("chat-A", f.project);
    assert.equal(changed.status, "ready");
    assert.notEqual(changed.contentHash, prior.contentHash);
    assert.equal(
      changed.contentHash,
      readHeartbeatLedgerPair({
        root: await realpath(f.project),
        path: source,
        maxBytes: 8 * 1024 * 1024,
      }).contentHash,
    );
    await writeFile(resolve(nested, ".git"), "gitdir: elsewhere\n");
    const rejected = await service.taskProjection("chat-A", f.project);
    assert.equal(rejected.status, "stale");
    assert.equal(rejected.sourcePath, source);
    assert.equal(rejected.task, null);
    await rm(resolve(nested, ".git"));
    assert.equal((await service.taskProjection("chat-A", f.project)).status, "ready");
    const outside = resolve(f.root, "outside-warm.md");
    await writeFile(outside, ledger("chat-A"));
    await rm(source);
    await symlink(outside, source);
    const escaped = await service.taskProjection("chat-A", f.project);
    assert.equal(escaped.status, "stale");
    assert.equal(escaped.sourcePath, source);
    assert.equal(escaped.task, null);
  } finally {
    service.close();
    await f.close();
  }
});

test("bound-only reads preserve invalid Items errors and the canonical content hash", async () => {
  const f = await fixture();
  const service = new HeartbeatService(resolve(f.root, "invalid-bound-data"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 0,
  });
  try {
    await writeFile(
      f.kitPath,
      `export function inspectHeartbeatLedger(text,{mode}) {
      return { mode, certifiesCurrent:false, passed:mode!=="items", wakes:[],
        items:[{id:"A",item:"test",status:"done",evidence:"ok",line:6}],
        findings:mode==="items"?[{severity:"error",rule:"invalid-item",message:"invalid item"}]:[] };
    }`,
    );
    await writeFile(f.source, ledger("chat-A"));
    const full = await service.taskProjection("chat-A", f.project, { forceDiscovery: true });
    const bound = await service.taskProjection("chat-A", f.project);
    assert.equal(full.status, "error");
    assert.equal(bound.status, "error");
    assert.equal(bound.sourcePath, f.source);
    assert.match(bound.error ?? "", /invalid-item.*invalid item/);
    assert.equal(bound.error, full.error);
    assert.ok(bound.contentHash);
    assert.equal(bound.contentHash, full.contentHash);
  } finally {
    service.close();
    await f.close();
  }
});

test("explicit manual bindings remain readable without thread metadata and reject changed boundaries", async () => {
  const f = await fixture();
  const nested = resolve(await realpath(f.project), "nested");
  const source = resolve(nested, "heartbeat.md");
  const service = new HeartbeatService(resolve(f.root, "manual-bound-data"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 0,
  });
  try {
    await mkdir(nested);
    await writeFile(source, ledger("unrelated-chat"));
    assert.equal((await service.bind("chat-A", source, f.project))?.status, "ready");
    const manual = await service.taskProjection("chat-A", f.project);
    assert.equal(manual.status, "ready");
    assert.equal(manual.sourcePath, source);
    await writeFile(resolve(nested, ".git"), "gitdir: elsewhere\n");
    const nestedResult = await service.taskProjection("chat-A", f.project);
    assert.equal(nestedResult.status, "stale");
    assert.equal(nestedResult.sourcePath, source);
    await rm(resolve(nested, ".git"));
    const external = resolve(f.root, "external.md");
    await writeFile(external, ledger("chat-A"));
    await rm(source);
    await symlink(external, source);
    const escaped = await service.taskProjection("chat-A", f.project);
    assert.equal(escaped.status, "stale");
    assert.equal(escaped.sourcePath, source);
    assert.equal(escaped.task, null);
  } finally {
    service.close();
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
      assert.equal(view.certifiesCurrent, false);
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
    const firstWakeTime = Date.parse("2026-11-11T10:00:00Z");
    const wakeText = Array.from(
      { length: 80 },
      (_, i) =>
        `## ${new Date(firstWakeTime + i * 60_000).toISOString()} wake (10-row ledger)\n| # | category | state |\n| --- | --- | --- |\n| 1 | audit | done |\n`,
    ).join("");
    await writeFile(
      f.source,
      `# Supervision\nthread: chat-A\n${wakeText}\n## Items\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| A | request | task | done | receipt |\n`,
    );
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
    assert.equal(first.wakes[0]?.timeMs, firstWakeTime + 79 * 60_000);
    assert.ok(first.nextCursor);
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
    await appendFile(f.source, "\nchanged\n");
    const stale = await service.history("chat-A", f.project, {
      cursor: first.nextCursor,
      limit: 5,
    });
    assert.equal(stale.retryable, true);
    assert.equal(stale.wakes.length, 0);
    await assert.rejects(service.history("chat-A", f.project, { cursor: "wrong" }), /cursor/);
    await assert.rejects(service.history("chat-A", f.project, { limit: 100 }), /limit/);
  } finally {
    service?.close();
    await f.close();
  }
});

test("discovery invalidation is retryable for task, history and project reads and recovers", async () => {
  const f = await fixture();
  const index = new HeartbeatDiscoveryIndex();
  const original = index.discover.bind(index);
  let invalidated = true;
  index.discover = async (...args) => {
    if (invalidated) throw new HeartbeatDiscoveryInvalidatedError();
    return original(...args);
  };
  const service = new HeartbeatService(resolve(f.root, "retry-data"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 0,
    discoveryIndex: index,
  });
  try {
    await writeFile(f.source, ledger("chat-A"));
    const projection = await service.taskProjection("chat-A", f.project);
    assert.equal(projection.status, "pending");
    assert.equal(projection.retryable, true);
    assert.equal(projection.task, null);
    const history = await service.history("chat-A", f.project);
    assert.equal(history.retryable, true);
    assert.equal(history.error, undefined);
    const project = await service.projectView(f.project);
    assert.equal(project.status, "pending");
    assert.equal(project.retryable, true);
    assert.equal((await service.projectHistory(f.project)).retryable, true);
    invalidated = false;
    assert.equal((await service.taskProjection("chat-A", f.project)).status, "ready");
    assert.equal((await service.projectView(f.project)).status, "ready");
  } finally {
    service.close();
    index.close();
    await f.close();
  }
});

test("concurrent reads join discovery before repeating root and generation checks", async () => {
  const f = await fixture();
  const index = new HeartbeatDiscoveryIndex();
  const discover = index.discover.bind(index);
  const generation = index.generation.bind(index);
  let checks = 0;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scanning = new Promise<void>((resolve) => {
    started = resolve;
  });
  index.generation = async (...args) => {
    checks++;
    return generation(...args);
  };
  index.discover = async (...args) => {
    started();
    await gate;
    return discover(...args);
  };
  const service = new HeartbeatService(resolve(f.root, "pending-dedup"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    discoveryIndex: index,
  });
  try {
    const first = service.view("chat-A", f.project);
    await scanning;
    const before = checks;
    const second = service.view("chat-A", f.project);
    await Promise.resolve();
    assert.equal(checks, before);
    release();
    assert.deepEqual(await first, await second);
  } finally {
    release();
    service.close();
    index.close();
    await f.close();
  }
});

test("ordinary discovery failures remain terminal rather than retryable", async () => {
  const f = await fixture();
  const index = new HeartbeatDiscoveryIndex();
  index.discover = async () => {
    throw new Error("permission denied");
  };
  const service = new HeartbeatService(resolve(f.root, "terminal-data"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 0,
    discoveryIndex: index,
  });
  try {
    const projection = await service.taskProjection("chat-A", f.project);
    assert.equal(projection.status, "error");
    assert.match(projection.error ?? "", /permission denied/);
    assert.equal(projection.retryable, undefined);
    const project = await service.projectView(f.project);
    assert.equal(project.status, "error");
    assert.match(project.error ?? "", /permission denied/);
    assert.equal(project.retryable, undefined);
  } finally {
    service.close();
    index.close();
    await f.close();
  }
});

test("project snapshot retains same-config verified view only for retryable invalidation", async () => {
  const f = await fixture();
  const index = new HeartbeatDiscoveryIndex();
  const original = index.discover.bind(index);
  let mode: "ready" | "pending" | "error" = "ready";
  index.discover = async (...args) => {
    if (mode === "pending") throw new HeartbeatDiscoveryInvalidatedError();
    if (mode === "error") throw new Error("permission denied");
    return original(...args);
  };
  let clock = 1000;
  const service = new HeartbeatService(resolve(f.root, "snapshot-retry"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 100,
    now: () => new Date(clock),
    discoveryIndex: index,
  });
  try {
    await writeFile(f.source, ledger("chat-A"));
    const initial = await service.projectView(f.project);
    assert.equal(initial.status, "ready");
    clock += 101;
    mode = "pending";
    assert.equal((await service.projectView(f.project)).status, "pending");
    const pending = await service.projectViewSnapshot(f.project);
    assert.equal(pending.pending, true);
    assert.equal(pending.view?.sourcePath, initial.sourcePath);
    assert.equal(pending.view?.status, "ready");
    assert.equal(pending.view?.certifiesCurrent, false);
    await service.projectView(f.project);
    mode = "error";
    assert.equal((await service.projectView(f.project)).status, "error");
    const failed = await service.projectViewSnapshot(f.project);
    assert.equal(failed.view?.status, "error");
    assert.match(failed.view?.error ?? "", /permission denied/);
    await service.projectView(f.project);
    mode = "ready";
    assert.equal((await service.projectView(f.project)).status, "ready");
    const recovered = await service.projectViewSnapshot(f.project);
    assert.equal(recovered.pending, false);
    assert.equal(recovered.view?.status, "ready");
    await writeFile(resolve(f.project, "other.md"), ledger("other-chat"));
    await writeFile(
      resolve(f.project, ".codex-task-progress.json"),
      JSON.stringify({ heartbeat: { ledgerPath: "other.md" } }),
    );
    mode = "pending";
    assert.equal((await service.projectView(f.project)).status, "pending");
    const changedConfig = await service.projectViewSnapshot(f.project);
    assert.notEqual(changedConfig.view?.sourcePath, initial.sourcePath);
  } finally {
    service.close();
    index.close();
    await f.close();
  }
});

test("explicit binding reads a large legacy ledger and its migrated pair without losing history", async () => {
  const f = await fixture();
  const service = new HeartbeatService(resolve(f.root, "large-data"), {
    kitPath: PINNED_KIT_HEARTBEAT_API,
    fallbackKitPath: null,
    refreshMs: 0,
  });
  try {
    const source = resolve(f.project, "deep/heartbeat-large.md");
    await mkdir(resolve(f.project, "deep"));
    const text = [
      "# Supervision",
      "## Items",
      "| id | source | item | status | evidence | children | owner | repository | worktree | mode | write_set | dispatch_ref |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| A | owner:request | test | done | verified | [] | - | - | - | - | - | - |",
      ...Array.from({ length: 9 * 1024 }, () => "x".repeat(1023)),
      "## 2026-11-11T09:00:00Z wake (10-row ledger)",
      "## 2026-11-11T10:00:00Z wake (10-row ledger)",
      "contract: heartbeat/v2",
      "| # | category | state |",
      "| --- | --- | --- |",
      ...Array.from({ length: 10 }, (_, i) => `| ${i + 1} | audit | done |`),
      "",
    ].join("\n");
    await writeFile(source, text);
    const automatic = await discoverHeartbeatLedgerSources({
      root: f.project,
      threadId: "large-chat",
    });
    assert.equal(automatic.complete, false);
    assert.ok(automatic.reasons.includes("oversized-file"));
    assert.equal((await service.bind("large-chat", source, f.project))?.status, "ready");
    const projection = await service.taskProjection("large-chat", f.project);
    assert.equal(projection.status, "ready", projection.error);
    const before = await service.history("large-chat", f.project);
    assert.equal(before.total, 2);
    assert.equal(before.error, undefined);
    const root = await realpath(f.project);
    const path = await realpath(source);
    const legacy = readHeartbeatLedgerPair({ root, path, maxBytes: HEARTBEAT_BOUND_MAX_BYTES });
    const migrated = migrateHeartbeatLedgerPair({
      root,
      path,
      legacyWritersQuiescent: true,
      expectedContentHash: legacy.contentHash,
    });
    assert.ok(Buffer.byteLength(migrated.historyText ?? "") > 8 * 1024 * 1024);
    assert.equal((await service.view("large-chat", f.project))?.status, "ready");
    assert.equal((await service.taskProjection("large-chat", f.project)).status, "ready");
    const after = await service.history("large-chat", f.project);
    assert.equal(after.total, before.total);
    assert.equal(after.error, undefined);
    assert.equal(after.wakes[0]?.heading, before.wakes[0]?.heading);
    const migratedHistoryBytes = await readFile(migrated.historyPath);
    await writeFile(
      resolve(root, ".codex-task-progress.json"),
      JSON.stringify({ heartbeat: { ledgerPath: path } }),
    );
    const projectView = await service.projectView(f.project);
    assert.equal(projectView.status, "ready", projectView.error ?? `status: ${projectView.status}`);
    assert.equal(projectView.sourcePath, path);
    const projectHistory = await service.projectHistory(f.project);
    assert.equal(projectHistory.error, undefined);
    assert.equal(projectHistory.total, before.total);
    assert.equal(projectHistory.historyPath, migrated.historyPath);
    assert.deepEqual(await readFile(migrated.historyPath), migratedHistoryBytes);
    await truncate(migrated.historyPath, HEARTBEAT_BOUND_MAX_BYTES + 1);
    await assert.rejects(
      service.bind("oversized-chat", path, f.project),
      /limit|exceed|bytes|integrity|format/i,
    );
    assert.equal((await service.view("oversized-chat", f.project))?.sourcePath, null);
  } finally {
    service.close();
    await f.close();
  }
});

test("task root metadata selects a bounded business subtree without changing source history", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.kitPath,
      `export function inspectHeartbeatLedger(text,{mode}) {
      const ids=Array.from({length:166},(_,i)=>'F'+i);
      return {mode,certifiesCurrent:true,passed:true,
        wakes:[{heading:'wake',timeMs:1794391200000,rows:[]}],
        items:[{id:'R1-BUSINESS',item:'Business features',status:'tracking',children:JSON.stringify(ids)},
          ...ids.map((id,i)=>({id,item:id,status:i<50?'done':'blocked',children:'[]'})),
          ...Array.from({length:100},(_,i)=>({id:'OPS'+i,item:'Operations',status:'done',children:'[]'}))],findings:[]};
    }`,
    );
    const source = `task_root: R1-BUSINESS\n${ledger("chat-A")}`;
    await writeFile(f.source, source);
    const before = await readFile(f.source, "utf8");
    const fullView = await f.service.bind("chat-A", f.source, f.project);
    assert.equal(fullView?.status, "ready");
    assert.equal(fullView?.itemCount, 267);
    const projection = await f.service.taskProjection("chat-A", f.project);
    assert.equal(projection.status, "ready", projection.error);
    assert.deepEqual(projection.task?.progress, { completed: 50, total: 166, percent: 30.12 });
    assert.equal(projection.task?.title, "Business features");
    assert.equal(projection.task?.source.itemStatusCount, 167);
    assert.equal(projection.task?.source.presentation.itemStatusesTruncated, true);
    assert.equal(projection.task?.source.itemStatuses.OPS0, undefined);
    const history = await f.service.history("chat-A", f.project);
    assert.equal(history.sourcePath, await realpath(f.source));
    assert.equal(history.historyPath, await realpath(f.source));
    assert.equal(history.total, 1);
    assert.equal(await readFile(f.source, "utf8"), before);
    const root = await realpath(f.project);
    const path = await realpath(f.source);
    const legacy = readHeartbeatLedgerPair({ root, path });
    const pair = migrateHeartbeatLedgerPair({
      root,
      path,
      legacyWritersQuiescent: true,
      expectedContentHash: legacy.contentHash,
    });
    const historyBytes = await readFile(pair.historyPath);
    const afterMigration = await f.service.taskProjection("chat-A", f.project);
    assert.deepEqual(afterMigration.task?.progress, { completed: 50, total: 166, percent: 30.12 });
    const pairHistory = await f.service.history("chat-A", f.project);
    assert.equal(pairHistory.historyPath, pair.historyPath);
    assert.equal(pairHistory.total, history.total);
    assert.deepEqual(await readFile(pair.historyPath), historyBytes);
    await writeFile(f.source, source.replace("task_root: R1-BUSINESS", "task_root:"));
    await rm(pair.historyPath);
    await rm(`${path}.legacy`);
    const invalid = await f.service.taskProjection("chat-A", f.project);
    assert.equal(invalid.status, "error");
    assert.match(invalid.error ?? "", /task_root/);
  } finally {
    await f.close();
  }
});

test("large verified pair supports project and bound displays, projection, binding and pagination", async () => {
  const f = await fixture();
  const service = new HeartbeatService(resolve(f.root, "large-display-data"), { refreshMs: 0 });
  try {
    const root = await realpath(f.project);
    const path = resolve(root, "heartbeat-big.md");
    const historyPath = resolve(root, "heartbeat-big.taskhistory.md");
    const backupPath = `${path}.legacy`;
    const marker = `<!-- heartbeat-head:v2 source=${encodeURIComponent(path)} history=${encodeURIComponent(historyPath)} -->\n`;
    const head = `${marker}# Supervision\nthread: large-chat\ntask_root: ROOT\n## Items\n| id | source | item | status | evidence | owner | repository | worktree | mode | write_set | dispatch_ref | children |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| ROOT | report:tracker | root | tracking | tracking plan | agent:tracker | repo-a | worktrees/tracker | read-only | [] | - | ["A"] |\n| A | report:leaf | task | done | verified | agent:leaf | repo-a | worktrees/leaf | read-only | [] | - | [] |\n`;
    const fillerLine = `${"x".repeat(4095)}\n`;
    const body = `${fillerLine.repeat(8193)}${Array.from({ length: 7 }, (_, i) => `## 2026-11-11T0${i}:00:00Z wake (10-row ledger)\nrow: ${i}\n`).join("")}`;
    const backup = "immutable legacy\n";
    const digest = (v: string) => createHash("sha256").update(v).digest("hex");
    const header = `<!-- heartbeat-history:v3 source=${encodeURIComponent(path)} body=${digest(body)} base=${digest(head)} bytes=${Buffer.byteLength(head)} backup=${digest(backup)} previous=${digest(backup)} planned=${Buffer.from(head).toString("base64")} -->\n`;
    await writeFile(path, head);
    await writeFile(historyPath, header + body);
    await writeFile(backupPath, backup);
    await writeFile(
      resolve(root, ".codex-task-progress.json"),
      JSON.stringify({ heartbeat: { ledgerPath: path } }),
    );
    const project = await service.projectView(root);
    assert.equal(project.status, "ready", project.error);
    assert.equal(project.certifiesCurrent, false);
    assert.equal(project.passed, false);
    assert.equal(project.wakeCount, 7);
    const bound = await service.bind("large-chat", path, root);
    assert.equal(bound?.status, "ready", bound?.error);
    const projection = await service.taskProjection("large-chat", root);
    assert.equal(projection.status, "ready", projection.error);
    assert.equal(projection.task?.source.itemStatusCount, 2);
    const first = await service.history("large-chat", root, { limit: 1 });
    assert.equal(first.total, 7);
    assert.ok(first.nextCursor);
    const second = await service.history("large-chat", root, {
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.notEqual(first.wakes[0]?.heading, second.wakes[0]?.heading);
    const projectPage = await service.projectHistory(root, { limit: 1 });
    assert.equal(projectPage.historyPath, historyPath);
    assert.equal(projectPage.total, 7);
    await appendFile(path, "\nchanged\n");
    const stalePage = await service.history("large-chat", root, {
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(stalePage.retryable, true);
  } finally {
    service.close();
    await f.close();
  }
});

test("a custom inspector returning a non-Items report cannot authorize task projection", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.kitPath,
      `export function inspectHeartbeatLedger() { return { mode: "current", wakes: [], items: [{id:"A", item:"test", status:"done"}], findings: [] }; }`,
    );
    await writeFile(f.source, ledger("chat-A"));
    const result = await f.service.taskProjection("chat-A", f.project);
    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /did not return an Items report/);
  } finally {
    await f.close();
  }
});

test("stable incomplete companion surfaces a terminal error after a verified project snapshot", async () => {
  const f = await fixture();
  let clock = 1_000;
  const service = new HeartbeatService(resolve(f.root, "broken-snapshot"), {
    refreshMs: 10,
    now: () => new Date(clock),
  });
  try {
    await writeFile(f.source, ledger("chat-A"));
    const verified = await service.projectView(f.project);
    assert.equal(verified.status, "ready");
    await writeFile(resolve(f.project, "taskhistory.md"), "corrupt companion");
    clock += 11;
    for (let attempt = 0; attempt < 2; attempt++) {
      const broken = await service.projectView(f.project);
      assert.equal(broken.status, "error");
      assert.equal(broken.retryable, undefined);
      assert.match(broken.error ?? "", /incomplete|missing/i);
    }
    const snapshot = await service.projectViewSnapshot(f.project);
    assert.equal(snapshot.view?.status, "error");
    assert.equal(snapshot.view?.retryable, undefined);
  } finally {
    service.close();
    await f.close();
  }
});

test("real orchestration history pages honor the wire budget without losing cursor records", async () => {
  const f = await fixture();
  try {
    const blockedTasks = Array.from({ length: 20 }, (_, i) => ({
      id: `B${i}`,
      title: "T".repeat(500),
      reason: "R".repeat(2_000),
      evidence: "E".repeat(1_000),
      requiresOwner: true,
    }));
    const orchestration = {
      scope: "session",
      before: null,
      after: null,
      blockedTasks,
      blockersEvidence: "checked",
    };
    const start = Date.parse("2026-11-11T10:00:00Z");
    const wakes = Array.from({ length: 12 }, (_, i) =>
      [
        `## ${new Date(start + i * 60_000).toISOString()} wake (10-row ledger)`,
        `orchestration: ${JSON.stringify(orchestration)}`,
        "| # | category | state |",
        "| --- | --- | --- |",
        "| 1 | audit | done |",
      ].join("\n"),
    ).join("\n");
    await writeFile(
      f.source,
      `# Supervision\nthread: chat-A\n${wakes}\n## Items\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| A | report:test | task | done | receipt |\n`,
    );
    const view = await f.service.bind("chat-A", f.source, f.project);
    assert.equal(view?.status, "ready");
    for (const getPage of [
      (cursor?: string) =>
        f.service.history("chat-A", f.project, {
          limit: 10,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      (cursor?: string) =>
        f.service.projectHistory(f.project, {
          limit: 10,
          ...(cursor === undefined ? {} : { cursor }),
        }),
    ]) {
      let cursor: string | undefined;
      const seen: number[] = [];
      do {
        const page = await getPage(cursor);
        assert.equal(page.error, undefined);
        assert.equal(page.total, 12);
        assert.ok(page.wakes.length > 0 && page.wakes.length < 10);
        assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 192 * 1024);
        assert.ok(
          Buffer.byteLength(
            JSON.stringify({ method: "task.request", result: { heartbeatHistory: page } }),
          ) <
            1024 * 1024,
        );
        for (const wake of page.wakes) {
          assert.ok(wake.orchestration);
          seen.push(wake.timeMs as number);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      assert.deepEqual(
        seen,
        Array.from({ length: 12 }, (_, i) => start + (11 - i) * 60_000),
      );
    }
  } finally {
    await f.close();
  }
});

test("project and bound cadence use full wake evidence, with explicit next wake taking priority", async () => {
  const f = await fixture();
  const now = new Date("2026-11-11T10:30:00Z");
  const service = new HeartbeatService(resolve(f.root, "cadence-display"), {
    kitPath: f.kitPath,
    refreshMs: 0,
    now: () => now,
  });
  try {
    const full = [
      "## 2026-11-11T10:00:00Z wake (10-row ledger)",
      "| # | category | state |",
      "| --- | --- | --- |",
      ...Array.from({ length: 10 }, (_, i) => `| ${i + 1} | audit | done |`),
    ].join("\n");
    const partial =
      "## 2026-11-11T10:25:00Z wake (10-row ledger)\n| # | category | state |\n| --- | --- | --- |\n| 1 | audit | done |";
    await writeFile(
      f.source,
      `# Supervision\nthread: chat-A\n${full}\n${partial}\n## Items\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| A | report:test | task | done | receipt |\n`,
    );
    await writeFile(
      resolve(f.project, ".codex-task-progress.json"),
      JSON.stringify({ heartbeat: { cadenceMinutes: 20 } }),
    );
    assert.equal((await service.projectView(f.project)).nextWakeAt, "2026-11-11T10:20:00.000Z");
    assert.equal((await service.view("chat-A", f.project))?.nextWakeAt, "2026-11-11T10:20:00.000Z");
    await writeFile(
      resolve(f.project, ".codex-task-progress.json"),
      JSON.stringify({ heartbeat: { cadenceMinutes: 20, nextWakeAt: "2026-11-11T11:00:00Z" } }),
    );
    assert.equal((await service.projectView(f.project)).nextWakeAt, "2026-11-11T11:00:00.000Z");
    assert.equal((await service.view("chat-A", f.project))?.nextWakeAt, "2026-11-11T11:00:00.000Z");
  } finally {
    service.close();
    await f.close();
  }
});

test("private full-source assignments include leaves beyond the panel window and reject old hashes", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.kitPath,
      `export function inspectHeartbeatLedger(text,{mode}) {
      const ids = Array.from({length:300},(_,i)=>"L"+i);
      const done = text.includes("revision-two") ? 200 : 150;
      return {mode,certifiesCurrent:false,passed:true,wakes:[],findings:[],items:[
        {id:"ROOT",item:"Business",status:"tracking",children:JSON.stringify(ids)},
        ...ids.map((id,i)=>({id,item:id,status:i<done?"done":"blocked",children:"[]",owner:"child",agent_thread_id:"child"}))
      ]};
    }`,
    );
    const source = `task_root: ROOT\n${ledger("chat-A")}`;
    await writeFile(f.source, source);
    const first = await f.service.taskProjection("chat-A", f.project);
    assert.equal(first.status, "ready", first.error);
    assert.ok(first.contentHash);
    assert.ok(first.sourcePath);
    assert.equal(first.task?.source.presentation.sourceItemCount, 301);
    assert.ok((first.task?.source.presentation.displayedItemCount ?? 0) <= 200);
    assert.equal(Object.hasOwn(first.task?.source ?? {}, "itemOwners"), false);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 192 * 1024);
    const query = {
      threadId: "chat-A",
      sourcePath: first.sourcePath,
      contentHash: first.contentHash,
      agents: [{ threadId: "child" }],
    };
    const assignment = f.service.agentTaskProgress(query);
    assert.deepEqual(assignment?.[0]?.progress, { completed: 150, total: 300, percent: 50 });
    assert.equal(assignment?.[0]?.assignedTaskIds.length, 300);
    assert.equal(f.service.agentTaskProgress({ ...query, threadId: "different-chat" }), null);
    assert.equal(
      f.service.agentTaskProgress({ ...query, sourcePath: `${query.sourcePath}.other` }),
      null,
    );
    await writeFile(f.source, `${source}\nrevision-two\n`);
    const second = await f.service.taskProjection("chat-A", f.project);
    assert.equal(second.status, "ready", second.error);
    assert.ok(second.contentHash && second.contentHash !== first.contentHash);
    assert.equal(f.service.agentTaskProgress(query), null);
    assert.deepEqual(
      f.service.agentTaskProgress({ ...query, contentHash: second.contentHash })?.[0]?.progress,
      { completed: 200, total: 300, percent: 66.67 },
    );
  } finally {
    await f.close();
  }
});

test("bound large head uses canonical display inventory with project inspector configured", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.source,
      [
        "# Supervision",
        "thread: large-chat",
        "## Items",
        "| id | source | item | status | evidence |",
        "| --- | --- | --- | --- | --- |",
        "| I1 | report:r1 | actual item | done | verified |",
        "## 2026-11-11T09:00:00Z wake (10-row ledger)",
        "",
      ].join("\n"),
    );
    assert.equal((await f.service.bind("large-chat", f.source, f.project))?.status, "ready");
    await appendFile(
      f.source,
      `## Notes\n${"x".repeat(4095).concat("\n").repeat(8193)}## 2026-11-11T10:00:00Z wake (10-row ledger)\n`,
    );
    const projected = await f.service.taskProjection("large-chat", f.project);
    assert.equal(projected.status, "ready", projected.error);
    assert.equal(projected.task?.objectives[0]?.id, "I1");
    const history = await f.service.history("large-chat", f.project);
    assert.equal(history.total, 2);
  } finally {
    await f.close();
  }
});

test("default unbound task discovery continues once for bounded deep sources", async () => {
  const f = await fixture();
  const deep = resolve(f.project, "a/b/c/d/e/f/g");
  await mkdir(deep, { recursive: true });
  await writeFile(resolve(deep, "heartbeat-one.md"), ledger("one-chat"));
  await writeFile(resolve(deep, "heartbeat-multi-a.md"), ledger("multi-chat"));
  await writeFile(resolve(deep, "heartbeat-multi-b.md"), ledger("multi-chat"));
  for (let i = 0; i < 45; i++)
    await writeFile(resolve(deep, `heartbeat-unrelated-${i}.md`), ledger(`unrelated-${i}`));
  // All fixture files are written before the scan; isolate this test from
  // delayed operating-system watcher events while retaining protected generations.
  const index = new HeartbeatDiscoveryIndex({
    watchFactory: (() =>
      Object.assign(new EventEmitter(), {
        close() {},
      })) as unknown as typeof import("node:fs").watch,
  });
  const realDiscover = index.discover.bind(index);
  const calls: { maxFiles: number | undefined; maxDepth: number | undefined }[] = [];
  index.discover = async (options, context) => {
    calls.push({ maxFiles: options.maxFiles, maxDepth: options.maxDepth });
    return realDiscover(options, context);
  };
  const service = new HeartbeatService(resolve(f.root, "deep-data"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 0,
    discoveryIndex: index,
  });
  try {
    const zero = await service.taskProjection("zero-chat", f.project);
    assert.equal(zero.status, "candidates");
    assert.equal(zero.task, null);
    assert.deepEqual(calls.splice(0), [
      { maxFiles: undefined, maxDepth: undefined },
      { maxFiles: 12_000, maxDepth: 32 },
    ]);
    const one = await service.taskProjection("one-chat", f.project);
    assert.equal(one.status, "pending-selection");
    assert.equal(one.task, null);
    const relations = new (
      await import("vibe-coding-kit/src/tasks/task-source-relations.mjs")
    ).TaskSourceRelations(resolve(f.root, "deep-data"));
    assert.equal((await relations.get("one-chat")).found, false);
    assert.equal((await relations.get("multi-chat")).found, false);
    assert.deepEqual(calls.splice(0), [
      { maxFiles: undefined, maxDepth: undefined },
      { maxFiles: 12_000, maxDepth: 32 },
    ]);
    const multi = await service.taskProjection("multi-chat", f.project);
    assert.equal(multi.status, "pending-selection");
    assert.equal(multi.task, null);
    assert.equal((await relations.get("multi-chat")).found, false);
    assert.deepEqual(calls.splice(0), [
      { maxFiles: undefined, maxDepth: undefined },
      { maxFiles: 12_000, maxDepth: 32 },
    ]);
    const project = await service.projectView(f.project);
    assert.equal(project.discoveryComplete, false);
    assert.ok(project.discoveryReasons?.includes("depth-limit"));
  } finally {
    service.close();
    index.close();
    await f.close();
  }
});

test("continuation respects explicit limits and never retries non-budget failures", async () => {
  const f = await fixture();
  const deep = resolve(f.project, "a/b/c/d/e/f/g");
  await mkdir(deep, { recursive: true });
  await writeFile(resolve(deep, "heartbeat.md"), ledger("chat"));
  const limited = new HeartbeatService(resolve(f.root, "limited"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 0,
    maxDepth: 5,
  });
  const index = new HeartbeatDiscoveryIndex();
  let scans = 0;
  index.discover = async (options) => {
    scans++;
    const result = await discoverHeartbeatLedgerSources(options);
    return { ...result, complete: false, reasons: [...result.reasons, "unreadable-directory"] };
  };
  const unsafe = new HeartbeatService(resolve(f.root, "unsafe"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 0,
    discoveryIndex: index,
  });
  try {
    assert.equal((await limited.taskProjection("chat", f.project)).status, "pending-selection");
    const result = await unsafe.taskProjection("chat", f.project);
    assert.equal(result.status, "pending-selection");
    assert.equal(scans, 1);
    const fileLimited = new HeartbeatService(resolve(f.root, "file-explicit"), {
      kitPath: f.kitPath,
      fallbackKitPath: null,
      refreshMs: 0,
      maxFiles: 1,
    });
    try {
      assert.equal(
        (await fileLimited.taskProjection("chat", f.project)).status,
        "pending-selection",
      );
    } finally {
      fileLimited.close();
    }
    await writeFile(
      resolve(f.project, ".codex-task-progress.json"),
      JSON.stringify({ heartbeat: { maxDepth: 5 } }),
    );
    const configured = new HeartbeatService(resolve(f.root, "configured"), {
      kitPath: f.kitPath,
      fallbackKitPath: null,
      refreshMs: 0,
    });
    try {
      assert.equal(
        (await configured.taskProjection("chat", f.project)).status,
        "pending-selection",
      );
    } finally {
      configured.close();
    }
  } finally {
    limited.close();
    unsafe.close();
    index.close();
    await f.close();
  }
});

test("expanded incomplete scan remains pending while ordinary shallow binding remains automatic", async () => {
  const f = await fixture();
  const deep = resolve(f.project, "a/b/c/d/e/f/g");
  await mkdir(deep, { recursive: true });
  const index = new HeartbeatDiscoveryIndex();
  let scans = 0;
  index.discover = async (options) => {
    scans++;
    const result = await discoverHeartbeatLedgerSources(options);
    if (options.maxDepth === 32) return { ...result, complete: false, reasons: ["file-limit"] };
    return result;
  };
  const incomplete = new HeartbeatService(resolve(f.root, "still-incomplete"), {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 0,
    discoveryIndex: index,
  });
  try {
    assert.equal((await incomplete.taskProjection("chat", f.project)).status, "pending-selection");
    assert.equal(scans, 2);
    const rel = new (
      await import("vibe-coding-kit/src/tasks/task-source-relations.mjs")
    ).TaskSourceRelations(resolve(f.root, "still-incomplete"));
    assert.equal((await rel.get("chat")).found, false);
    // A shallow complete scan still uses the existing automatic binding path.
    const shallowProject = resolve(f.root, "shallow");
    await mkdir(resolve(shallowProject, ".git"), { recursive: true });
    const path = resolve(shallowProject, "heartbeat.md");
    await writeFile(path, ledger("shallow-chat"));
    const shallow = new HeartbeatService(resolve(f.root, "shallow-data"), {
      kitPath: f.kitPath,
      fallbackKitPath: null,
      refreshMs: 0,
    });
    try {
      const projected = await shallow.taskProjection("shallow-chat", shallowProject);
      assert.equal(projected.status, "ready");
      assert.equal(projected.sourcePath, await realpath(path));
      const shallowRel = new (
        await import("vibe-coding-kit/src/tasks/task-source-relations.mjs")
      ).TaskSourceRelations(resolve(f.root, "shallow-data"));
      assert.equal((await shallowRel.get("shallow-chat")).binding?.origin, "automatic");
    } finally {
      shallow.close();
    }
  } finally {
    incomplete.close();
    index.close();
    await f.close();
  }
});

test("continuation honors a concurrently explicit binding without auto-selecting", async () => {
  const f = await fixture();
  const deep = resolve(f.project, "a/b/c/d/e/f/g");
  await mkdir(deep, { recursive: true });
  const sourcePath = resolve(deep, "heartbeat.md");
  await writeFile(sourcePath, ledger("chat"));
  const source = await realpath(sourcePath);
  const root = resolve(f.root, "concurrent-binding");
  const relations = new (
    await import("vibe-coding-kit/src/tasks/task-source-relations.mjs")
  ).TaskSourceRelations(root);
  const index = new HeartbeatDiscoveryIndex();
  const realDiscover = index.discover.bind(index);
  index.discover = async (options, context) => {
    const result = await realDiscover(options, context);
    if (options.maxDepth === 32) await relations.set("chat", { path: source, origin: "explicit" });
    return result;
  };
  const service = new HeartbeatService(root, {
    kitPath: f.kitPath,
    fallbackKitPath: null,
    refreshMs: 0,
    discoveryIndex: index,
  });
  try {
    let projection = await service.taskProjection("chat", f.project);
    // The explicit journal write may race a protected scan's generation check.
    // That must surface as retryable; the next read must honor the binding.
    if (projection.status === "pending") {
      assert.equal(projection.retryable, true);
      assert.equal((await relations.get("chat")).binding?.origin, "explicit");
      for (let attempt = 0; attempt < 5 && projection.status === "pending"; attempt++)
        projection = await service.taskProjection("chat", f.project);
    }
    assert.equal(projection.status, "ready", projection.error);
    assert.equal(projection.sourcePath, await realpath(source));
    assert.equal((await relations.get("chat")).binding?.origin, "explicit");
  } finally {
    service.close();
    index.close();
    await f.close();
  }
});

test("persisted bound ledger presents unknown item statuses without certifying or rewriting the source", async () => {
  const f = await fixture();
  const source = [
    "# Supervision",
    "thread: original-owner",
    "## 2026-11-11T10:00:00Z wake (10-row ledger)",
    "| # | category | state |",
    "| --- | --- | --- |",
    "| 1 | audit | done |",
    "## Items",
    "| id | source | item | status | evidence |",
    "| --- | --- | --- | --- | --- |",
    "| A | report:a | Complete A | done | evidence A |",
    "| B | report:b | Complete B | done | evidence B |",
    "| C | report:c | Work in progress | continuing ← resources | - |",
    "",
  ].join("\n");
  const storage = resolve(f.root, "unknown-status-bound");
  await writeFile(f.source, source);
  const before = await readFile(f.source);
  const first = new HeartbeatService(storage, {
    kitPath: PINNED_KIT_HEARTBEAT_API,
    fallbackKitPath: null,
    refreshMs: 0,
  });
  let reopened: HeartbeatService | undefined;
  let structural: HeartbeatService | undefined;
  try {
    assert.equal((await first.bind("chat-A", f.source, f.project))?.status, "ready");
    first.close();
    reopened = new HeartbeatService(storage, {
      kitPath: PINNED_KIT_HEARTBEAT_API,
      fallbackKitPath: null,
      refreshMs: 0,
    });
    const result = await reopened.taskProjection("chat-A", f.project);
    assert.equal(result.status, "ready", result.error);
    assert.deepEqual(result.task?.progress, { completed: 2, total: 3, percent: 66.67 });
    assert.equal(result.task?.objectives.find((item) => item.id === "C")?.status, "pending");
    assert.equal(result.task?.source.unknownStatusCount, 1);
    const history = await reopened.history("chat-A", f.project);
    assert.equal(history.total, 1);
    assert.equal(history.sourcePath, await realpath(f.source));
    assert.deepEqual(await readFile(f.source), before);
    const other = await reopened.taskProjection("unrelated-chat", f.project);
    assert.notEqual(other.status, "ready");
    assert.equal(other.task, null);
    assert.equal(
      reopened.agentTaskProgress({
        threadId: "unrelated-chat",
        sourcePath: await realpath(f.source),
        contentHash: result.contentHash ?? "",
        agents: [],
      }),
      null,
    );

    const duplicate = resolve(f.project, "heartbeat-duplicate.md");
    await writeFile(duplicate, source.replace("| C | report:c |", "| A | report:c |"));
    structural = new HeartbeatService(resolve(f.root, "unknown-status-structural"), {
      kitPath: PINNED_KIT_HEARTBEAT_API,
      fallbackKitPath: null,
      refreshMs: 0,
    });
    await structural.bind("structural-chat", duplicate, f.project);
    const invalid = await structural.taskProjection("structural-chat", f.project);
    assert.equal(invalid.status, "error");
    assert.match(invalid.error ?? "", /Cannot project invalid heartbeat Items report|duplicate/i);
    assert.deepEqual(await readFile(f.source), before);
  } finally {
    first.close();
    reopened?.close();
    structural?.close();
    await f.close();
  }
});
