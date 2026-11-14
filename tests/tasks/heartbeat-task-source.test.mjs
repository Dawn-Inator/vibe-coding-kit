import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { linkSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	discoverHeartbeatLedgers,
	discoverBoundHeartbeatSource,
	HeartbeatDiscoveryIndex,
	discoverHeartbeatLedgerSources,
	projectHeartbeatTask,
} from "../../src/tasks/heartbeat-task-source.mjs";
import { inspectHeartbeatLedger, summarizeHeartbeatLedger } from "../../src/supervision/heartbeat-ledger-api.mjs";
import { cleanupTempDirs, mkdtempTracked } from "../support/temp-dirs.mjs";

after(cleanupTempDirs);

const HERE = dirname(fileURLToPath(import.meta.url));
const THREAD = "thread-1234";
const ledger = (rows) =>
	[
		"## Items",
		"",
		"| id | source | item | status | evidence | children | owner | repository | worktree | mode | write_set | dispatch_ref |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		...rows.map((row) => {
			const values = [...row];
			while (values.length < 12) values.push("-");
			if (values[3] === "tracking")
				Object.assign(values, {
					6: "lead",
					7: "vibe-coding-kit",
					8: "codex/source-worker",
					9: "read-only",
					10: "[]",
					11: "-",
				});
			return `| ${values.join(" | ")} |`;
		}),
		"",
	].join("\n");

function projectRoot() {
	return realpathSync(mkdtempTracked("heartbeat-task-source-"));
}

const PROJECT_ROOT = realpathSync(projectRoot());
const PROJECT_LEDGER = join(PROJECT_ROOT, "heartbeat.md");

test("discovery scans project-local priority paths, excludes fenced examples, and associates exact thread tokens", async () => {
	const root = projectRoot();
	mkdirSync(join(root, ".workspace", "task", "session"), { recursive: true });
	mkdirSync(join(root, ".todolist"), { recursive: true });
	mkdirSync(join(root, "docs"), { recursive: true });
	const workspaceLedger = join(
		root,
		".workspace",
		"task",
		"session",
		"heartbeat.md",
	);
	const todoLedger = join(root, ".todolist", "heartbeat.md");
	const fenced = join(root, "docs", "example.md");
	const fencedNamed = join(root, "docs", "heartbeat-fenced.md");
	const invalidWake = join(root, "docs", "invalid-wake.md");
	const markerOnly = join(root, "docs", "marker-only.md");
	const fencedWake = join(root, "docs", "fenced-wake.md");
	const legacy8 = join(root, "docs", "legacy-8.md");
	const legacy10 = join(root, "docs", "legacy-10.md");
	writeFileSync(
		workspaceLedger,
		`${ledger([["I1", "report:r1", "check status", "done", "`receipt`", "[]"]])}\n## not-a-time wake (10-row ledger)\nthread: ${THREAD}\n`,
	);
	writeFileSync(
		todoLedger,
		ledger([["I2", "report:r2", "unrelated", "done", "`receipt`", "[]"]]),
	);
	writeFileSync(
		fenced,
		`\`\`\`md\n${ledger([["I3", "report:r3", THREAD, "done", "`receipt`", "[]"]])}\n\`\`\`\n`,
	);
	writeFileSync(
		fencedNamed,
		`\`\`\`md\n${ledger([["I4", "report:r4", "fenced", "done", "`receipt`", "[]"]])}\n## 2026-01-01T10:00Z wake (10-row ledger)\n\`\`\`\n`,
	);
	writeFileSync(
		invalidWake,
		"# API\ncontract: heartbeat/v2\n## not-a-time wake (10-row ledger)\n",
	);
	writeFileSync(markerOnly, "# Example\ncontract: heartbeat/v2\n");
	writeFileSync(
		fencedWake,
		"```md\n## 2026-01-01T10:00Z wake (10-row ledger)\n```\n",
	);
	writeFileSync(legacy8, "## 2026-01-01T10:00Z wake (8-row ledger)\n");
	writeFileSync(legacy10, "## 2026-01-01T10:00Z wake (10-row ledger)\n");

	const candidates = await discoverHeartbeatLedgers({
		root,
		threadId: THREAD,
		maxFiles: 20,
	});
	const canonicalTodo = realpathSync(todoLedger);
	const canonicalWorkspace = realpathSync(workspaceLedger);
	const canonicalLegacy8 = realpathSync(legacy8);
	const canonicalLegacy10 = realpathSync(legacy10);
	assert.deepEqual(
		candidates.map((candidate) => candidate.path),
		[
			canonicalTodo,
			canonicalWorkspace,
			canonicalLegacy8,
			canonicalLegacy10,
		].sort(),
	);
	assert.equal(
		candidates.find((candidate) => candidate.path === canonicalWorkspace)
			.associated,
		true,
	);
	assert.equal(
		candidates.find((candidate) => candidate.path === canonicalTodo).associated,
		false,
	);
});

