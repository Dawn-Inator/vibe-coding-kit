import assert from "node:assert/strict";
import {
	mkdirSync,
	realpathSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { readProjectHeartbeat } from "../../src/tasks/project-heartbeat.mjs";
import { cleanupTempDirs, mkdtempTracked } from "../support/temp-dirs.mjs";

after(cleanupTempDirs);

const NOW = new Date("2026-01-01T12:00:00.000Z");
const projectRoot = () => realpathSync(mkdtempTracked("project-heartbeat-"));

function writeLedger(
	root,
	filename,
	{ wake = null, item = "recorded work" } = {},
) {
	const path = join(root, filename);
	writeFileSync(
		path,
		[
			...(wake ? [`## ${wake} wake (10-row ledger)`, ""] : []),
			"## Items",
			"",
			"| id | source | item | status | evidence |",
			"| --- | --- | --- | --- | --- |",
			`| I1 | report:r1 | ${item} | done | \`recorded receipt\` |`,
			"",
		].join("\n"),
	);
	return path;
}

function writeWakeOnly(root, filename, wake) {
	const path = join(root, filename);
	writeFileSync(path, `## ${wake} wake (10-row ledger)\n`);
	return path;
}

test("project heartbeat stays isolated to its trusted current project", async () => {
	const firstRoot = projectRoot();
	const secondRoot = projectRoot();
	const first = writeLedger(firstRoot, "heartbeat.md", {
		wake: "2026-01-01T10:00Z",
	});
	const second = writeLedger(secondRoot, "heartbeat.md", {
		wake: "2026-01-01T11:00Z",
	});

	const firstView = await readProjectHeartbeat({ root: firstRoot, now: NOW });
	const secondView = await readProjectHeartbeat({ root: secondRoot, now: NOW });
	assert.equal(firstView.source.path, first);
	assert.equal(secondView.source.path, second);
	assert.equal(firstView.projectRoot, firstRoot);
	assert.equal(secondView.projectRoot, secondRoot);
});

test("nested Git projects are excluded from discovery and explicit project pointers", async () => {
	const root = projectRoot();
	const rootLedger = writeLedger(root, "heartbeat.md", {
		wake: "2026-01-01T10:00Z",
	});
	const nestedRoot = join(root, ".vibe-coding", "kit");
	mkdirSync(nestedRoot, { recursive: true });
	writeFileSync(join(nestedRoot, ".git"), "gitdir: ../.git/worktrees/kit\n");
	const nestedLedger = writeLedger(nestedRoot, "heartbeat.md", {
		wake: "2026-01-01T11:55Z",
	});

	const automatic = await readProjectHeartbeat({ root, now: NOW });
	assert.equal(automatic.source.path, rootLedger);
	assert.equal(
		automatic.discovery.candidates.some(
			(candidate) => candidate.path === nestedLedger,
		),
		false,
	);
	assert.equal(automatic.discovery.complete, true);

	const configuredNested = await readProjectHeartbeat({
		root,
		ledgerPath: nestedLedger,
		now: NOW,
	});
	assert.equal(configuredNested.status, "error");
	assert.equal(configuredNested.source, null);
	assert.match(configuredNested.error, /nested Git project/);
});

test("latest valid recorded wake outranks file mtime and ties use lexical canonical path", async () => {
	const root = projectRoot();
	const olderWake = writeLedger(root, "a-heartbeat.md", {
		wake: "2026-01-01T10:10Z",
	});
	const newerWake = writeLedger(root, "z-heartbeat.md", {
		wake: "2026-01-01T11:20Z",
	});
	utimesSync(
		olderWake,
		new Date("2026-01-01T11:59:00Z"),
		new Date("2026-01-01T11:59:00Z"),
	);
	utimesSync(
		newerWake,
		new Date("2026-01-01T08:00:00Z"),
		new Date("2026-01-01T08:00:00Z"),
	);
	const latest = await readProjectHeartbeat({ root, now: NOW });
	assert.equal(latest.source.path, newerWake);
	assert.equal(latest.source.lastRecordedAt, "2026-01-01T11:20:00.000Z");
	assert.equal(latest.basis, "latest-recorded-wake");

	const tieRoot = projectRoot();
	const alpha = writeLedger(tieRoot, "a-heartbeat.md", {
		wake: "2026-01-01T11:00Z",
	});
	writeLedger(tieRoot, "b-heartbeat.md", { wake: "2026-01-01T11:00Z" });
	const tied = await readProjectHeartbeat({ root: tieRoot, now: NOW });
	assert.equal(tied.source.path, alpha);
});

test("configured source wins and an Items-only fallback is stable without inventing a wake", async () => {
	const root = projectRoot();
	writeLedger(root, "a-heartbeat.md", { wake: "2026-01-01T11:00Z" });
	const configured = writeLedger(root, "notes.md", {
		wake: "2026-01-01T10:00Z",
	});
	const selected = await readProjectHeartbeat({
		root,
		ledgerPath: configured,
		now: NOW,
	});
	assert.equal(selected.source.path, configured);
	assert.equal(selected.basis, "configured");

	const inventoryRoot = projectRoot();
	const beta = writeLedger(inventoryRoot, "b-heartbeat.md");
	const alpha = writeLedger(inventoryRoot, "a-heartbeat.md");
	const inventory = await readProjectHeartbeat({
		root: inventoryRoot,
		now: NOW,
	});
	assert.equal(inventory.source.path, alpha);
	assert.equal(inventory.source.lastRecordedAt, null);
	assert.equal(inventory.basis, "items-inventory");
	assert.equal(beta.startsWith(inventoryRoot), true);
});

test("invalid and future wake timestamps do not become the recorded display basis", async () => {
	const root = projectRoot();
	writeLedger(root, "a-heartbeat.md", { wake: "2026-02-30T10:00Z" });
	writeLedger(root, "b-heartbeat.md", { wake: "2026-01-01T13:00Z" });
	const view = await readProjectHeartbeat({ root, now: NOW });
	assert.equal(view.source.lastRecordedAt, null);
	assert.equal(view.basis, "items-inventory");
});

test("Items fallback outranks future-only wake files, and empty future-only candidates return none", async () => {
	const mixedRoot = projectRoot();
	writeWakeOnly(mixedRoot, "a.md", "2026-01-01T13:00Z");
	const inventoryPath = writeLedger(mixedRoot, "b-heartbeat.md");
	const mixed = await readProjectHeartbeat({ root: mixedRoot, now: NOW });
	assert.equal(mixed.source.path, inventoryPath);
	assert.equal(mixed.basis, "items-inventory");

	const emptyRoot = projectRoot();
	writeWakeOnly(emptyRoot, "a.md", "2026-01-01T13:00Z");
	writeWakeOnly(emptyRoot, "b.md", "2026-01-01T14:00Z");
	const empty = await readProjectHeartbeat({ root: emptyRoot, now: NOW });
	assert.equal(empty.status, "none");
	assert.equal(empty.source, null);
	assert.equal(empty.basis, "none");
});

test("cadence stays absent unless the project reader receives an explicit interval", async () => {
	const root = projectRoot();
	writeLedger(root, "heartbeat.md");
	const withoutInterval = await readProjectHeartbeat({ root, now: NOW });
	assert.equal(withoutInterval.source.cadence, null);
	const withInterval = await readProjectHeartbeat({
		root,
		now: NOW,
		intervalMinutes: 30,
	});
	assert.equal(withInterval.source.cadence.intervalMinutes, 30);
});

test("an incomplete discovery can display its best found source but remains explicitly incomplete", async () => {
	const root = projectRoot();
	mkdirSync(join(root, ".workspace"), { recursive: true });
	const found = writeLedger(root, ".workspace/a-heartbeat.md", {
		wake: "2026-01-01T11:00Z",
	});
	writeLedger(root, ".workspace/b-heartbeat.md", { wake: "2026-01-01T11:30Z" });
	const view = await readProjectHeartbeat({ root, now: NOW, maxFiles: 1 });
	assert.equal(view.status, "ready");
	assert.equal(view.source.path, found);
	assert.equal(view.discovery.complete, false);
	assert.deepEqual(view.discovery.reasons, ["file-limit"]);
});

test("missing or unreadable configured sources return errors without fallback", async () => {
	const root = projectRoot();
	const fallback = writeLedger(root, "heartbeat.md", {
		wake: "2026-01-01T11:00Z",
	});
	const missing = await readProjectHeartbeat({
		root,
		ledgerPath: "missing.md",
		now: NOW,
	});
	assert.equal(missing.status, "error");
	assert.equal(missing.source, null);
	assert.match(missing.error, /Configured heartbeat ledger could not be read/);
	assert.notEqual(missing.source?.path, fallback);

	const directory = join(root, "configured-directory");
	mkdirSync(directory);
	const unreadable = await readProjectHeartbeat({
		root,
		ledgerPath: directory,
		now: NOW,
	});
	assert.equal(unreadable.status, "error");
	assert.equal(unreadable.source, null);
});

test("no discovered source returns none without claiming a recorded project heartbeat", async () => {
	const root = projectRoot();
	writeFileSync(
		join(root, "api-doc.md"),
		"# API\ncontract: heartbeat/v2\n## not-a-time wake (10-row ledger)\n",
	);
	const empty = await readProjectHeartbeat({ root, now: NOW });
	assert.equal(empty.status, "none");
	assert.equal(empty.source, null);
	assert.equal(empty.basis, "none");
	assert.equal(empty.discovery.complete, true);
});

test("configured paired source rejects oversized history before parsing the companion", async () => {
	const root = projectRoot();
	const path = writeLedger(root, "heartbeat.md", { wake: "2026-01-01T10:00Z" });
	const companion = join(root, "taskhistory.md");
	writeFileSync(companion, "unrelated");
	truncateSync(companion, 8 * 1024 * 1024 + 1);
	const view = await readProjectHeartbeat({ root, ledgerPath: path, now: NOW });
	assert.equal(view.status, "error");
	assert.match(view.error, /exceeds.*byte read limit/i);
});
