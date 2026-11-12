import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { HeartbeatService } from "./heartbeat.js";

const ledger = (thread = "", legacy = false) =>
  `# Supervision\nthread: ${thread}\n## 2026-11-11T10:00:00Z wake (${legacy ? 8 : 10}-row ledger)\n${legacy ? "" : "contract: heartbeat/v2"}\n## Items\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| A | request | test | blocked | waiting |\n`;
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "task-heartbeat-test-"));
  const project = resolve(root, "project");
  await mkdir(resolve(project, ".git"), { recursive: true });
  const kitPath = resolve(root, "kit-api.mjs");
  // Adapter tests isolate the canonical API contract; the Kit owns parser validation.
  await writeFile(
    kitPath,
    `export function inspectHeartbeatLedger(text, {mode}) {
    const modern = text.includes('heartbeat/v2');
    return {certifiesCurrent:mode==='current'&&modern, passed:mode!=='current'||modern,
      wakes:text.includes('wake (')?[{heading:'wake',timeMs:1794391200000,rows:[]}]:[],
      items:[{id:'A',status:'blocked'}],findings:modern?[]:[{severity:'error',message:'legacy'}]};
  }`,
  );
  const source = resolve(project, "heartbeat.md");
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

test("exact thread association auto-selects, multiple matches do not", async () => {
  const f = await fixture();
  try {
    await writeFile(f.source, ledger("chat-AB"));
    assert.equal((await f.service.view("chat-A", f.project))?.status, "candidates");
    await writeFile(f.source, ledger("chat-A"));
    const view = await f.service.view("chat-A", f.project);
    assert.equal(view?.status, "ready");
    assert.equal(view?.certifiesCurrent, true);
    await writeFile(resolve(f.project, "second.md"), ledger("chat-A"));
    const ambiguous = await f.service.view("chat-A", f.project);
    assert.equal(ambiguous?.status, "candidates");
    assert.equal(ambiguous?.candidates.length, 2);
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
    assert.equal(
      Date.parse(view?.nextWakeAt ?? "") - Date.parse(view?.lastWakeAt ?? ""),
      1_200_000,
    );
    const before = await readFile(f.source, "utf8");
    await f.service.view("chat-A", f.project);
    assert.equal(await readFile(f.source, "utf8"), before);
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

test("observations are deduplicated across refresh and service restart", async () => {
  const f = await fixture();
  try {
    await writeFile(f.source, ledger("chat-A"));
    await f.service.view("chat-A", f.project);
    await f.service.view("chat-A", f.project);
    const reopened = new HeartbeatService(resolve(f.root, "data"), {
      kitPath: f.kitPath,
      refreshMs: 0,
    });
    await reopened.view("chat-A", f.project);
    await rm(f.source);
    const stale = await reopened.view("chat-A", f.project);
    assert.equal(stale?.status, "stale");
    reopened.close();
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(resolve(f.root, "data/heartbeat"));
    const log = files.find((name) => name.endsWith(".jsonl"));
    assert.ok(log);
    const lines = (await readFile(resolve(f.root, "data/heartbeat", log), "utf8"))
      .trim()
      .split("\n");
    assert.equal(lines.length, 1);
  } finally {
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
    assert.equal(view?.sourcePath, workspaceSource);
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