test("discovery rejects out-of-root explicit bindings and requires exact thread identity", async () => {
	const root = projectRoot();
	const outside = projectRoot();
	const path = join(outside, "heartbeat.md");
	writeFileSync(
		path,
		ledger([["I1", "report:r1", "outside", "done", "`receipt`", "[]"]]),
	);
	await assert.rejects(
		discoverHeartbeatLedgers({ root, threadId: THREAD, ledgerPath: path }),
		/absolute project root|within/i,
	);
	await assert.rejects(
		discoverHeartbeatLedgers({ root, threadId: "   " }),
		/thread ID/i,
	);
	const explicit = join(root, "backlog.md");
	writeFileSync(
		explicit,
		`${ledger([["I2", "report:r2", "configured source", "done", "`receipt`", "[]"]])}\n## not-a-time wake (10-row ledger)\n`,
	);
	const bound = await discoverHeartbeatLedgers({
		root,
		threadId: THREAD,
		ledgerPath: explicit,
	});
	assert.deepEqual(bound, [
		{ path: realpathSync(explicit), associated: false },
	]);
});

test("explicit project root is rejected as a non-file without hanging", async () => {
	const root = projectRoot();
	for (const ledgerPath of [".", root]) {
		await assert.rejects(
			discoverHeartbeatLedgerSources({ root, threadId: THREAD, ledgerPath }),
			(error) => error.code === "not-file",
		);
	}
});

test("discovery associates only one exact standalone thread metadata field", async () => {
	const root = projectRoot();
	const unrelated = join(root, "heartbeat-evidence.md");
	const conflict = join(root, "heartbeat-conflict.md");
	writeFileSync(
		unrelated,
		ledger([
			[
				"I1",
				"report:r1",
				"inspect evidence",
				"done",
				`receipt mentions ${THREAD}`,
				"[]",
			],
		]),
	);
	writeFileSync(
		conflict,
		`${ledger([["I2", "report:r2", "conflicting metadata", "done", "receipt", "[]"]])}\nthread: ${THREAD}\nthread_id: other-thread\n`,
	);
	const candidates = await discoverHeartbeatLedgers({ root, threadId: THREAD });
	assert.equal(
		candidates.find((candidate) => candidate.path === realpathSync(unrelated))
			.associated,
		false,
	);
	assert.equal(
		candidates.find((candidate) => candidate.path === realpathSync(conflict))
			.associated,
		false,
	);
});

test("discovery metadata uses the canonical wake and inventory parsers", () => {
	for (const text of [
		"ordinary markdown\n",
		ledger([["I1", "source", "one", "pending", "", "[]"]]),
		"## 2026-01-01T10:00Z wake (10-row ledger)\n" + ledger([["I2", "source", "two", "done", "ok", "[]"]]),
		"## not-a-time wake (8-row ledger)\n## Items\n| id | item |\n| -- | -- |\n| I3 | three |\n",
	]) {
		const full = inspectHeartbeatLedger(text, { mode: "items" });
		const summary = summarizeHeartbeatLedger(text);
		assert.deepEqual(summary.wakes, full.wakes);
		assert.equal(summary.itemCount, full.itemCount);
	}
});

test("bounded concurrent discovery preserves traversal priority and refreshes source contents", async () => {
	const root = projectRoot();
	const workspace = join(root, ".workspace");
	mkdirSync(workspace);
	for (let i = 0; i < 40; i += 1) {
		const name = `heartbeat-${String(i).padStart(2, "0")}.md`;
		writeFileSync(join(workspace, name), `${ledger([[`I${i}`, "report:r", name, "pending", "", "[]"]])}\nthread: ${THREAD}\n`);
	}
	writeFileSync(join(root, "heartbeat-root.md"), `${ledger([["R", "report:r", "root", "done", "", "[]"]])}\nthread: ${THREAD}\n`);
	const first = await discoverHeartbeatLedgerSources({ root, threadId: THREAD, maxFiles: 35 });
	assert.equal(first.visitedFiles, 35);
	assert.deepEqual(first.reasons, ["file-limit"]);
	assert.equal(first.candidates.length, 35);
	assert.ok(first.candidates.every((candidate) => dirname(candidate.path) === workspace && candidate.associated));
	assert.ok(first.candidates.some((candidate) => basename(candidate.path) === "heartbeat-34.md"));
	assert.ok(!first.candidates.some((candidate) => basename(candidate.path) === "heartbeat-35.md"));
	writeFileSync(join(workspace, "heartbeat-00.md"), "ordinary text\n");
	const refreshed = await discoverHeartbeatLedgerSources({ root, threadId: THREAD, maxFiles: 35 });
	assert.equal(refreshed.visitedFiles, 35);
	assert.equal(refreshed.candidates.length, 34);
	assert.ok(!refreshed.candidates.some((candidate) => basename(candidate.path) === "heartbeat-00.md"));
});

