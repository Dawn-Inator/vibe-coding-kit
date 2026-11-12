import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	discoverHeartbeatLedgers,
	projectHeartbeatTask,
} from "../../src/tasks/heartbeat-task-source.mjs";
import { inspectHeartbeatLedger } from "../../src/supervision/heartbeat-ledger-api.mjs";
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
	return mkdtempTracked("heartbeat-task-source-");
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
	const invalidWake = join(root, "docs", "invalid-wake.md");
	const markerOnly = join(root, "docs", "marker-only.md");
	const fencedWake = join(root, "docs", "fenced-wake.md");
	const legacy8 = join(root, "docs", "legacy-8.md");
	const legacy10 = join(root, "docs", "legacy-10.md");
	writeFileSync(
		workspaceLedger,
		`${ledger([["I1", "report:r1", "check status", "done", "`receipt`", "[]"]])}\nthread: ${THREAD}\n`,
	);
	writeFileSync(
		todoLedger,
		ledger([["I2", "report:r2", "unrelated", "done", "`receipt`", "[]"]]),
	);
	writeFileSync(
		fenced,
		`\`\`\`md\n${ledger([["I3", "report:r3", THREAD, "done", "`receipt`", "[]"]])}\n\`\`\`\n`,
	);
	writeFileSync(invalidWake, "# API\ncontract: heartbeat/v2\n## not-a-time wake (10-row ledger)\n");
	writeFileSync(markerOnly, "# Example\ncontract: heartbeat/v2\n");
	writeFileSync(fencedWake, "```md\n## 2026-01-01T10:00Z wake (10-row ledger)\n```\n");
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
		[canonicalTodo, canonicalWorkspace, canonicalLegacy8, canonicalLegacy10].sort(),
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