test("discovery reports incomplete scans at file/depth limits and preserves wrapper behavior", async () => {
	const limitedRoot = projectRoot();
	mkdirSync(join(limitedRoot, ".workspace"), { recursive: true });
	for (const name of ["a-heartbeat.md", "b-heartbeat.md"])
		writeFileSync(
			join(limitedRoot, ".workspace", name),
			`${ledger([[name, "report:r1", "source row", "pending", "", "[]"]])}\nthread: ${THREAD}\n`,
		);
	const limited = await discoverHeartbeatLedgerSources({
		root: limitedRoot,
		threadId: THREAD,
		maxFiles: 1,
	});
	assert.equal(limited.complete, false);
	assert.equal(limited.visitedFiles, 1);
	assert.deepEqual(limited.reasons, ["file-limit"]);
	assert.equal(limited.candidates.length, 1);
	assert.equal(limited.candidates[0].associated, true);

	const noSourceRoot = projectRoot();
	writeFileSync(join(noSourceRoot, "a.md"), "ordinary notes\n");
	writeFileSync(join(noSourceRoot, "b.md"), "more ordinary notes\n");
	const noneBeforeLimit = await discoverHeartbeatLedgerSources({
		root: noSourceRoot,
		threadId: THREAD,
		maxFiles: 1,
	});
	assert.equal(noneBeforeLimit.candidates.length, 0);
	assert.equal(noneBeforeLimit.complete, false);
	assert.deepEqual(noneBeforeLimit.reasons, ["file-limit"]);

	const deepRoot = projectRoot();
	mkdirSync(join(deepRoot, "nested", "deeper"), { recursive: true });
	const depthLimited = await discoverHeartbeatLedgerSources({
		root: deepRoot,
		threadId: THREAD,
		maxDepth: 0,
	});
	assert.equal(depthLimited.complete, false);
	assert.deepEqual(depthLimited.reasons, ["depth-limit"]);

	const completeRoot = projectRoot();
	const onlyLedger = join(completeRoot, "heartbeat.md");
	writeFileSync(
		onlyLedger,
		`${ledger([["I1", "report:r1", "one row", "pending", "", "[]"]])}\nthread: ${THREAD}\n`,
	);
	const complete = await discoverHeartbeatLedgerSources({
		root: completeRoot,
		threadId: THREAD,
	});
	assert.equal(complete.complete, true);
	assert.deepEqual(complete.reasons, []);
	assert.equal(complete.schemaVersion, 1);
	assert.equal(complete.root, completeRoot);
	assert.deepEqual(
		await discoverHeartbeatLedgers({ root: completeRoot, threadId: THREAD }),
		complete.candidates,
	);
});

test("projection retains reported rows, evidence and raw statuses; tracking parents count linked children once", () => {
	const text = ledger([
		[
			"P1",
			"report:r1",
			"Coordinate",
			"tracking",
			"child state inspected",
			'["C1","C2"]',
		],
		["C1", "report:r1", "First leaf", "done", "`receipt one`", "[]"],
		[
			"C2",
			"report:r1",
			"Second leaf",
			"blocked <- input",
			"`blocked reason`",
			"[]",
		],
	]);
	const report = inspectHeartbeatLedger(text, { mode: "items" });
	assert.equal(report.passed, true, JSON.stringify(report.findings));
	const state = projectHeartbeatTask({
		report,
		root: PROJECT_ROOT,
		threadId: THREAD,
		path: PROJECT_LEDGER,
		contentHash: "abc",
		modifiedAt: "2026-01-01T00:00:00Z",
	});
	assert.deepEqual(
		state.objectives.map((objective) => objective.id),
		["P1"],
	);
	assert.deepEqual(
		state.objectives[0].items.map((item) => item.id),
		["C1", "C2"],
	);
	assert.deepEqual(state.progress, { completed: 1, total: 2, percent: 50 });
	assert.equal(
		state.objectives[0].items[0].evidence[0].verification,
		"reported",
	);
	assert.deepEqual(state.source.itemStatuses, {
		P1: "tracking",
		C1: "done",
		C2: "blocked <- input",
	});
	assert.equal(state.source.readOnly, true);
});

test("projected evidence uses only available source location and attribution", () => {
	const report = {
		mode: "items",
		findings: [],
		items: [
			{
				id: "I1",
				item: "missing line",
				status: "done",
				evidence: "reported claim",
				source: "  ",
			},
			{
				id: "I2",
				item: "known line",
				status: "done",
				evidence: "checked claim",
				source: "report:r2",
				line: 7,
				lineNumber: 8,
			},
			{
				id: "I3",
				item: "legacy line number",
				status: "done",
				evidence: "legacy claim",
				lineNumber: 9,
			},
		],
	};
	const state = projectHeartbeatTask({
		report,
		root: PROJECT_ROOT,
		threadId: THREAD,
		path: PROJECT_LEDGER,
		contentHash: "evidence",
		modifiedAt: "2026-01-01T00:00:00Z",
	});
	assert.equal(state.objectives[0].evidence[0].verification, "reported");
	assert.equal(state.objectives[0].evidence[0].reference, PROJECT_LEDGER);
	assert.equal(state.objectives[1].evidence[0].verification, "reported");
	assert.equal(
		state.objectives[1].evidence[0].reference,
		`${PROJECT_LEDGER}#L7; source=report:r2`,
	);
	assert.equal(state.objectives[2].evidence[0].verification, "reported");
	assert.equal(
		state.objectives[2].evidence[0].reference,
		`${PROJECT_LEDGER}#L9`,
	);
});

test("nested tracking hierarchies flatten to real leaves once and shared-child DAGs stay visible", () => {
	const report = {
		mode: "items",
		findings: [],
		items: [
			{
				id: "P1",
				item: "Root coordinator",
				status: "tracking",
				evidence: "child state inspected",
				children: '["P2","C3"]',
			},
			{
				id: "P2",
				item: "Nested coordinator",
				status: "tracking",
				evidence: "leaf state inspected",
				children: '["C1","C2"]',
			},
			{
				id: "Q1",
				item: "Second coordinator",
				status: "tracking",
				evidence: "shared child state inspected",
				children: '["C1"]',
			},
			{
				id: "C1",
				item: "One shared leaf",
				status: "done",
				evidence: "receipt 1",
			},
			{ id: "C2", item: "Second leaf", status: "pending", evidence: "" },
			{
				id: "C3",
				item: "Third leaf",
				status: "blocked",
				evidence: "blocked input",
			},
		],
	};
	const state = projectHeartbeatTask({
		report,
		root: PROJECT_ROOT,
		threadId: THREAD,
		path: PROJECT_LEDGER,
		contentHash: "nested",
		modifiedAt: "2026-01-01T00:00:00Z",
	});
	const ids = state.objectives.flatMap((objective) => [
		objective.id,
		...objective.items.map((item) => item.id),
	]);
	assert.equal(
		new Set(ids).size,
		ids.length,
		"each source row ID remains visible once",
	);
	assert.deepEqual(
		state.objectives
			.find((objective) => objective.id === "P1")
			.items.map((item) => item.id),
		["C1", "C2", "C3"],
	);
	assert.equal(
		state.objectives.find((objective) => objective.id === "P2").required,
		false,
	);
	assert.equal(
		state.objectives.find((objective) => objective.id === "Q1").required,
		false,
	);
	assert.deepEqual(state.progress, { completed: 1, total: 3, percent: 33.33 });
	assert.deepEqual(state.source.linkRisks, [
		"C1: shared child link; counted once under P1",
	]);
});

test("projection rejects parser errors and duplicate IDs, and surfaces unresolved child links", () => {
	const invalid = inspectHeartbeatLedger(
		ledger([["I1", "report:r1", "No evidence", "done", "", "[]"]]),
		{ mode: "items" },
	);
	assert.throws(
		() =>
			projectHeartbeatTask({
				report: invalid,
				root: PROJECT_ROOT,
				threadId: THREAD,
				path: PROJECT_LEDGER,
				contentHash: "abc",
				modifiedAt: "2026-01-01T00:00:00Z",
			}),
		/Cannot project invalid heartbeat Items report/,
	);

	const duplicateReport = {
		mode: "items",
		findings: [],
		items: [
			{ id: "D1", item: "first", status: "pending", evidence: "" },
			{ id: "D1", item: "second", status: "pending", evidence: "" },
		],
	};
	assert.throws(
		() =>
			projectHeartbeatTask({
				report: duplicateReport,
				root: PROJECT_ROOT,
				threadId: THREAD,
				path: PROJECT_LEDGER,
				contentHash: "abc",
				modifiedAt: "2026-01-01T00:00:00Z",
			}),
		/duplicate row ID/,
	);

	const linksReport = {
		mode: "items",
		findings: [],
		items: [
			{
				id: "P1",
				item: "Parent",
				status: "tracking",
				evidence: "checked",
				children: '["missing"]',
			},
			{
				id: "C1",
				item: "Child",
				status: "mystery",
				evidence: "",
				children: "[]",
			},
		],
	};
	const state = projectHeartbeatTask({
		report: linksReport,
		root: PROJECT_ROOT,
		threadId: THREAD,
		path: PROJECT_LEDGER,
		contentHash: "abc",
		modifiedAt: "2026-01-01T00:00:00Z",
	});
	assert.deepEqual(
		state.objectives.map((objective) => objective.id),
		["P1", "C1"],
	);
	assert.deepEqual(state.source.linkRisks, ["P1: missing child missing"]);
	assert.equal(state.objectives[1].status, "pending");
});

test("projection requires a normalized root and keeps the ledger path inside it", () => {
	const report = {
		mode: "items",
		findings: [],
		items: [{ id: "I1", item: "one", status: "pending", evidence: "" }],
	};
	const input = {
		report,
		threadId: THREAD,
		root: PROJECT_ROOT,
		path: PROJECT_LEDGER,
		contentHash: "abc",
		modifiedAt: "2026-01-01T00:00:00Z",
	};
	const outsidePath = join(PROJECT_ROOT, "..", "outside", "heartbeat.md");
	const unnormalizedPath = `${PROJECT_ROOT}${sep}..${sep}${basename(PROJECT_ROOT)}${sep}heartbeat.md`;
	const unnormalizedRoot = `${PROJECT_ROOT}${sep}..${sep}${basename(PROJECT_ROOT)}`;
	assert.throws(
		() => projectHeartbeatTask({ ...input, path: outsidePath }),
		/within the project root/,
	);
	assert.throws(
		() => projectHeartbeatTask({ ...input, path: unnormalizedPath }),
		TypeError,
	);
	assert.throws(
		() => projectHeartbeatTask({ ...input, root: unnormalizedRoot }),
		/normalized absolute project root/,
	);
});

test("discovery never follows a symlink that resolves outside the project root", async () => {
	const root = projectRoot();
	const outside = projectRoot();
	mkdirSync(join(root, "docs"), { recursive: true });
	const target = join(outside, "heartbeat.md");
	writeFileSync(
		target,
		ledger([["I1", "report:r1", "external", "done", "`receipt`", "[]"]]),
	);
	symlinkSync(target, join(root, "docs", "heartbeat.md"));
	const candidates = await discoverHeartbeatLedgers({
		root,
		threadId: THREAD,
		maxFiles: 20,
	});
	assert.deepEqual(candidates, []);
});

test("discovery keeps the trusted root Git project but rejects explicit nested Git ledgers", async () => {
	const root = projectRoot();
	mkdirSync(join(root, ".git"));
	const rootLedger = join(root, "heartbeat.md");
	writeFileSync(
		rootLedger,
		ledger([["R1", "report:r1", "root source", "done", "`receipt`", "[]"]]),
	);

	const fileProject = join(root, "nested-file-project");
	const directoryProject = join(root, "nested-directory-project");
	mkdirSync(fileProject, { recursive: true });
	mkdirSync(join(directoryProject, ".git"), { recursive: true });
	writeFileSync(join(fileProject, ".git"), "gitdir: ../linked-worktree\n");
	const fileMarkerLedger = join(fileProject, "heartbeat.md");
	const directoryMarkerLedger = join(directoryProject, "heartbeat.md");
	writeFileSync(
		fileMarkerLedger,
		ledger([
			["F1", "report:r1", "nested file marker", "done", "`receipt`", "[]"],
		]),
	);
	writeFileSync(
		directoryMarkerLedger,
		ledger([
			["D1", "report:r1", "nested directory marker", "done", "`receipt`", "[]"],
		]),
	);

	const automatic = await discoverHeartbeatLedgerSources({
		root,
		threadId: THREAD,
	});
	assert.deepEqual(
		automatic.candidates.map((candidate) => candidate.path),
		[realpathSync(rootLedger)],
	);
	assert.equal(automatic.complete, true);
	await assert.rejects(
		discoverHeartbeatLedgerSources({
			root,
			threadId: THREAD,
			ledgerPath: fileMarkerLedger,
		}),
		/nested Git project/i,
	);
	await assert.rejects(
		discoverHeartbeatLedgerSources({
			root,
			threadId: THREAD,
			ledgerPath: directoryMarkerLedger,
		}),
		/nested Git project/i,
	);
});

test("each discovery refreshes Git boundaries and confines explicit symlinks", async () => {
	const root = projectRoot();
	const outside = projectRoot();
	const directory = join(root, "docs", "nested");
	mkdirSync(directory, { recursive: true });
	const local = join(directory, "heartbeat.md");
	const external = join(outside, "heartbeat.md");
	const contents = `${ledger([["I1", "report:r1", "source", "done", "receipt", "[]"]])}\nthread: ${THREAD}\n`;
	writeFileSync(local, contents);
	writeFileSync(external, contents);
	symlinkSync(external, join(root, "linked.md"));
	const first = await discoverHeartbeatLedgerSources({ root, threadId: THREAD });
	assert.deepEqual(first.candidates, [{ path: realpathSync(local), associated: true }]);
	assert.equal(first.complete, true);
	await assert.rejects(
		discoverHeartbeatLedgerSources({ root, threadId: THREAD, ledgerPath: "linked.md" }),
		/within the project root/i,
	);
	writeFileSync(join(root, "docs", ".git"), "gitdir: elsewhere\n");
	const second = await discoverHeartbeatLedgerSources({ root, threadId: THREAD });
	assert.deepEqual(second.candidates, []);
	assert.equal(second.complete, true);
	await assert.rejects(
		discoverHeartbeatLedgerSources({ root, threadId: THREAD, ledgerPath: local }),
		/nested Git project/i,
	);
	rmSync(join(root, "docs", ".git"));
	const third = await discoverHeartbeatLedgerSources({ root, threadId: THREAD });
	assert.deepEqual(third.candidates, [{ path: realpathSync(local), associated: true }]);
	mkdirSync(join(directory, ".git"));
	const fourth = await discoverHeartbeatLedgerSources({ root, threadId: THREAD });
	assert.deepEqual(fourth.candidates, []);
	assert.equal(fourth.complete, true);
});


test("watch-protected discovery is shared across threads and invalidates on content and boundary changes", async () => {
	const root = projectRoot();
	const path = join(root, "heartbeat.md");
	const body = `${ledger([["I1", "report:r", "source", "done", "receipt", "[]"]])}\nthread: chat-A\n`;
	writeFileSync(path, body);
	const mtime = statSync(path).mtime;
	let changed;
	let scans = 0;
	let closed = false;
	const watcher = Object.assign(new EventEmitter(), { close() { closed = true; } });
	const index = new HeartbeatDiscoveryIndex({
		watchFactory(_root, _options, callback) { changed = callback; return watcher; },
		async scanFactory(options) { scans++; return discoverHeartbeatLedgerSources(options); },
	});
	try {
		const [a, b] = await Promise.all([
			index.discover({ root, threadId: "chat-A" }), index.discover({ root, threadId: "chat-B" }),
		]);
		assert.equal(scans, 1);
		assert.equal(a.candidates[0].associated, true);
		assert.equal(b.candidates[0].associated, false);
		const generation = await index.generation(root);
		writeFileSync(path, body.replace("chat-A", "chat-B"));
		utimesSync(path, mtime, mtime);
		changed("change", "heartbeat.md");
		assert.notEqual(await index.generation(root), generation);
		assert.equal((await index.discover({ root, threadId: "chat-B" })).candidates[0].associated, true);
		assert.equal(scans, 2);
		mkdirSync(join(root, "docs"));
		writeFileSync(join(root, "docs", ".git"), "gitdir: elsewhere\n");
		writeFileSync(join(root, "docs", "heartbeat.md"), body);
		changed("rename", "docs/.git");
		assert.equal((await index.discover({ root, threadId: "chat-A" })).candidates.length, 1);
		assert.equal(scans, 3);
	} finally { index.close(); }
	assert.equal(closed, true);
	await assert.rejects(index.discover({ root }), /closed/);
});

test("unavailable watcher never reuses discovery and in-flight invalidation retries", async () => {
	const root = projectRoot();
	writeFileSync(join(root, "heartbeat.md"), `${ledger([["I1", "report:r", "x", "done", "", "[]"]])}\nthread: A\n`);
	let scans = 0;
	const fallback = new HeartbeatDiscoveryIndex({
		watchFactory() { throw new Error("unsupported"); },
		async scanFactory(options) { scans++; return discoverHeartbeatLedgerSources(options); },
	});
	await fallback.discover({ root, threadId: "A" });
	await fallback.discover({ root, threadId: "A" });
	assert.equal(scans, 2);
	assert.equal(await fallback.generation(root), null);
	fallback.close();
	let changed;
	let release;
	const barrier = new Promise((resolve) => { release = resolve; });
	const watcher = Object.assign(new EventEmitter(), { close() {} });
	const indexed = new HeartbeatDiscoveryIndex({
		watchFactory(_root, _options, callback) { changed = callback; return watcher; },
		async scanFactory(options) {
			const report = await discoverHeartbeatLedgerSources(options);
			if (++scans === 3) await barrier;
			return report;
		},
	});
	const pending = indexed.discover({ root, threadId: "A" });
	while (!changed) await new Promise((resolve) => setImmediate(resolve));
	changed("change", "heartbeat.md");
	release();
	await pending;
	assert.equal(scans, 4);
	watcher.emit("error", new Error("watch lost"));
	assert.equal(await indexed.generation(root), null);
	indexed.close();
});


test("index isolates bounds and roots, and reports creates, removals and renames", async () => {
	const root = projectRoot();
	const other = projectRoot();
	let scans = 0;
	const callbacks = new Map();
	const watchers = [];
	const index = new HeartbeatDiscoveryIndex({
		watchFactory(path, _options, callback) {
			const w = Object.assign(new EventEmitter(), { closed: false, close() { this.closed = true; } });
			watchers.push(w); callbacks.set(path, callback); return w;
		},
		async scanFactory(options) { scans++; return discoverHeartbeatLedgerSources(options); },
		maxEntries: 2,
	});
	try {
		await index.discover({ root, maxFiles: 2 });
		await index.discover({ root, maxFiles: 3 });
		assert.equal(scans, 2);
		const file = join(root, "heartbeat.md");
		writeFileSync(file, `${ledger([["I", "source", "one", "done", "", "[]"]])}\nthread: A\n`);
		callbacks.get(root)("rename", "heartbeat.md");
		assert.equal((await index.discover({ root, maxFiles: 2 })).candidates.length, 1);
		assert.equal((await index.discover({ root, maxFiles: 3 })).candidates.length, 1);
		rmSync(file);
		callbacks.get(root)("rename", "heartbeat.md");
		assert.equal((await index.discover({ root, maxFiles: 2 })).candidates.length, 0);
		await index.discover({ root: other });
		assert.ok(watchers.some((watcher) => watcher.closed));
	} finally { index.close(); }
	assert.ok(watchers.every((watcher) => watcher.closed));
});


test("automatic scans exclude .tmp but explicit .tmp ledgers are always read fresh", async () => {
	const root = projectRoot();
	const tmp = join(root, ".tmp", "codex-task-progress", "cache");
	mkdirSync(tmp, { recursive: true });
	const path = join(tmp, "heartbeat.md");
	const first = `${ledger([["I", "source", "one", "done", "", "[]"]])}\nthread: chat-A\n`;
	writeFileSync(path, first);
	let changed;
	let scans = 0;
	const watcher = Object.assign(new EventEmitter(), { close() {} });
	const index = new HeartbeatDiscoveryIndex({
		watchFactory(_root, _options, callback) { changed = callback; return watcher; },
		async scanFactory(options) { scans++; return discoverHeartbeatLedgerSources(options); },
	});
	try {
		assert.equal((await index.discover({ root })).candidates.length, 0);
		changed("change", ".tmp/codex-task-progress/cache/heartbeat.md");
		await index.discover({ root });
		assert.equal(scans, 1);
		assert.equal((await index.discover({ root, ledgerPath: path, threadId: "chat-A" })).candidates[0].associated, true);
		writeFileSync(path, first.replace("chat-A", "chat-B"));
		assert.equal((await index.discover({ root, ledgerPath: path, threadId: "chat-B" })).candidates[0].associated, true);
		assert.equal(scans, 3);
		const cacheName = join(root, "fake.snapshot.json");
		mkdirSync(cacheName);
		writeFileSync(join(cacheName, "heartbeat.md"), first);
		changed("rename", "fake.snapshot.json");
		assert.equal((await index.discover({ root })).candidates.length, 1);
		rmSync(cacheName, { recursive: true });
		changed("rename", "fake.snapshot.json");
		assert.equal((await index.discover({ root })).candidates.length, 0);
	} finally { index.close(); }
});

test("unexpected watcher closure discards protected discovery", async () => {
	const root = projectRoot();
	let scans = 0;
	let watchCount = 0;
	const watchers = [];
	const index = new HeartbeatDiscoveryIndex({
		watchFactory() {
			watchCount++;
			const watcher = Object.assign(new EventEmitter(), { close() {} });
			watchers.push(watcher);
			return watcher;
		},
		async scanFactory(options) { scans++; return discoverHeartbeatLedgerSources(options); },
	});
	try {
		await index.discover({ root });
		watchers[0].emit("close");
		assert.equal(await index.generation(root), null);
		await index.discover({ root });
		assert.equal(scans, 2);
		assert.equal(watchCount, 2);
	} finally { index.close(); }
});

test("force discovery rejects a cached negative without a watcher event", async () => {
	const root = projectRoot();
	const watcher = Object.assign(new EventEmitter(), { close() {} });
	const index = new HeartbeatDiscoveryIndex({ watchFactory() { return watcher; } });
	try {
		assert.equal((await index.discover({ root, threadId: "chat-A" })).candidates.length, 0);
		writeFileSync(join(root, "heartbeat.md"), `${ledger([["I", "source", "one", "done", "", "[]"]])}\nthread: chat-A\n`);
		assert.equal((await index.discover({ root, threadId: "chat-A" })).candidates.length, 0);
		const fresh = await index.discover({ root, threadId: "chat-A" }, { force: true });
		assert.equal(fresh.candidates[0].associated, true);
	} finally { index.close(); }
});


test("bound-only discovery uses canonical parsing without enumerating the project", async () => {
	const root = projectRoot();
	const nested = join(root, ".workspace", "deep");
	mkdirSync(nested, { recursive: true });
	const path = join(nested, "notes.md");
	writeFileSync(path, `${ledger([["I", "source", "one", "done", "", "[]"]])}\nthread: ${THREAD}\n`);
	const original = fs.promises.readdir;
	let reads = 0;
	try {
		fs.promises.readdir = async (...args) => { reads++; return original(...args); };
		syncBuiltinESMExports();
		const result = await discoverBoundHeartbeatSource({ root, threadId: THREAD, ledgerPath: path, maxFiles: 1, maxDepth: 0 });
		assert.equal(reads, 0);
		assert.equal(result.complete, false);
		assert.deepEqual(result.reasons, ["source-only"]);
		assert.equal(result.visitedFiles, 1);
		assert.equal(result.boundSourceDigest, createHash("sha256").update(await fs.promises.readFile(path, "utf8")).digest("hex"));
		assert.deepEqual(result.candidates, [{ path: realpathSync(path), associated: true }]);
	} finally { fs.promises.readdir = original; syncBuiltinESMExports(); }
});

test("bound-only discovery enforces symlink, nested Git, companion, and exact association boundaries", async () => {
	const root = projectRoot();
	const outside = projectRoot();
	const nested = join(root, "nested");
	mkdirSync(nested);
	const source = join(root, "heartbeat.md");
	const content = `${ledger([["I", "source", "one", "done", "", "[]"]])}\nthread: ${THREAD}\n`;
	writeFileSync(source, content);
	assert.equal((await discoverBoundHeartbeatSource({ root, threadId: `${THREAD}-other`, ledgerPath: source })).candidates[0].associated, false);
	writeFileSync(join(outside, "heartbeat.md"), content);
	symlinkSync(join(outside, "heartbeat.md"), join(root, "link.md"));
	await assert.rejects(discoverBoundHeartbeatSource({ root, ledgerPath: "link.md" }), /within the project root/);
	writeFileSync(join(nested, ".git"), "gitdir: other\n");
	writeFileSync(join(nested, "heartbeat.md"), content);
	await assert.rejects(discoverBoundHeartbeatSource({ root, ledgerPath: join(nested, "heartbeat.md") }), /nested Git project/);
	await assert.rejects(discoverBoundHeartbeatSource({ root, ledgerPath: "taskhistory.md" }), /cannot be selected/);
	await assert.rejects(discoverBoundHeartbeatSource({ root, ledgerPath: "missing.md" }), /cannot be resolved/);
});


test("watch filtering ignores unrelated regular code content but retries conservatively during replacement scans", async () => {
	const root = projectRoot();
	const code = join(root, "source.ts");
	writeFileSync(code, "first");
	writeFileSync(join(root, "heartbeat.md"), `${ledger([["I", "source", "one", "done", "", "[]"]])}\nthread: ${THREAD}\n`);
	let changed;
	let scans = 0;
	let inject = false;
	const watcher = Object.assign(new EventEmitter(), { close() {} });
	const index = new HeartbeatDiscoveryIndex({
		watchFactory(_root, _options, callback) { changed = callback; return watcher; },
		async scanFactory(options) {
			scans++;
			const operation = discoverHeartbeatLedgerSources(options);
			if (inject) {
				inject = false;
				queueMicrotask(() => { writeFileSync(code, "updated"); changed("change", "source.ts"); });
			}
			return operation;
		},
	});
	try {
		const first = await index.discover({ root, threadId: THREAD });
		const generation = await index.generation(root);
		writeFileSync(code, "edited");
		changed("change", "source.ts");
		const reused = await index.discover({ root, threadId: THREAD });
		assert.equal(scans, 1);
		assert.equal(await index.generation(root), generation);
		assert.deepEqual(reused.candidates, first.candidates);
		// A regular file not present in the previous scan is still harmless when
		// it is neither an observed directory nor an alias of any source.
		writeFileSync(join(root, "previously-untracked.ts"), "code");
		changed("change", "previously-untracked.ts");
		await index.discover({ root });
		assert.equal(scans, 1);
		inject = true;
		await index.discover({ root, threadId: THREAD }, { force: true });
		assert.equal(scans, 3, "replacement scans cannot rely on the invalidated snapshot's proof");
		inject = false;
		changed("rename", "source.ts");
		await index.discover({ root });
		assert.equal(scans, 4, "rename remains conservative");
		changed("change", null);
		await index.discover({ root });
		assert.equal(scans, 5, "unknown filenames remain conservative");
	} finally { index.close(); }
});

test("watch filtering rejects markdown, explicit non-md, hardlink, Git, and structural changes", async () => {
	const root = projectRoot();
	const content = `${ledger([["I", "source", "one", "done", "", "[]"]])}\nthread: ${THREAD}\n`;
	const md = join(root, "heartbeat.md");
	const explicit = join(root, "explicit.data");
	writeFileSync(md, content);
	writeFileSync(explicit, content);
	linkSync(explicit, join(root, "explicit-alias.ts"));
	linkSync(md, join(root, "alias.ts"));
	mkdirSync(join(root, "directory.ts"));
	let changed;
	let scans = 0;
	const watcher = Object.assign(new EventEmitter(), { close() {} });
	const index = new HeartbeatDiscoveryIndex({
		watchFactory(_root, _options, callback) { changed = callback; return watcher; },
		async scanFactory(options) { scans++; return discoverHeartbeatLedgerSources(options); },
	});
	try {
		await index.discover({ root, threadId: THREAD });
		await index.discover({ root, threadId: THREAD, ledgerPath: explicit });
		assert.equal(scans, 2);
		writeFileSync(join(root, "alias.ts"), content.replace(THREAD, "other-thread"));
		changed("change", "alias.ts");
		const afterHardlink = await index.discover({ root, threadId: THREAD });
		assert.equal(afterHardlink.candidates.find((candidate) => candidate.path === md)?.associated, false);
		assert.equal(scans, 3);
		await index.discover({ root, threadId: THREAD, ledgerPath: explicit });
		writeFileSync(join(root, "explicit-alias.ts"), content.replace(THREAD, "other-thread"));
		changed("change", "explicit-alias.ts");
		const afterExplicit = await index.discover({ root, threadId: THREAD, ledgerPath: explicit });
		assert.equal(afterExplicit.candidates.find((candidate) => candidate.path === explicit)?.associated, false);
		const afterExplicitScans = scans;
		writeFileSync(md, content);
		changed("change", "heartbeat.md");
		assert.equal((await index.discover({ root, threadId: THREAD })).candidates.find((candidate) => candidate.path === md)?.associated, true);
		assert.equal(scans, afterExplicitScans + 1);
		rmSync(join(root, "directory.ts"), { recursive: true });
		writeFileSync(join(root, "directory.ts"), "file replacement");
		changed("change", "directory.ts");
		await index.discover({ root });
		assert.equal(scans, afterExplicitScans + 2);
		mkdirSync(join(root, "nested"));
		writeFileSync(join(root, "nested", ".git"), "gitdir: elsewhere\n");
		changed("change", "nested/.git");
		await index.discover({ root });
		assert.equal(scans, afterExplicitScans + 3);
		symlinkSync(md, join(root, "linked.ts"));
		changed("rename", "linked.ts");
		await index.discover({ root });
		assert.equal(scans, afterExplicitScans + 4);
	} finally { index.close(); }
});

test("watch filtering fails closed when scan metadata is unavailable", async () => {
	const root = projectRoot();
	writeFileSync(join(root, "source.ts"), "code");
	let changed;
	let scans = 0;
	const watcher = Object.assign(new EventEmitter(), { close() {} });
	const index = new HeartbeatDiscoveryIndex({
		watchFactory(_root, _options, callback) { changed = callback; return watcher; },
		async scanFactory(options) {
			scans++;
			// A noncanonical/custom scanner that cannot supply directory proof
			// must never authorize filtering based on an empty set.
			const withoutDirectoryProof = { ...options };
			delete withoutDirectoryProof.collectObservedDirectory;
			return discoverHeartbeatLedgerSources(withoutDirectoryProof);
		},
	});
	try {
		await index.discover({ root });
		writeFileSync(join(root, "source.ts"), "new code");
		changed("change", "source.ts");
		await index.discover({ root });
		assert.equal(scans, 2);
	} finally { index.close(); }
});


test("new Markdown hardlink changed through its non-Markdown alias invalidates an in-flight replacement scan", async () => {
	const root = projectRoot();
	const alias = join(root, "alias.ts");
	const head = join(root, "heartbeat.md");
	const content = `${ledger([["I", "source", "one", "done", "", "[]"]])}\nthread: ${THREAD}\n`;
	writeFileSync(alias, content);
	let changed;
	let scans = 0;
	let holdNext = false;
	let markScanned;
	let releaseScan;
	const scanned = new Promise((resolve) => { markScanned = resolve; });
	const release = new Promise((resolve) => { releaseScan = resolve; });
	const watcher = Object.assign(new EventEmitter(), { close() {} });
	const index = new HeartbeatDiscoveryIndex({
		watchFactory(_root, _options, callback) { changed = callback; return watcher; },
		async scanFactory(options) {
			scans++;
			const report = await discoverHeartbeatLedgerSources(options);
			if (holdNext) { holdNext = false; markScanned(); await release; }
			return report;
		},
	});
	try {
		assert.equal((await index.discover({ root, threadId: THREAD })).candidates.length, 0);
		linkSync(alias, head);
		changed("rename", "heartbeat.md");
		holdNext = true;
		const pending = index.discover({ root, threadId: THREAD });
		await scanned;
		writeFileSync(alias, content.replace(THREAD, "other-thread"));
		changed("change", "alias.ts");
		releaseScan();
		const result = await pending;
		assert.equal(scans, 3);
		assert.equal(result.candidates[0]?.path, head);
		assert.equal(result.candidates[0]?.associated, false);
	} finally { releaseScan(); index.close(); }
});
