import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
	symlinkSync,
	appendFileSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
	appendHeartbeatWake,
	createHeartbeatLedgerPair,
	heartbeatLedgerPairPaths,
	inspectHeartbeatLedgerPair,
	migrateHeartbeatLedgerPair,
	readHeartbeatLedgerPair,
	readHeartbeatDisplay,
	readHeartbeatDiscoveryHead,
	clearHeartbeatDisplayCache,
	readHeartbeatLedgerPairVersion,
	recoverHeartbeatLedgerPair,
	recordHeartbeatAgentAssignments,
	writeHeartbeatLedgerPair,
} from "../../src/supervision/heartbeat-ledger-files.mjs";
import {
	discoverHeartbeatLedgers,
	discoverBoundHeartbeatSource,
	parseHeartbeatTaskRoot,
	projectHeartbeatTask,
} from "../../src/tasks/heartbeat-task-source.mjs";
import { inspectHeartbeatLedger } from "../../src/supervision/heartbeat-ledger-api.mjs";
import { readProjectHeartbeat } from "../../src/tasks/project-heartbeat.mjs";
import { atomicWriteFileSync } from "../../src/tasks/task-io.mjs";
import { cleanupTempDirs, mkdtempTracked } from "../support/temp-dirs.mjs";

after(cleanupTempDirs);

const wake = (time, extra = "") =>
	`## ${time} wake (10-row ledger)\nsources: x(ok)\n${extra}`;
const root = () => mkdtempTracked("heartbeat-pair-");
const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "../../src/supervision/check-heartbeat-ledger.mjs");
const DUE = join(HERE, "../../src/supervision/heartbeat-audit-due-cli.mjs");

const version = (path) => {
	const { historyPath } = heartbeatLedgerPairPaths(path);
	return createHash("sha256")
		.update(
			`${readFileSync(path, "utf8")}\0${existsSync(historyPath) ? readFileSync(historyPath, "utf8") : ""}`,
		)
		.digest("hex");
};
const migrate = (options) =>
	migrateHeartbeatLedgerPair({
		...options,
		legacyWritersQuiescent: true,
		expectedContentHash: version(options.path),
	});
const append = (options) =>
	appendHeartbeatWake({
		...options,
		legacyWritersQuiescent: true,
		expectedContentHash: version(options.path),
	});
const write = (options) =>
	writeHeartbeatLedgerPair({
		...options,
		legacyWritersQuiescent: true,
		expectedContentHash: version(options.path),
	});

const registry = (row) =>
	`## Items\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n${row}\n`;
const invalidRows = [
	"| R1 | user-2026-11-21 | task | unknown | pending |",
	"| R1 | owner:intake.md | task | blocked | pending |",
	"| R1 | owner:intake.md | task | unknwon | pending |",
	"| R1 | owner:intake.md | task | done | - |",
];
const pairBytes = (path) => Object.values(heartbeatLedgerPairPaths(path))
	.map((file) => readFileSync(file, "utf8"));

test("validated creation rejects illegal candidates before creating any ledger file", () => {
	for (const row of invalidRows) {
		const dir = root();
		const path = join(dir, "heartbeat.md");
		assert.throws(() => createHeartbeatLedgerPair({
			root: dir, path, legacyWritersQuiescent: true,
			text: `${registry(row)}\n${wake("2026-01-01T10:00Z")}`,
			beforeHeadPublish() { assert.fail("invalid content must never reach publication"); },
		}), (error) => error.code === "HEARTBEAT_LEDGER_INVALID" && error.findings.length > 0);
		for (const file of [...Object.values(heartbeatLedgerPairPaths(path)), `${path}.lock`])
			assert.equal(existsSync(file), false, file);
	}
});

test("validated creation preserves unknown, initializes a readable pair, and never overwrites existing data", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const text = `${registry("| R1 | owner:intake.md | pending work | unknown | not assessed |")}\n${wake("2026-01-01T10:00Z")}`;
	const options = { root: dir, path, text, legacyWritersQuiescent: true };
	assert.throws(() => createHeartbeatLedgerPair({ ...options, legacyWritersQuiescent: false }), /exclusive ownership/i);
	const created = createHeartbeatLedgerPair(options);
	assert.equal(created.isLegacy, false);
	assert.deepEqual(readHeartbeatLedgerPair({ root: dir, path }), created);
	assert.equal(inspectHeartbeatLedgerPair(created, { mode: "format" }).passed, true);
	assert.equal(inspectHeartbeatLedgerPair(created, { mode: "format" }).certifiesCurrent, false);
	assert.equal(inspectHeartbeatLedgerPair(created, { mode: "format" }).items[0].status, "unknown");
	assert.equal(readFileSync(heartbeatLedgerPairPaths(path).legacyBackupPath, "utf8"), text);
	const before = pairBytes(path);
	assert.throws(() => createHeartbeatLedgerPair(options), /absent|exists/i);
	assert.deepEqual(pairBytes(path), before);
});

test("creation respects project boundaries and refuses orphaned companions without publishing a head", () => {
	const dir = root();
	const outside = root();
	const text = wake("2026-01-01T10:00Z");
	const create = (path) => createHeartbeatLedgerPair({ root: dir, path, text, legacyWritersQuiescent: true });
	assert.throws(() => create(join(outside, "heartbeat.md")), /within the project root/i);
	const nested = join(dir, "nested");
	mkdirSync(nested);
	writeFileSync(join(nested, ".git"), "gitdir: elsewhere");
	assert.throws(() => create(join(nested, "heartbeat.md")), /nested Git/i);
	const path = join(dir, "heartbeat.md");
	const { historyPath } = heartbeatLedgerPairPaths(path);
	writeFileSync(historyPath, "orphaned history");
	assert.throws(() => create(path), /absent/i);
	assert.equal(existsSync(path), false);
	assert.equal(readFileSync(historyPath, "utf8"), "orphaned history");
});

test("an interrupted validated creation leaves a recoverable valid source", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const text = `${registry("| R1 | owner:intake.md | pending work | unknown | pending |")}\n${wake("2026-01-01T10:00Z")}`;
	assert.throws(() => createHeartbeatLedgerPair({
		root: dir, path, text, legacyWritersQuiescent: true,
		beforeHeadPublish() { throw new Error("creation interrupted"); },
	}), /creation interrupted/);
	assert.equal(readFileSync(path, "utf8"), text);
	assert.equal(inspectHeartbeatLedger(readFileSync(path, "utf8"), { mode: "format" }).passed, true);
	const recovered = recoverHeartbeatLedgerPair({ root: dir, path, legacyWritersQuiescent: true, expectedContentHash: version(path) });
	assert.equal(inspectHeartbeatLedgerPair(recovered, { mode: "format" }).passed, true);
	assert.equal(inspectHeartbeatLedgerPair(recovered, { mode: "format" }).items[0].status, "unknown");
});

test("invalid updates and appends leave head, history, and backup byte-for-byte unchanged", () => {
	for (const row of invalidRows) {
		const dir = root();
		const path = join(dir, "heartbeat.md");
		createHeartbeatLedgerPair({ root: dir, path, text: wake("2026-01-01T10:00Z"), legacyWritersQuiescent: true });
		const before = pairBytes(path);
		const candidate = `${registry(row)}\n${wake("2026-01-01T11:00Z")}`;
		for (const publish of [
			() => write({ root: dir, path, text: candidate }),
			() => append({ root: dir, path, wakeText: candidate }),
		]) {
			assert.throws(publish, { code: "HEARTBEAT_LEDGER_INVALID" });
			assert.deepEqual(pairBytes(path), before);
			assert.equal(existsSync(`${path}.lock`), false);
		}
		const fixed = write({ root: dir, path, text: candidate.replace(row, "| R1 | owner:intake.md | task | unknown | pending |") });
		assert.equal(inspectHeartbeatLedgerPair(fixed, { mode: "format" }).passed, true);
	}
});

test("invalid historical bytes remain migratable and recoverable without weakening ordinary writes", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const original = `${registry(invalidRows[0])}\n${wake("2026-01-01T10:00Z")}`;
	writeFileSync(path, original);
	assert.throws(() => migrate({ root: dir, path, beforeHeadPublish() { throw new Error("interrupted migration"); } }), /interrupted migration/);
	const recovered = recoverHeartbeatLedgerPair({ root: dir, path, legacyWritersQuiescent: true, expectedContentHash: version(path) });
	assert.equal(readFileSync(heartbeatLedgerPairPaths(path).legacyBackupPath, "utf8"), original);
	assert.equal(inspectHeartbeatLedgerPair(recovered, { mode: "format" }).passed, false);
	const before = pairBytes(path);
	assert.throws(() => append({ root: dir, path, wakeText: wake("2026-01-01T11:00Z") }), { code: "HEARTBEAT_LEDGER_INVALID" });
	assert.deepEqual(pairBytes(path), before);
});

test("migration preserves every original byte in immutable backup and retains wake count/order", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const legacy = `# handoff notes\nprelude stays\n\n${wake("2026-01-01T10:00Z")}\n----\n${wake("2026-01-01T11:00Z")}\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I1 | report:r1 | active | done | receipt |\n`;
	writeFileSync(path, legacy);
	const first = migrate({ root: dir, path });
	assert.equal(
		readFileSync(heartbeatLedgerPairPaths(path).legacyBackupPath, "utf8"),
		legacy,
	);
	assert.equal(first.isLegacy, false);
	assert.equal(
		(first.fullText.match(/wake \(10-row ledger\)/g) ?? []).length,
		2,
	);
	assert.deepEqual(migrate({ root: dir, path }), first);
	assert.equal(readFileSync(path, "utf8").includes("prelude stays"), true);
	assert.equal(readFileSync(path, "utf8").includes("| I1 |"), true);
});

test("migration preserves head permissions, restricts new archive files, and failed atomic publish leaves old bytes", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	writeFileSync(path, wake("2026-01-01T10:00Z"));
	chmodSync(path, 0o640);
	const paths = heartbeatLedgerPairPaths(path);
	migrate({ root: dir, path });
	assert.equal(statSync(path).mode & 0o777, 0o640);
	assert.equal(statSync(paths.legacyBackupPath).mode & 0o777, 0o600);
	assert.equal(statSync(paths.historyPath).mode & 0o777, 0o600);
	const before = readFileSync(path, "utf8");
	assert.throws(
		() =>
			atomicWriteFileSync(path, "partial replacement", {
				mode: 0o640,
				beforeRename() {
					throw new Error("injected publish failure");
				},
			}),
		/injected publish failure/,
	);
	assert.equal(readFileSync(path, "utf8"), before);
	assert.equal(statSync(path).mode & 0o777, 0o640);
});

test("same-folder custom heads receive isolated companion histories", () => {
	const dir = root();
	const a = join(dir, "A.md");
	const b = join(dir, "B.md");
	writeFileSync(a, wake("2026-01-01T10:00Z"));
	writeFileSync(b, wake("2026-01-01T11:00Z"));
	const first = migrate({ root: dir, path: a });
	const second = migrate({ root: dir, path: b });
	assert.equal(first.historyPath, join(realpathSync(dir), "A.taskhistory.md"));
	assert.equal(second.historyPath, join(realpathSync(dir), "B.taskhistory.md"));
	assert.notEqual(first.historyPath, second.historyPath);
});

test("identical legitimate wakes remain distinct and writer keeps all history plus current Items", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const repeated = wake("2026-01-01T10:00Z");
	writeFileSync(
		path,
		`${repeated}\n----\n${repeated}\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I1 | report:r1 | task | done | receipt |\n`,
	);
	let pair = migrate({ root: dir, path });
	assert.equal(
		(pair.fullText.match(/wake \(10-row ledger\)/g) ?? []).length,
		2,
	);
	pair = append({ root: dir, path, wakeText: wake("2026-01-01T12:00Z") });
	assert.equal(
		(pair.fullText.match(/wake \(10-row ledger\)/g) ?? []).length,
		3,
	);
	assert.match(pair.headText, /\| I1 \|/);
	assert.equal(
		inspectHeartbeatLedgerPair(pair, { mode: "items" }).itemCount,
		1,
	);
	const rewritten = write({
		root: dir,
		path,
		text: `${wake("2026-01-01T13:00Z")}\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I2 | report:r2 | next | done | receipt |\n`,
	});
	assert.equal(
		(rewritten.fullText.match(/wake \(10-row ledger\)/g) ?? []).length,
		4,
	);
	assert.equal(
		inspectHeartbeatLedgerPair(rewritten, { mode: "items" }).items[0].id,
		"I2",
	);
});

const assignmentHeader = "| id | source | item | status | evidence | owner | dispatch_ref | children | note | repository | worktree | mode | write_set |";
const assignmentSeparator = "| --- | --- | --- | --- | --- | --- | --- | --- | :---: | --- | --- | --- | --- |";
const reportedRef = "receipts/first returned.json";
const assignmentRows = [
	`| I1 | report:r1 | first | dispatched | observed | /root/first | ${reportedRef} | [] | retained |  `,
	"| I2 | report:r2 | second | done | historical evidence | legacy owner | | - | 例 |",
	"| I3 | report:r3 | third | blocked <- review | dependency | old owner | - | | untargeted |",
	'| P1 | report:p1 | parent | tracking | coordination | /root | - | ["I1"] | parent note |',
	'| P2 | report:p2 | second parent | tracking | coordination | /root | - | ["I2"] | parent note |',
].map((row) => `${row.trimEnd()} /repo | /tree | read-only | [] |`);

function assignmentFixture({ header = assignmentHeader, separator = assignmentSeparator, rows = assignmentRows, extra = "", crlf = false } = {}) {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const old = `# Project\n\n## Items\n\n${header}\n${separator}\n${rows.join("\n")}\n${extra}\n## Notes\nUnrelated text stays.\n\n${wake("2026-01-01T10:00Z")}\n${wake("2026-01-01T11:00Z")}`;
	const original = crlf ? old.replaceAll("\n", "\r\n") : old;
	writeFileSync(path, original);
	const prior = migrate({ root: dir, path });
	const request = {
		root: dir,
		path,
		legacyWritersQuiescent: true,
		expectedContentHash: prior.contentHash,
	};
	return { dir, path, original, prior, request };
}

const firstAgentAssignment = {
	itemId: "I1",
	agentThreadId: "native-thread-01",
	expectedDispatchRef: reportedRef,
};

test("assignment publication cannot carry an invalid legacy registry into a new head", () => {
	const { path, prior, request } = assignmentFixture({
		rows: assignmentRows.map((row) => row.replace("report:r3", "user-2026-11-21")),
	});
	const before = pairBytes(path);
	assert.throws(() => recordHeartbeatAgentAssignments({
		...request, assignments: [firstAgentAssignment],
		beforeHeadPublish() { assert.fail("invalid registry must not be published"); },
	}), { code: "HEARTBEAT_LEDGER_INVALID" });
	assert.deepEqual(pairBytes(path), before);
	assert.deepEqual(readHeartbeatLedgerPair(request), prior);
});

test("mechanical assignments preserve the canonical CRLF head outside the new cells and keep archive and backup bytes", async () => {
	const { path, original, prior, request } = assignmentFixture({ crlf: true });
	const assignments = [
		firstAgentAssignment,
		{ itemId: "I2", agentThreadId: "native-thread-02", expectedDispatchRef: "" },
		{ itemId: "I3", agentThreadId: "native-thread-02", expectedDispatchRef: "-" },
	];
	const after = recordHeartbeatAgentAssignments({ ...request, assignments });
	assert.equal(
		after.headText,
		prior.headText
			.replace("| children | note |", "| children | agent_thread_id | note |")
			.replace("| --- | :---: |", "| --- | --- | :---: |")
			.replace("| [] | retained |", "| [] | native-thread-01 | retained |")
			.replace("| - | 例 |", "| - | native-thread-02 | 例 |")
			.replace("| | untargeted |", "| | native-thread-02 | untargeted |")
			.replace('| ["I1"] | parent note |', '| ["I1"] |  | parent note |')
			.replace('| ["I2"] | parent note |', '| ["I2"] |  | parent note |'),
	);
	assert.deepEqual(readHeartbeatLedgerPair(request), after);
	assert.notEqual(after.contentHash, prior.contentHash);
	assert.equal(after.fullText, prior.fullText);
	assert.deepEqual(after.wakes, prior.wakes);
	assert.equal(readFileSync(heartbeatLedgerPairPaths(path).legacyBackupPath, "utf8"), original);
	const afterItems = inspectHeartbeatLedgerPair(after, { mode: "items" }).items;
	assert.deepEqual(afterItems.map(({ agent_thread_id }) => agent_thread_id), [
		"native-thread-01", "native-thread-02", "native-thread-02", "", "",
	]);
	assert.deepEqual(
		afterItems.map(({ agent_thread_id, ...row }) => row),
		inspectHeartbeatLedgerPair(prior, { mode: "items" }).items,
	);
	const display = await readHeartbeatDisplay(request);
	assert.deepEqual(display.inventory.items.map(({ agent_thread_id }) => agent_thread_id),
		afterItems.map(({ agent_thread_id }) => agent_thread_id));
	assert.equal(display.historyPage.total, prior.wakes.length);
	assert.throws(() => recordHeartbeatAgentAssignments({ ...request, assignments }), /version conflict/i);
	assert.deepEqual(recordHeartbeatAgentAssignments({
		...request, expectedContentHash: after.contentHash, assignments,
		beforeHeadPublish() { assert.fail("an idempotent assignment must not publish"); },
	}), after);
	const appended = append({ ...request, wakeText: wake("2026-01-01T12:00Z") });
	assert.equal(appended.wakes.length, prior.wakes.length + 1);
	assert.deepEqual(inspectHeartbeatLedgerPair(appended, { mode: "items" }).items, afterItems);
});

test("assignment writes add their column immediately after dispatch_ref on tables without children", () => {
	const { request, prior } = assignmentFixture({
		header: assignmentHeader.replace(" children |", ""),
		separator: assignmentSeparator.replace(" --- | :---: |", " :---: |"),
		rows: [
			`| I1 | report:r1 | first | dispatched | observed | /root/first | ${reportedRef} | retained | /repo | /tree | read-only | [] |`,
		],
	});
	const after = recordHeartbeatAgentAssignments({ ...request, assignments: [firstAgentAssignment] });
	assert.match(after.headText, /\| dispatch_ref \| agent_thread_id \| note \|/);
	assert.equal(after.fullText, prior.fullText);
});

test("bound assignment rejects missing or changed references and protects existing native IDs", () => {
	const { request, prior } = assignmentFixture();
	const record = (assignments, pair = prior) => recordHeartbeatAgentAssignments({
		...request, expectedContentHash: pair.contentHash, assignments,
	});
	assert.throws(() => record([{ itemId: "I2", agentThreadId: "native-thread-02" }]), /dispatch_ref/i);
	for (const expectedDispatchRef of [undefined, null, " ", "unknown", "bad|ref", "-", "different.json"]) {
		assert.throws(() => record([{ ...firstAgentAssignment, expectedDispatchRef }]), /dispatch_ref/i);
	}
	for (const [itemId, expectedDispatchRef] of [["I2", "-"], ["I3", ""]]) {
		assert.throws(() => record([{ ...firstAgentAssignment, itemId, expectedDispatchRef }]), /dispatch_ref conflict/i);
	}
	for (const agentThreadId of ["", "—", "--", "tbd", "bad|agent", "bad\nagent", "bad\0agent", "bad agent", "bad\\agent", "<agent>", "\ud800"]) {
		assert.throws(() => record([{ ...firstAgentAssignment, agentThreadId }]), /native thread ID/i);
	}
	for (const itemId of ["P1", "P2"]) {
		assert.throws(() => record([{ ...firstAgentAssignment, itemId, expectedDispatchRef: "-" }]), /leaf/i);
	}
	assert.throws(() => record([firstAgentAssignment, { ...firstAgentAssignment, itemId: "i1" }]), /does not exist/i);
	assert.throws(() => record([firstAgentAssignment, firstAgentAssignment]), /duplicate/i);
	assert.throws(() => record([]), /nonempty/i);
	assert.deepEqual(readHeartbeatLedgerPair(request), prior);
	const assigned = record([firstAgentAssignment]);
	const replacement = { ...firstAgentAssignment, agentThreadId: "native-thread-03" };
	assert.throws(() => record([replacement], assigned), /agent_thread_id conflict/i);
	assert.throws(() => record([{ ...replacement, expectedAgentThreadId: "some-other" }], assigned), /agent_thread_id conflict/i);
	assert.deepEqual(readHeartbeatLedgerPair(request), assigned);
	const replaced = record([{ ...replacement, expectedAgentThreadId: firstAgentAssignment.agentThreadId }], assigned);
	assert.equal(replaced.headText, assigned.headText.replace("native-thread-01", "native-thread-03"));
	assert.equal(replaced.fullText, assigned.fullText);
	const added = record([{ itemId: "I2", agentThreadId: "native-thread-02", expectedDispatchRef: "" }], replaced);
	assert.equal(added.headText, replaced.headText.replace("| - |  | 例 |", "| - | native-thread-02 | 例 |"));
});

test("assignment refuses malformed or ambiguous Items and cannot bypass canonical writer ownership or the lock", () => {
	for (const [variant, failure] of [
		[{ extra: "## Items\nno table" }, /unambiguous/i],
		[{ header: assignmentHeader.replace("note", "agent_thread_id | Agent Thread ID") }, /headers/i],
		[{ separator: assignmentSeparator.replace(":---:", "malformed") }, /malformed/i],
		[{ rows: [...assignmentRows, assignmentRows[0]] }, /duplicate/i],
		[{ rows: [...assignmentRows, "| bad | report:missing |"] }, /malformed/i],
		[{ rows: [...assignmentRows, "| bad | report:missing | truncated"] }, /malformed/i],
		[{ extra: `\n${assignmentRows[0]}` }, /ambiguous row/i],
	]) {
		const { request, prior } = assignmentFixture(variant);
		assert.throws(() => recordHeartbeatAgentAssignments({ ...request, assignments: [firstAgentAssignment] }), failure);
		assert.deepEqual(readHeartbeatLedgerPair(request), prior);
	}
	const { dir, path, original, request, prior } = assignmentFixture();
	const options = { ...request, assignments: [firstAgentAssignment] };
	assert.throws(() => recordHeartbeatAgentAssignments({ ...options, legacyWritersQuiescent: false }), /exclusive ownership/i);
	assert.throws(() => recordHeartbeatAgentAssignments({ ...options, expectedContentHash: undefined }), /expectedContentHash/i);
	writeFileSync(`${path}.lock`, "other writer\n");
	assert.throws(() => recordHeartbeatAgentAssignments(options), /writer lock/i);
	assert.deepEqual(readHeartbeatLedgerPair(request), prior);
	unlinkSync(`${path}.lock`);
	const legacy = join(dir, "legacy.md");
	writeFileSync(legacy, original);
	assert.throws(() => recordHeartbeatAgentAssignments({ ...options, path: legacy, expectedContentHash: version(legacy) }), /explicitly migrate/i);
	assert.equal(readFileSync(legacy, "utf8"), original);
});

test("assignment recovery preserves every prior wake and refuses to consume an unarchived wake suffix", () => {
	const { path, request, prior } = assignmentFixture();
	const options = { ...request, assignments: [firstAgentAssignment] };
	assert.throws(() => recordHeartbeatAgentAssignments({
		...options,
		beforeHeadPublish() { throw new Error("simulated crash"); },
	}), /simulated crash/i);
	assert.equal(readFileSync(path, "utf8"), prior.headText);
	assert.throws(() => readHeartbeatLedgerPair(request), /recovery required/i);
	const raw = readHeartbeatLedgerPairVersion(request);
	const recovered = recoverHeartbeatLedgerPair({ ...request, expectedContentHash: raw.contentHash });
	assert.match(recovered.headText, /\| native-thread-01 \|/);
	assert.equal(recovered.fullText, prior.fullText);
	assert.deepEqual(recovered.wakes, prior.wakes);
	appendFileSync(path, `\n${wake("2026-01-01T12:00Z")}`);
	const withSuffix = readHeartbeatLedgerPair(request);
	assert.equal(withSuffix.wakes.length, prior.wakes.length + 1);
	assert.throws(() => recordHeartbeatAgentAssignments({
		...options, expectedContentHash: withSuffix.contentHash,
		assignments: [{ itemId: "I3", agentThreadId: "other-native", expectedDispatchRef: "-" }],
	}), /unarchived suffix/i);
	assert.deepEqual(readHeartbeatLedgerPair(request), withSuffix);
});

test("missing, unrelated, corrupt, and interrupted companions never return empty history", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	writeFileSync(path, wake("2026-01-01T10:00Z"));
	assert.equal(readHeartbeatLedgerPair({ root: dir, path }).isLegacy, true);
	const paths = heartbeatLedgerPairPaths(path);
	writeFileSync(paths.historyPath, "unrelated");
	assert.throws(
		() => readHeartbeatLedgerPair({ root: dir, path }),
		/format|unrelated/i,
	);
	assert.throws(() => migrate({ root: dir, path }), /overwrite|unrelated/i);
	const canonicalPath = realpathSync(path);
	writeFileSync(
		paths.historyPath,
		`<!-- heartbeat-history:v1 source=${encodeURIComponent(canonicalPath)} -->\n${readFileSync(path, "utf8")}`,
	);
	assert.throws(
		() => readHeartbeatLedgerPair({ root: dir, path }),
		/backup|incomplete/i,
	);
	assert.throws(() => migrate({ root: dir, path }), /backup|incomplete/i);
	// Restore the history-first crash window to the documented recovery condition.
	writeFileSync(paths.legacyBackupPath, readFileSync(path, "utf8"));
	const recovered = migrate({ root: dir, path });
	assert.equal(recovered.isLegacy, false);
	assert.ok(recovered.fullText.includes("2026-01-01T10:00Z"));
	unlinkSync(paths.historyPath);
	assert.throws(
		() => readHeartbeatLedgerPair({ root: dir, path }),
		/missing history companion/i,
	);
	assert.throws(
		() => migrate({ root: dir, path }),
		/missing history companion/i,
	);
});

test("history changes invalidate project heartbeat hash and discovery excludes companions", async () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	writeFileSync(path, wake("2026-01-01T10:00Z"));
	const legacyView = await readProjectHeartbeat({
		root: dir,
		ledgerPath: path,
		now: new Date("2026-01-01T12:00Z"),
	});
	const pair = migrate({ root: dir, path });
	const view = await readProjectHeartbeat({
		root: dir,
		ledgerPath: path,
		now: new Date("2026-01-01T12:00Z"),
	});
	assert.equal(view.source.historyPath, pair.historyPath);
	assert.notEqual(view.source.contentHash, legacyView.source.contentHash);
	assert.equal(view.source.history.wakes[0].sourcePath, pair.historyPath);
	writeFileSync(`${path}.tmp-partial`, wake("2026-01-01T11:00Z"));
	const discovered = await discoverHeartbeatLedgers({ root: dir });
	assert.deepEqual(
		discovered.map((entry) => entry.path),
		[realpathSync(path)],
	);
	assert.equal(existsSync(pair.historyPath), true);
});

test("legacy manual appends remain logically visible exactly once after a pair exists", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const repeatedWake = wake(
		"2026-01-01T10:00Z",
		"| 1 | goal-derived remaining work | (1a) done -- `x`; (1b) done -- `y` |\n",
	);
	writeFileSync(
		path,
		`${repeatedWake}\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I1 | report:r1 | task | done | receipt |\n`,
	);
	migrate({ root: dir, path });
	const oldHead = readFileSync(path, "utf8");
	writeFileSync(path, `${oldHead}\n----\n${repeatedWake}`);
	const pair = readHeartbeatLedgerPair({ root: dir, path });
	assert.equal(
		(pair.fullText.match(/wake \(10-row ledger\)/g) ?? []).length,
		2,
	);
	const report = inspectHeartbeatLedgerPair(pair, {
		mode: "history",
		latest: false,
	});
	assert.equal(report.wakes.length, 2);
	assert.deepEqual(
		report.wakes.map((entry) => entry.sourcePath),
		[
			heartbeatLedgerPairPaths(realpathSync(path)).historyPath,
			realpathSync(path),
		],
	);
	assert.deepEqual(
		report.wakes.map((entry) => entry.rows[0].sourcePath),
		[
			heartbeatLedgerPairPaths(realpathSync(path)).historyPath,
			realpathSync(path),
		],
	);
	assert.deepEqual(
		report.wakes.map((entry) => entry.line),
		report.wakes.map((entry) => entry.sourceLine),
	);
	assert.deepEqual(
		report.wakes.map((entry) => entry.rows[0].line),
		report.wakes.map((entry) => entry.rows[0].sourceLine),
	);
});

test("paired CLIs accept an absolute historical path outside cwd and canonical aliases", () => {
	const dir = root();
	const cwd = root();
	const path = join(dir, "custom.md");
	writeFileSync(
		path,
		`${wake("2026-01-01T10:00Z")}\n${wake("2026-01-01T11:00Z")}`,
	);
	const legacyCheck = spawnSync(
		process.execPath,
		[CHECKER, path, "--history", "--json"],
		{ cwd, encoding: "utf8" },
	);
	assert.equal(legacyCheck.status, 1, legacyCheck.stderr);
	assert.doesNotMatch(legacyCheck.stderr, /outside|cannot read/i);
	migrate({ root: dir, path });
	const checked = spawnSync(
		process.execPath,
		[CHECKER, path, "--history", "--json"],
		{ cwd, encoding: "utf8" },
	);
	assert.equal(checked.status, 1, checked.stderr);
	const checkedJson = JSON.parse(checked.stdout);
	assert.ok(
		checkedJson.wakes.some((entry) =>
			entry.sourcePath.endsWith("custom.taskhistory.md"),
		),
	);
	const due = spawnSync(
		process.execPath,
		[DUE, path, "--now", "2026-01-01T12:00:00Z", "--json"],
		{ cwd, encoding: "utf8" },
	);
	assert.equal(due.status, 0, due.stderr);
	assert.match(due.stdout, /"due":/);
});

test("observation never migrates; migration needs quiescence, version, and an uncontended lock", async () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const original = wake("2026-01-01T10:00Z");
	writeFileSync(path, original);
	const view = await readProjectHeartbeat({
		root: dir,
		ledgerPath: path,
		migrate: true,
	});
	assert.equal(view.status, "ready");
	assert.equal(readFileSync(path, "utf8"), original);
	assert.equal(existsSync(heartbeatLedgerPairPaths(path).historyPath), false);
	const snapshot = readHeartbeatLedgerPair({ root: dir, path });
	assert.throws(
		() =>
			migrateHeartbeatLedgerPair({
				root: dir,
				path,
				expectedContentHash: snapshot.contentHash,
			}),
		/quiescent/i,
	);
	assert.throws(
		() =>
			migrateHeartbeatLedgerPair({
				root: dir,
				path,
				legacyWritersQuiescent: true,
				expectedContentHash: "0".repeat(64),
			}),
		/version conflict/i,
	);
	assert.equal(readFileSync(path, "utf8"), original);
	assert.equal(
		existsSync(heartbeatLedgerPairPaths(path).legacyBackupPath),
		false,
	);
	writeFileSync(`${path}.lock`, "held");
	assert.throws(() => migrate({ root: dir, path }), /lock/i);
	unlinkSync(`${path}.lock`);
	assert.equal(migrate({ root: dir, path }).isLegacy, false);
	assert.equal(existsSync(`${path}.lock`), false);
});

test("truncated archives, altered backups and incomplete committed head fail closed", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	writeFileSync(
		path,
		`${wake("2026-01-01T10:00Z")}\n${wake("2026-01-01T11:00Z")}`,
	);
	const pair = migrate({ root: dir, path });
	const paths = heartbeatLedgerPairPaths(path);
	const history = readFileSync(paths.historyPath, "utf8");
	writeFileSync(paths.historyPath, history.slice(0, -3));
	assert.throws(
		() => readHeartbeatLedgerPair({ root: dir, path }),
		/integrity/i,
	);
	writeFileSync(paths.historyPath, history);
	const backup = readFileSync(paths.legacyBackupPath, "utf8");
	writeFileSync(paths.legacyBackupPath, "wrong");
	assert.throws(
		() => readHeartbeatLedgerPair({ root: dir, path }),
		/integrity/i,
	);
	writeFileSync(paths.legacyBackupPath, backup);
	writeFileSync(path, pair.headText.slice(0, -3));
	assert.throws(
		() => readHeartbeatLedgerPair({ root: dir, path }),
		/incomplete|modified/i,
	);
});

test("Items inventories and independent headings survive all supported wake ordering", () => {
	const inventory =
		"## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I1 | report:r1 | task | done | receipt |\n";
	for (const layout of [
		`${inventory}\n${wake("2026-01-01T10:00Z")}\n${wake("2026-01-01T11:00Z")}`,
		`${wake("2026-01-01T10:00Z")}\n${inventory}\n<!-- keep comment -->\n## Notes\nkeep this\n${wake("2026-01-01T11:00Z")}`,
		`${wake("2026-01-01T10:00Z")}\n${wake("2026-01-01T11:00Z")}\n${inventory}`,
	]) {
		const dir = root();
		const path = join(dir, "heartbeat.md");
		writeFileSync(path, layout);
		const pair = migrate({ root: dir, path });
		assert.equal(
			inspectHeartbeatLedgerPair(pair, { mode: "items" }).itemCount,
			1,
		);
		assert.equal(
			readFileSync(heartbeatLedgerPairPaths(path).legacyBackupPath, "utf8"),
			layout,
		);
		if (layout.includes("keep comment")) {
			assert.match(pair.headText, /keep comment/);
			assert.match(pair.headText, /keep this/);
		}
	}
});

test("manual identical appended wakes stay distinct after subsequent Kit append", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const same = wake("2026-01-01T10:00Z");
	writeFileSync(
		path,
		`${same}\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I1 | report:r1 | task | done | receipt |\n`,
	);
	migrate({ root: dir, path });
	writeFileSync(path, `${readFileSync(path, "utf8")}\n----\n${same}`);
	assert.equal(
		inspectHeartbeatLedgerPair(readHeartbeatLedgerPair({ root: dir, path }), {
			mode: "history",
			latest: false,
		}).wakes.length,
		2,
	);
	const pair = append({ root: dir, path, wakeText: same });
	assert.equal(
		inspectHeartbeatLedgerPair(pair, { mode: "history", latest: false }).wakes
			.length,
		3,
	);
});

test("stale ownership snapshot refuses cutover without changing legacy bytes", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	writeFileSync(path, wake("2026-01-01T10:00Z"));
	const before = readHeartbeatLedgerPair({ root: dir, path });
	const appended = `${before.headText}\n${wake("2026-01-01T11:00Z")}`;
	writeFileSync(path, appended);
	assert.throws(
		() =>
			migrateHeartbeatLedgerPair({
				root: dir,
				path,
				legacyWritersQuiescent: true,
				expectedContentHash: before.contentHash,
			}),
		/version conflict/i,
	);
	assert.equal(readFileSync(path, "utf8"), appended);
	assert.equal(existsSync(heartbeatLedgerPairPaths(path).historyPath), false);
});

test("explicit recovery finishes a history-first write with new inventory and wake intact", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const old = `${wake("2026-01-01T10:00Z")}\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I1 | report:r1 | old | done | receipt |\n`;
	writeFileSync(path, old);
	const pair = migrate({ root: dir, path });
	const next = `${wake("2026-01-01T11:00Z")}\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I2 | report:r2 | new | done | receipt |\n`;
	assert.throws(
		() =>
			writeHeartbeatLedgerPair({
				root: dir,
				path,
				text: next,
				legacyWritersQuiescent: true,
				expectedContentHash: pair.contentHash,
				beforeHeadPublish() {
					throw new Error("injected crash");
				},
			}),
		/injected crash/,
	);
	assert.throws(
		() => readHeartbeatLedgerPair({ root: dir, path }),
		/incomplete|modified/i,
	);
	const expected = readHeartbeatLedgerPairVersion({
		root: dir,
		path,
	}).contentHash;
	const recovered = recoverHeartbeatLedgerPair({
		root: dir,
		path,
		legacyWritersQuiescent: true,
		expectedContentHash: expected,
	});
	assert.equal(
		inspectHeartbeatLedgerPair(recovered, { mode: "items" }).items[0].id,
		"I2",
	);
	assert.equal(
		inspectHeartbeatLedgerPair(recovered, { mode: "history", latest: false })
			.wakes.length,
		2,
	);
	assert.equal(
		readFileSync(heartbeatLedgerPairPaths(path).legacyBackupPath, "utf8"),
		old,
	);
});

test("recovery refuses stale versions and preserves external appends, even after fresh raw observation", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const old = wake("2026-01-01T10:00Z");
	writeFileSync(path, old);
	const before = readHeartbeatLedgerPair({ root: dir, path });
	assert.throws(
		() =>
			migrateHeartbeatLedgerPair({
				root: dir,
				path,
				legacyWritersQuiescent: true,
				expectedContentHash: before.contentHash,
				beforeHeadPublish() {
					throw new Error("injected crash");
				},
			}),
		/injected crash/,
	);
	const paths = heartbeatLedgerPairPaths(path),
		interrupted = readHeartbeatLedgerPairVersion({
			root: dir,
			path,
		}).contentHash;
	const appended = `${old}\n${wake("2026-01-01T11:00Z")}`;
	writeFileSync(path, appended);
	const history = readFileSync(paths.historyPath, "utf8");
	assert.throws(
		() =>
			recoverHeartbeatLedgerPair({
				root: dir,
				path,
				legacyWritersQuiescent: true,
				expectedContentHash: interrupted,
			}),
		/version conflict/i,
	);
	const fresh = readHeartbeatLedgerPairVersion({ root: dir, path }).contentHash;
	assert.throws(
		() =>
			recoverHeartbeatLedgerPair({
				root: dir,
				path,
				legacyWritersQuiescent: true,
				expectedContentHash: fresh,
			}),
		/recovery conflict/i,
	);
	assert.equal(readFileSync(path, "utf8"), appended);
	assert.equal(readFileSync(paths.historyPath, "utf8"), history);
	assert.equal(readFileSync(paths.legacyBackupPath, "utf8"), old);
});

test("a partially migrated legacy source can be explicitly recovered", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const old = `${wake("2026-01-01T10:00Z")}\n${wake("2026-01-01T11:00Z")}`;
	writeFileSync(path, old);
	const before = readHeartbeatLedgerPair({ root: dir, path });
	assert.throws(
		() =>
			migrateHeartbeatLedgerPair({
				root: dir,
				path,
				legacyWritersQuiescent: true,
				expectedContentHash: before.contentHash,
				beforeHeadPublish() {
					throw new Error("injected crash");
				},
			}),
		/injected crash/,
	);
	const raw = readHeartbeatLedgerPairVersion({ root: dir, path });
	const recovered = recoverHeartbeatLedgerPair({
		root: dir,
		path,
		legacyWritersQuiescent: true,
		expectedContentHash: raw.contentHash,
	});
	assert.equal(
		inspectHeartbeatLedgerPair(recovered, { mode: "history", latest: false })
			.wakes.length,
		2,
	);
	assert.equal(
		readFileSync(heartbeatLedgerPairPaths(path).legacyBackupPath, "utf8"),
		old,
	);
});

test("legacy project heartbeat names the head as its actual history source", async () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	writeFileSync(path, wake("2026-01-01T10:00Z"));
	const view = await readProjectHeartbeat({ root: dir, ledgerPath: path });
	assert.equal(view.source.historyPath, realpathSync(path));
});

test("realistic closeout wake heading is the only current wake and all audit rows remain in history", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const block = (heading, time) =>
		`## ${time} ${heading} (10-row ledger)\nsources: x(ok)\n${Array.from({ length: 10 }, (_, i) => `| ${i + 1} | category | done -- evidence |`).join("\n")}\n\n### Notes\nIndependent prose.\n`;
	const text = `# Session\n\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I1 | report:r1 | item | done | receipt |\n\n## Handoff\nSome notes.\n\n${block("wake", "2026-01-01T10:00Z")}\n${block("wake", "2026-01-01T11:00Z")}\n${block("closeout wake", "2026-01-01T12:00Z")}`;
	writeFileSync(path, text);
	const pair = migrate({ root: dir, path });
	assert.equal(
		(pair.headText.match(/wake \(10-row ledger\)/g) ?? []).length,
		1,
	);
	assert.match(pair.headText, /2026-01-01T12:00Z closeout wake/);
	const report = inspectHeartbeatLedgerPair(pair, {
		mode: "history",
		latest: false,
	});
	assert.equal(report.wakes.length, 3);
	assert.deepEqual(
		report.wakes.map((w) => w.rows.length),
		[10, 10, 10],
	);
	assert.equal(
		inspectHeartbeatLedgerPair(pair, { mode: "items" }).itemCount,
		1,
	);
	assert.equal(
		readFileSync(heartbeatLedgerPairPaths(path).legacyBackupPath, "utf8"),
		text,
	);
});

test("current and history audit current inventory instead of archived Items", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const table = (row) =>
		`## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n${row}\n`;
	const historical = `${wake("2026-01-01T10:00Z")}\n${table("| I1 | report:r1 | old | done | receipt |")}`;
	writeFileSync(path, historical);
	migrate({ root: dir, path });
	const updated = write({ root: dir, path, text: `${wake("2026-01-01T11:00Z")}\n${table("| I1 | report:r1 | changed | done | receipt |")}` });
	for (const mode of ["current", "history"]) {
		const report = inspectHeartbeatLedgerPair(updated, { mode });
		assert.equal(report.itemCount, 1);
		assert.equal(report.items[0].item, "changed");
	}
	const live = `${wake("2026-01-01T11:00Z")}\n${table("| I1 | report:r1 | changed | done | |")}\n## Notes\n| I2 | report:r2 | stray | done | receipt |\n`;
	// Bad historical data must remain inspectable through migration; ordinary
	// writers now reject this current inventory before changing either file.
	assert.throws(() => write({ root: dir, path, text: live }), { code: "HEARTBEAT_LEDGER_INVALID" });
	const malformedPath = join(dir, "malformed.md");
	writeFileSync(malformedPath, `${wake("2026-01-01T10:00Z")}\n${live}`);
	const pair = migrate({ root: dir, path: malformedPath });
	const current = inspectHeartbeatLedgerPair(pair, {
		mode: "current",
		now: new Date("2026-01-01T11:30Z"),
	});
	const items = inspectHeartbeatLedgerPair(pair, {
		mode: "items",
		now: new Date("2026-01-01T11:30Z"),
	});
	for (const rule of ["item-done-evidence", "item-outside-table"]) {
		assert.ok(
			items.findings.some((f) => f.rule === rule),
			rule,
		);
		assert.ok(
			current.findings.some((f) => f.rule === rule),
			rule,
		);
	}
	assert.equal(current.passed, false);
	assert.equal(current.certifiesCurrent, false);
	assert.equal(current.items[0].item, "changed");
	const history = inspectHeartbeatLedgerPair(pair, {
		mode: "history",
		latest: true,
		now: new Date("2026-01-01T11:30Z"),
	});
	assert.ok(history.findings.some((f) => f.rule === "item-outside-table"));
	assert.equal(history.items[0].item, "changed");
	assert.equal(history.wakes.length, 2);
});

test("owner and inventory guard findings use current Items in paired history", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const table = (row) =>
		`## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n${row}\n`;
	writeFileSync(
		path,
		`${wake("2026-01-01T10:00Z")}\n${table("| I1 | report:r1 | old | done | receipt |")}`,
	);
	migrate({ root: dir, path });
	const ownerPath = join(dir, "malformed-owner.md");
	writeFileSync(ownerPath, `${wake("2026-01-01T11:00Z")}\n${table("| I1 | report:r1 | changed | owner <- it is hard | |")}`);
	const pair = migrate({ root: dir, path: ownerPath });
	for (const mode of ["current", "items"]) {
		const result = inspectHeartbeatLedgerPair(pair, { mode, latest: true });
		assert.ok(
			result.findings.some((f) => f.rule === "item-owner-category"),
			mode,
		);
		assert.ok(
			result.findings.some((f) => f.rule === "item-owner-authorization-note"),
			mode,
		);
	}
	const dispatchedPath = join(dir, "malformed-dispatched.md");
	writeFileSync(dispatchedPath, `${wake("2026-01-01T12:00Z")}\n${table("| I1 | report:r1 | changed | dispatched worker | |")}`);
	const dispatched = migrate({ root: dir, path: dispatchedPath });
	const history = inspectHeartbeatLedgerPair(dispatched, {
		mode: "history",
		latest: true,
	});
	assert.ok(
		history.findings.some((f) => f.rule === "item-dispatched-no-owner"),
	);
});

test("finding locations map repeated historical and manual wake occurrences to physical files", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const heading = "## 2026-01-01T10:00Z wake (10-row ledger)";
	writeFileSync(
		path,
		`# title\n${heading}\n\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I1 | report:r1 | task | done | |\n`,
	);
	const pair = migrate({ root: dir, path });
	writeFileSync(path, `${pair.headText}\n${heading}\n`);
	const current = readHeartbeatLedgerPair({ root: dir, path });
	const report = inspectHeartbeatLedgerPair(current, {
		mode: "history",
		latest: false,
	});
	const findings = report.findings.filter((f) => f.rule === "sources-missing");
	assert.equal(findings.length, 2);
	assert.deepEqual(
		findings.map((f) => [f.sourcePath, f.sourceLine]),
		report.wakes.map((w) => [w.sourcePath, w.sourceLine]),
	);
	for (const finding of findings) {
		assert.match(finding.message, new RegExp(`line ${finding.sourceLine}\\b`));
		assert.equal(finding.sourceLocations[0].sourceLine, finding.sourceLine);
	}
	assert.equal(findings[0].sourcePath, current.historyPath);
	assert.equal(findings[1].sourcePath, current.headPath);
	const currentReport = inspectHeartbeatLedgerPair(current, {
		mode: "current",
	});
	const item = currentReport.findings.find(
		(f) => f.rule === "item-done-evidence",
	);
	assert.equal(item.sourcePath, current.headPath);
	assert.equal(item.sourceLine, currentReport.items[0].line);
	assert.match(item.message, new RegExp(`line ${item.sourceLine}\\b`));
});

test("all references in one finding map independently across files and unlocated findings remain unchanged", () => {
	const dir = root();
	const path = join(dir, "heartbeat.md");
	const heading = "## 2026-01-01T10:00Z wake (10-row ledger)";
	writeFileSync(path, `# t\n${heading}\n`);
	const migrated = migrate({ root: dir, path });
	writeFileSync(path, `${migrated.headText}\n${heading}\n`);
	const pair = readHeartbeatLedgerPair({ root: dir, path });
	const inspect = (text, options) => {
		if (options.mode === "items")
			return { items: [], itemCount: 0, tables: [], wakes: [], findings: [] };
		const lines = text.split("\n");
		const indexes = lines.flatMap((line, i) =>
			line === heading ? [i + 1] : [],
		);
		return {
			items: [],
			itemCount: 0,
			tables: [],
			wakes: [],
			findings: [
				{
					rule: "multi",
					message: `first line ${indexes[0]} and line ${indexes[1]}`,
				},
				{ rule: "plain", message: "no location" },
			],
		};
	};
	const report = inspectHeartbeatLedgerPair(pair, { mode: "history", inspect });
	const [multi, plain] = report.findings;
	assert.deepEqual(
		multi.sourceLocations.map((x) => [x.sourcePath, x.sourceLine]),
		pair.wakes.map((x) => [x.sourcePath, x.sourceLine]),
	);
	assert.match(
		multi.message,
		new RegExp(`line ${pair.wakes[0].sourceLine} \\[`),
	);
	assert.ok(multi.message.includes(pair.historyPath));
	assert.ok(multi.message.includes(pair.headPath));
	assert.deepEqual(plain, { rule: "plain", message: "no location" });
});

test("bounded legacy reads honor exact byte limits and reject oversized input before parsing", () => {
	const dir = root(),
		path = join(dir, "heartbeat.md");
	const contents = `${wake("2026-01-01T10:00Z")}\n汉字\n`;
	writeFileSync(path, contents);
	const size = Buffer.byteLength(contents);
	const bounded = readHeartbeatLedgerPair({ root: dir, path, maxBytes: size });
	assert.equal(bounded.headText, contents);
	assert.equal(bounded.isLegacy, true);
	assert.throws(
		() => readHeartbeatLedgerPair({ root: dir, path, maxBytes: size - 1 }),
		/exceeds.*byte read limit/i,
	);
	for (const maxBytes of [
		0,
		-1,
		1.5,
		NaN,
		Infinity,
		Number.MAX_SAFE_INTEGER + 1,
		"100",
	])
		assert.throws(
			() => readHeartbeatLedgerPair({ root: dir, path, maxBytes }),
			/positive safe integer/i,
		);
});

test("bounded paired reads enforce combined size, including grown companion before parsing", () => {
	const dir = root(),
		path = join(dir, "heartbeat.md");
	writeFileSync(
		path,
		`${wake("2026-01-01T10:00Z")}\n${wake("2026-01-01T11:00Z")}`,
	);
	const ordinary = migrate({ root: dir, path }),
		paths = heartbeatLedgerPairPaths(path);
	const head = readFileSync(path, "utf8"),
		history = readFileSync(paths.historyPath, "utf8");
	const size = Buffer.byteLength(head) + Buffer.byteLength(history);
	const bounded = readHeartbeatLedgerPair({ root: dir, path, maxBytes: size });
	assert.deepEqual(bounded, ordinary);
	assert.throws(
		() => readHeartbeatLedgerPair({ root: dir, path, maxBytes: size - 1 }),
		/exceeds.*byte read limit/i,
	);
	// A grown, no longer valid history must hit the bound before integrity parsing.
	writeFileSync(paths.historyPath, `${history}${"x".repeat(1024)}`);
	assert.throws(
		() => readHeartbeatLedgerPair({ root: dir, path, maxBytes: size }),
		/exceeds.*byte read limit/i,
	);
	assert.throws(
		() => readHeartbeatLedgerPair({ root: dir, path }),
		/integrity/i,
	);
});

test("bounded reads reject non-regular companions without waiting for a writer", () => {
	const dir = realpathSync(root()),
		path = join(dir, "heartbeat.md");
	writeFileSync(path, wake("2026-01-01T10:00Z"));
	const companion = heartbeatLedgerPairPaths(path).historyPath;
	// A FIFO companion is simulated through the injected file primitives (the fd reports a non-regular
	// file), so the rejection and the non-blocking open flags are asserted identically on every host.
	writeFileSync(companion, "placeholder");
	const opened = new Map();
	const flagsByPath = new Map();
	const io = {
		openSync(target, flags) {
			const fd = openSync(target, flags);
			opened.set(fd, target);
			flagsByPath.set(target, flags);
			return fd;
		},
		fstatSync(fd) {
			if (opened.get(fd) !== companion) return fstatSync(fd);
			return { isFile: () => false, size: 0, mtimeMs: 0 };
		},
		readSync: (...args) => readSync(...args),
		closeSync: (fd) => closeSync(fd),
	};
	assert.throws(
		() => readHeartbeatLedgerPair({ root: dir, path, maxBytes: 1024, io }),
		/not a file|regular file/i,
	);
	const nonBlocking = constants.O_NONBLOCK ?? 0;
	const noFollow = constants.O_NOFOLLOW ?? 0;
	assert.equal(
		flagsByPath.get(companion) & nonBlocking,
		nonBlocking,
		"opens without waiting for a writer",
	);
	assert.equal(
		flagsByPath.get(companion) & noFollow,
		noFollow,
		"refuses to follow links",
	);
});

test("orchestration metadata survives append, restart and pair writes without rewriting history", () => {
	const dir = root(),
		path = join(dir, "heartbeat.md");
	const old = wake("2026-01-01T10:00Z");
	writeFileSync(path, old);
	migrate({ root: dir, path });
	const snapshot = {
		scope: "run",
		before: {
			activeAgents: 0,
			observedAt: "2026-01-01T11:00:00Z",
			evidence: "receipt:1",
		},
		after: {
			activeAgents: 3,
			observedAt: "2026-01-01T11:00:00Z",
			evidence: "receipt:2",
		},
		blockedTasks: null,
		blockersEvidence: null,
		agentPlan: {
			parentThreadId: "parent",
			planId: "plan",
			revision: 1,
			plannedAgents: 6,
			taskCycleId: "cycle",
		},
	};
	let pair = append({
		root: dir,
		path,
		wakeText: wake("2026-01-01T11:00Z"),
		orchestration: snapshot,
	});
	assert.ok(pair.historyText.includes(old));
	assert.deepEqual(
		inspectHeartbeatLedgerPair(readHeartbeatLedgerPair({ root: dir, path }), {
			mode: "history",
		}).wakes.at(-1).orchestration,
		snapshot,
	);
	assert.throws(
		() =>
			append({
				root: dir,
				path,
				wakeText: wake("2026-01-01T12:00Z", "orchestration: {}\n"),
				orchestration: snapshot,
			}),
		/Duplicate/,
	);
	const next = wake("2026-01-01T12:00Z");
	pair = write({
		root: dir,
		path,
		text: `${pair.headText.replace(/^<!-- heartbeat-head:[^\n]*\n/, "")}\n${next}`,
		orchestration: snapshot,
	});
	assert.ok(pair.historyText.includes(old));
	assert.deepEqual(
		inspectHeartbeatLedgerPair(pair, { mode: "history" }).wakes.at(-1)
			.orchestration,
		snapshot,
	);
});

test("successive wakes retain snapshot history without orphaning superseded metadata in head", () => {
	const dir = root(),
		path = join(dir, "heartbeat.md");
	const legacy = `# legacy prose\n${wake("2026-01-01T10:00Z")}legacy note\n`;
	writeFileSync(path, legacy);
	migrate({ root: dir, path });
	const snapshot = (n) => ({
		scope: `wake-${n}`,
		before: {
			activeAgents: n,
			observedAt: `2026-01-01T1${n}:00:00Z`,
			evidence: `receipt:${n}`,
		},
		after: null,
		blockedTasks: [],
		blockersEvidence: `audit:${n}`,
	});
	let pair = append({
		root: dir,
		path,
		wakeText: wake("2026-01-01T11:00Z"),
		orchestration: snapshot(1),
	});
	pair = append({
		root: dir,
		path,
		wakeText: wake("2026-01-01T12:00Z"),
		orchestration: snapshot(2),
	});
	pair = readHeartbeatLedgerPair({ root: dir, path });
	assert.equal((pair.headText.match(/^orchestration:/gm) ?? []).length, 1);
	assert.ok(pair.headText.includes("wake-2"));
	assert.ok(!pair.headText.includes("wake-1"));
	assert.ok(pair.historyText.includes(legacy));
	const next = wake("2026-01-01T13:00Z");
	pair = write({
		root: dir,
		path,
		text: `${pair.headText.replace(/^<!-- heartbeat-head:[^\n]*\n/, "")}\n${next}`,
		orchestration: snapshot(3),
	});
	pair = readHeartbeatLedgerPair({ root: dir, path });
	assert.equal((pair.headText.match(/^orchestration:/gm) ?? []).length, 1);
	assert.ok(pair.headText.includes("wake-3"));
	assert.ok(pair.historyText.includes(legacy));
	assert.equal(
		readFileSync(heartbeatLedgerPairPaths(path).legacyBackupPath, "utf8"),
		legacy,
	);
	const wakes = inspectHeartbeatLedgerPair(pair, { mode: "history" }).wakes;
	assert.deepEqual(
		wakes.map((entry) => entry.orchestration?.scope ?? null),
		[null, "wake-1", "wake-2", "wake-3"],
	);
});

// Generate a genuine v3 pair rather than padding the bounded head. The archival
// filler is independent prose so the wake records themselves remain small.
function largeDisplayFixture(dir, prefix = "") {
	const path = join(realpathSync(dir), "heartbeat.md"),
		paths = heartbeatLedgerPairPaths(path);
	const marker = `<!-- heartbeat-head:v2 source=${encodeURIComponent(path)} history=${encodeURIComponent(paths.historyPath)} -->\n`;
	const head = `${marker}# Current\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I1 | report:r1 | 中文 | done | receipt |\n`;
	const old = `${wake("2026-01-01T10:00Z")}## Notes\n${"x".repeat(4095)}\n`;
	const newer = `${wake("2026-01-01T11:00Z")}## Notes\n中文\n`;
	const body = `${prefix}${old}${"x".repeat(4095).concat("\n").repeat(8193)}${newer}`;
	const backup = "immutable legacy 中文\n";
	const hash = (value) => createHash("sha256").update(value).digest("hex");
	const header = `<!-- heartbeat-history:v3 source=${encodeURIComponent(path)} body=${hash(body)} base=${hash(head)} bytes=${Buffer.byteLength(head)} backup=${hash(backup)} previous=${hash(backup)} planned=${Buffer.from(head).toString("base64")} -->\n`;
	writeFileSync(path, head);
	writeFileSync(paths.historyPath, header + body);
	writeFileSync(paths.legacyBackupPath, backup);
	return { path, paths, head, body, header, backup };
}

test("display reads and pages an authenticated pair exceeding the old combined limit", async () => {
	const dir = root(),
		fixture = largeDisplayFixture(dir),
		now = new Date("2026-01-01T12:00:00Z");
	assert.ok(
		statSync(fixture.path).size + statSync(fixture.paths.historyPath).size >
			32 * 1024 * 1024,
	);
	assert.throws(
		() =>
			readHeartbeatLedgerPair({
				root: dir,
				path: fixture.path,
				maxBytes: 32 * 1024 * 1024,
			}),
		/exceeds/,
	);
	const first = await readHeartbeatDisplay({
		root: dir,
		path: fixture.path,
		pageSize: 1,
		now,
	});
	assert.equal(first.integrity, "verified");
	assert.equal(first.audit, "not-performed");
	assert.equal(first.headText, fixture.head);
	assert.equal(first.inventory.items[0].item, "中文");
	assert.equal(first.historyPage.total, 2);
	assert.match(first.latestWake.heading, /11:00/);
	assert.equal(
		first.historyPage.wakes[0].sourcePath,
		fixture.paths.historyPath,
	);
	assert.ok(first.historyPage.wakes[0].sourceLine > 8000);
	assert.equal(first.contentHash, version(fixture.path));
	assert.equal(
		first.headDigest,
		createHash("sha256").update(fixture.head).digest("hex"),
	);
	const cursor = first.historyPage.nextCursor;
	const next = await readHeartbeatDisplay({
		root: dir,
		path: fixture.path,
		pageSize: 1,
		cursor,
		now,
	});
	assert.match(next.historyPage.wakes[0].heading, /10:00/);
	assert.equal(next.historyPage.nextCursor, null);
	assert.deepEqual(
		await readHeartbeatDisplay({
			root: dir,
			path: fixture.path,
			pageSize: 1,
			cursor,
			now,
		}),
		next,
	);
	clearHeartbeatDisplayCache();
	assert.deepEqual(
		await readHeartbeatDisplay({
			root: dir,
			path: fixture.path,
			pageSize: 1,
			cursor,
			now,
		}),
		next,
	);
});

test("display fails closed for stale cursors, corruption, missing backup and symlinks", async () => {
	const dir = root(),
		fixture = largeDisplayFixture(dir);
	const first = await readHeartbeatDisplay({
		root: dir,
		path: fixture.path,
		pageSize: 1,
	});
	appendFileSync(fixture.path, "\n");
	await assert.rejects(
		readHeartbeatDisplay({
			root: dir,
			path: fixture.path,
			cursor: first.historyPage.nextCursor,
		}),
		{ code: "HEARTBEAT_DISPLAY_CURSOR_STALE" },
	);
	appendFileSync(fixture.paths.historyPath, "corruption");
	await assert.rejects(
		readHeartbeatDisplay({ root: dir, path: fixture.path }),
		/integrity/,
	);
	writeFileSync(fixture.paths.historyPath, fixture.header + fixture.body);
	unlinkSync(fixture.paths.legacyBackupPath);
	await assert.rejects(
		readHeartbeatDisplay({ root: dir, path: fixture.path }),
		/backup missing/,
	);
	symlinkSync(fixture.path, fixture.paths.legacyBackupPath);
	await assert.rejects(
		readHeartbeatDisplay({ root: dir, path: fixture.path }),
		/symlink|loop/i,
	);
});

test("display preserves legacy inventory validation and rejects oversized wake records", async () => {
	const dir = realpathSync(root()),
		path = join(dir, "heartbeat.md");
	writeFileSync(
		path,
		`# Legacy\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I1 | r | bad | done | |\n\n${wake("2026-01-01T10:00Z")}`,
	);
	const result = await readHeartbeatDisplay({ root: dir, path });
	assert.equal(result.isLegacy, true);
	assert.equal(result.historyPath, path);
	assert.ok(
		result.inventory.findings.some((f) => f.rule === "item-done-evidence"),
	);
	assert.equal(result.latestWake.sourcePath, path);
	writeFileSync(
		path,
		`${wake("2026-01-01T10:00Z")}${"x".repeat(4095).concat("\n").repeat(1025)}`,
	);
	await assert.rejects(
		readHeartbeatDisplay({ root: dir, path }),
		/wake exceeds record limit/,
	);
});

test("display detects concurrent pair mutation and interrupted publication", async () => {
	const dir = root(),
		fixture = largeDisplayFixture(dir);
	clearHeartbeatDisplayCache();
	let mutated = false;
	const pending = readHeartbeatDisplay({
		root: dir,
		path: fixture.path,
		onRead(read) {
			if (!mutated && read.path === fixture.paths.historyPath) {
				mutated = true;
				appendFileSync(fixture.paths.historyPath, "concurrent");
			}
		},
	});
	await assert.rejects(pending, { code: "HEARTBEAT_DISPLAY_CHANGED" });
	assert.equal(mutated, true);
	writeFileSync(fixture.paths.historyPath, fixture.header + fixture.body);
	writeFileSync(fixture.path, fixture.head.replace("Current", "Changed"));
	await assert.rejects(
		readHeartbeatDisplay({ root: dir, path: fixture.path }),
		/incomplete|modified/,
	);
});

test("display cache avoids rescanning history and rejects overlong cursors", async () => {
	const dir = root(),
		fixture = largeDisplayFixture(dir);
	clearHeartbeatDisplayCache();
	let historyBytes = 0;
	const onRead = ({ path, bytes }) => {
		if (path === fixture.paths.historyPath) historyBytes += bytes;
	};
	const first = await readHeartbeatDisplay({
		root: dir,
		path: fixture.path,
		pageSize: 1,
		onRead,
	});
	assert.ok(historyBytes >= statSync(fixture.paths.historyPath).size);
	assert.ok(first.historyPage.nextCursor.length <= 512);
	historyBytes = 0;
	await readHeartbeatDisplay({
		root: dir,
		path: fixture.path,
		pageSize: 1,
		cursor: first.historyPage.nextCursor,
		onRead,
	});
	assert.ok(
		historyBytes < 8192,
		`cached page read ${historyBytes} history bytes`,
	);
	await assert.rejects(
		readHeartbeatDisplay({
			root: dir,
			path: fixture.path,
			cursor: "x".repeat(513),
		}),
		{ code: "HEARTBEAT_DISPLAY_CURSOR_STALE" },
	);
});

test("display enforces head, header, line and page budgets before large reads or record allocations", async () => {
	const dir = root(),
		path = join(dir, "heartbeat.md"),
		paths = heartbeatLedgerPairPaths(path);
	writeFileSync(path, "x");
	truncateSync(path, 32 * 1024 * 1024 + 1);
	let total = 0;
	const onRead = ({ bytes }) => {
		total += bytes;
	};
	await assert.rejects(
		readHeartbeatDisplay({ root: dir, path, onRead }),
		/line exceeds/,
	);
	assert.ok(total <= 1024 * 1024 + 65536);
	writeFileSync(path, "legacy");
	writeFileSync(paths.historyPath, "x");
	truncateSync(paths.historyPath, 48 * 1024 * 1024 + 1);
	writeFileSync(paths.legacyBackupPath, "backup");
	total = 0;
	await assert.rejects(
		readHeartbeatDisplay({ root: dir, path, onRead }),
		/header exceeds/,
	);
	assert.ok(total <= 48 * 1024 * 1024 + 65536 + 6);
	unlinkSync(paths.historyPath);
	unlinkSync(paths.legacyBackupPath);
	writeFileSync(path, `# legacy\n${"x".repeat(1024 * 1024 + 1)}\n`);
	await assert.rejects(
		readHeartbeatDisplay({ root: dir, path }),
		/line exceeds/,
	);
	const line = "x".repeat(4095) + "\n";
	const block = (time) => `${wake(time)}${line.repeat(768)}## End\n`;
	writeFileSync(
		path,
		block("2026-01-01T10:00Z") +
			block("2026-01-01T11:00Z") +
			block("2026-01-01T12:00Z"),
	);
	total = 0;
	const first = await readHeartbeatDisplay({
		root: dir,
		path,
		pageSize: 5,
		onRead,
	});
	const scanBytes = statSync(path).size;
	assert.ok(total - scanBytes <= 8 * 1024 * 1024);
	assert.equal(first.historyPage.total, 3);
	assert.equal(first.historyPage.wakes.length, 2);
	assert.ok(first.historyPage.nextCursor);
	const cursor = first.historyPage.nextCursor;
	total = 0;
	const next = await readHeartbeatDisplay({
		root: dir,
		path,
		pageSize: 5,
		cursor,
		onRead,
	});
	assert.ok(total <= 8 * 1024 * 1024);
	assert.equal(next.historyPage.total, 3);
	assert.equal(next.historyPage.nextCursor, null);
	assert.deepEqual(
		[...first.historyPage.wakes, ...next.historyPage.wakes].map(
			(w) => w.heading,
		),
		[
			"## 2026-01-01T12:00Z wake (10-row ledger)",
			"## 2026-01-01T11:00Z wake (10-row ledger)",
			"## 2026-01-01T10:00Z wake (10-row ledger)",
		],
	);
	total = 0;
	assert.deepEqual(
		await readHeartbeatDisplay({
			root: dir,
			path,
			pageSize: 5,
			cursor,
			onRead,
		}),
		next,
	);
	assert.ok(total <= 8 * 1024 * 1024);
});

test("display leaves unchanged malformed headers as permanent format failures", async () => {
	const dir = root(),
		path = join(dir, "heartbeat.md"),
		paths = heartbeatLedgerPairPaths(path);
	writeFileSync(path, "# legacy\n");
	writeFileSync(paths.historyPath, "invalid header\nbody\n");
	writeFileSync(paths.legacyBackupPath, "backup");
	await assert.rejects(
		readHeartbeatDisplay({ root: dir, path }),
		(error) => !error.code && /invalid.*format/.test(error.message),
	);
});

test("display runs the selected items inspector for each cached read", async () => {
	const dir = realpathSync(root()),
		path = join(dir, "heartbeat.md");
	writeFileSync(
		path,
		`# Legacy\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I1 | r | task | done | receipt |\n${wake("2026-01-01T10:00Z")}`,
	);
	const seen = [];
	const custom = (tag) => (text, options) => {
		seen.push([tag, options.mode]);
		const report = inspectHeartbeatLedger(text, options);
		report.findings.push({ rule: tag, message: tag, severity: "error" });
		report.passed = false;
		return report;
	};
	const first = await readHeartbeatDisplay({
		root: dir,
		path,
		inspect: custom("custom-one"),
	});
	const second = await readHeartbeatDisplay({
		root: dir,
		path,
		inspect: custom("custom-two"),
	});
	assert.deepEqual(seen, [
		["custom-one", "items"],
		["custom-two", "items"],
	]);
	assert.ok(first.inventory.findings.some((f) => f.rule === "custom-one"));
	assert.ok(second.inventory.findings.some((f) => f.rule === "custom-two"));
	assert.ok(!second.inventory.findings.some((f) => f.rule === "custom-one"));
});

function cadenceWake(time, count = 10, rows = count) {
	return `## ${time} wake (${count}-row ledger)\n${Array.from({ length: rows }, (_, i) => `| ${i + 1} | category | done |`).join("\n")}\n`;
}

test("display cadence uses the last complete ten-row wake without certifying current", async () => {
	const dir = realpathSync(root()),
		path = join(dir, "heartbeat.md"),
		now = new Date("2026-01-01T10:30:00Z");
	const scenarios = [
		[
			cadenceWake("2026-01-01T10:10Z") +
				cadenceWake("2026-01-01T10:29Z", 10, 2) +
				cadenceWake("2026-01-01T10:30Z", 8),
			"interval-elapsed",
			"2026-01-01T10:30:00.000Z",
		],
		[
			cadenceWake("2026-01-01T10:10Z") + cadenceWake("invalid-time"),
			"invalid-audit-timestamp",
			null,
		],
		[
			cadenceWake("2026-01-01T10:10Z") + cadenceWake("2026-01-01T10:31Z"),
			"future-audit-timestamp",
			null,
		],
		[cadenceWake("2026-01-01T10:10Z", 8), "no-full-ten-row-audit", null],
	];
	for (const [text, reason, nextDueAt] of scenarios) {
		writeFileSync(path, text);
		const result = await readHeartbeatDisplay({
			root: dir,
			path,
			intervalMinutes: 20,
			now,
		});
		assert.equal(result.cadence.reason, reason);
		assert.equal(result.cadence.nextDueAt, nextDueAt);
		assert.equal(result.audit, "not-performed");
		assert.equal(
			(await readHeartbeatDisplay({ root: dir, path, now })).cadence,
			null,
		);
	}
});

test("large history cadence survives paging without rescanning the history", async () => {
	const dir = root(),
		fixture = largeDisplayFixture(dir, cadenceWake("2026-01-01T10:10Z"));
	const now = new Date("2026-01-01T10:30:00Z");
	let historyBytes = 0;
	const onRead = (read) => {
		if (read.path === fixture.paths.historyPath) historyBytes += read.bytes;
	};
	clearHeartbeatDisplayCache();
	const first = await readHeartbeatDisplay({
		root: dir,
		path: fixture.path,
		pageSize: 1,
		intervalMinutes: 20,
		now,
		onRead,
	});
	assert.equal(first.cadence.nextDueAt, "2026-01-01T10:30:00.000Z");
	assert.ok(historyBytes >= statSync(fixture.paths.historyPath).size);
	historyBytes = 0;
	const second = await readHeartbeatDisplay({
		root: dir,
		path: fixture.path,
		pageSize: 1,
		cursor: first.historyPage.nextCursor,
		intervalMinutes: 20,
		now,
		onRead,
	});
	assert.deepEqual(second.cadence, first.cadence);
	assert.ok(historyBytes < 8192);
});

test("large appended head keeps canonical inventory, digest, binding and bounded history pages", async () => {
	const dir = realpathSync(root()),
		path = join(dir, "heartbeat.md");
	const initial = `# Project\nthread: parent\ntask_root: I1\n## Items\n\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I1 | report:r1 | current | done | receipt |\n${wake("2026-01-01T10:00Z")}`;
	writeFileSync(path, initial);
	migrate({ root: dir, path });
	appendFileSync(
		path,
		`## Notes\n${"x".repeat(4095).concat("\n").repeat(8193)}${wake("2026-01-01T11:00Z")}${wake("2026-01-01T12:00Z")}`,
	);
	assert.ok(statSync(path).size > 32 * 1024 * 1024);
	clearHeartbeatDisplayCache();
	let bytes = 0,
		maxRead = 0;
	const onRead = (read) => {
		bytes += read.bytes;
		maxRead = Math.max(maxRead, read.bytes);
	};
	const first = await readHeartbeatDisplay({
		root: dir,
		path,
		pageSize: 1,
		onRead,
	});
	assert.equal(first.headProjected, true);
	assert.ok(maxRead <= 65536);
	assert.equal(first.customChecks, "not-performed");
	assert.ok(Buffer.byteLength(first.headText) < 1024 * 1024);
	assert.equal(
		first.headDigest,
		createHash("sha256").update(readFileSync(path)).digest("hex"),
	);
	assert.equal(first.contentHash, version(path));
	assert.equal(first.inventory.items[0].id, "I1");
	assert.equal(parseHeartbeatTaskRoot(first.headText), "I1");
	assert.ok(first.historyPage.total >= 3);
	assert.ok(first.historyPage.nextCursor);
	const discovery = await discoverBoundHeartbeatSource({
		root: dir,
		ledgerPath: path,
		threadId: "parent",
	});
	assert.equal(discovery.complete, false);
	assert.equal(discovery.boundSourceDigest, first.headDigest);
	assert.deepEqual(discovery.candidates, [{ path, associated: true }]);
	bytes = 0;
	const next = await readHeartbeatDisplay({
		root: dir,
		path,
		pageSize: 1,
		cursor: first.historyPage.nextCursor,
		onRead,
	});
	assert.ok(bytes < 8192);
	assert.notEqual(
		next.historyPage.wakes[0].heading,
		first.historyPage.wakes[0].heading,
	);
	const custom = (text, options) => inspectHeartbeatLedger(text, options);
	await assert.rejects(
		readHeartbeatDisplay({ root: dir, path, inspect: custom }),
		/canonical-display-only/,
	);
	const canonical = await readHeartbeatDisplay({
		root: dir,
		path,
		inspect: custom,
		canonicalDisplayOnly: true,
	});
	assert.equal(canonical.customChecks, "not-performed");
	assert.equal(canonical.inventory.certifiesCurrent, false);
	appendFileSync(path, "\n| I2 | report:r2 | stray | done | evidence |\n");
	const invalid = await readHeartbeatDisplay({ root: dir, path });
	assert.ok(
		invalid.inventory.findings.some((f) => f.rule === "item-outside-table"),
	);
	appendFileSync(path, "task_root: I2\n");
	const duplicate = await readHeartbeatDisplay({ root: dir, path });
	assert.throws(
		() => parseHeartbeatTaskRoot(duplicate.headText),
		/exactly once/,
	);
	appendFileSync(path, "thread: another-chat\n");
	const conflicting = await discoverBoundHeartbeatSource({
		root: dir,
		ledgerPath: path,
		threadId: "parent",
	});
	assert.equal(conflicting.candidates[0].associated, false);
});

test("large legacy head remains source bound without migration", async () => {
	const dir = realpathSync(root()),
		path = join(dir, "heartbeat.md");
	writeFileSync(
		path,
		`# Legacy\n## Items\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I1 | report:r | item | done | receipt |\n## History\n`,
	);
	appendFileSync(
		path,
		`${"x".repeat(4095).concat("\n").repeat(8193)}${wake("2026-01-01T10:00Z")}`,
	);
	const result = await readHeartbeatDisplay({ root: dir, path });
	assert.equal(result.isLegacy, true);
	assert.equal(result.headProjected, true);
	assert.equal(result.inventory.items[0].id, "I1");
	assert.equal(
		result.headDigest,
		createHash("sha256").update(readFileSync(path)).digest("hex"),
	);
	assert.equal(existsSync(heartbeatLedgerPairPaths(path).historyPath), false);
});

test("large write_set cells remain bounded while later identity columns and source hashes survive", async () => {
	const payloads = [18, 14, 8].map((n) => "x".repeat(n * 1024 * 1024));
	for (const paired of [false, true]) {
		const dir = realpathSync(root()),
			path = join(dir, "heartbeat.md"),
			paths = heartbeatLedgerPairPaths(path);
		const marker = paired
			? `<!-- heartbeat-head:v2 source=${encodeURIComponent(path)} history=${encodeURIComponent(paths.historyPath)} -->\n`
			: "";
		const rows = payloads
			.map(
				(value, index) =>
					`| I${index + 1} | report:r${index + 1} | item ${index + 1} | done | receipt | owner-${index} |${value}| agent-${index} |`,
			)
			.join("\n");
		const head = `${marker}# Project\nthread: metadata-chat\n## Items\n| id | source | item | status | evidence | owner | write_set | agent_thread_id |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${rows}\n${wake("2026-01-01T10:00Z")}`;
		writeFileSync(path, head);
		let history = "";
		const hash = (value) => createHash("sha256").update(value).digest("hex");
		if (paired) {
			const backup = "legacy backup\n",
				body = head.slice(marker.length);
			history = `<!-- heartbeat-history:v3 source=${encodeURIComponent(path)} body=${hash(body)} base=${hash(head)} bytes=${Buffer.byteLength(head)} backup=${hash(backup)} previous=${hash(backup)} planned=${Buffer.from(head).toString("base64")} -->\n${body}`;
			assert.ok(history.indexOf("\n") > 48 * 1024 * 1024);
			writeFileSync(paths.historyPath, history);
			writeFileSync(paths.legacyBackupPath, backup);
		}
		clearHeartbeatDisplayCache();
		let maxRead = 0,
			totalRead = 0,
			headRead = 0;
		const onRead = (read) => {
			maxRead = Math.max(maxRead, read.bytes);
			totalRead += read.bytes;
			if (read.path === path) headRead += read.bytes;
		};
		const result = await readHeartbeatDisplay({
			root: dir,
			path,
			pageSize: 1,
			onRead,
		});
		assert.equal(result.headProjected, true);
		if (paired)
			assert.equal(
				headRead,
				Buffer.byteLength(head),
				"full planned head is streamed once, with no redundant prefix or empty-suffix scan",
			);
		assert.equal(result.customChecks, "not-performed");
		assert.equal(result.inventory.certifiesCurrent, false);
		assert.equal(result.inventory.passed, false);
		assert.equal(result.inventory.items.length, 3);
		assert.deepEqual(
			result.omittedMetadataFields.map((x) => [x.column, x.bytes]),
			payloads.map((x) => ["write_set", Buffer.byteLength(x)]),
		);
		assert.deepEqual(
			result.inventory.items.map((x) => x.agent_thread_id),
			["agent-0", "agent-1", "agent-2"],
		);
		assert.deepEqual(
			result.inventory.items.map((x) => x.line),
			[paired ? 7 : 6, paired ? 8 : 7, paired ? 9 : 8],
		);
		assert.ok(
			result.inventory.items.every((x) =>
				x.write_set.includes("omitted write_set"),
			),
		);
		assert.equal(result.headDigest, hash(head));
		assert.equal(
			result.contentHash,
			createHash("sha256")
				.update(head)
				.update("\0")
				.update(history)
				.digest("hex"),
		);
		const task = projectHeartbeatTask({
			report: result.inventory,
			root: dir,
			path,
			threadId: "metadata-chat",
			contentHash: result.contentHash,
			modifiedAt: result.modifiedAt,
		});
		assert.equal(task.objectives.length, 3);
		assert.equal(task.source.itemOwners.I3.agentThreadId, "agent-2");
		const bound = await discoverBoundHeartbeatSource({
			root: dir,
			ledgerPath: path,
			threadId: "metadata-chat",
		});
		assert.equal(bound.boundSourceDigest, hash(head));
		assert.equal(bound.candidates[0].associated, true);
		assert.ok(maxRead <= 65536);
		totalRead = 0;
		await readHeartbeatDisplay({ root: dir, path, pageSize: 1, onRead });
		assert.ok(totalRead < 8192);
		const custom = (text, options) => inspectHeartbeatLedger(text, options);
		await assert.rejects(
			readHeartbeatDisplay({ root: dir, path, inspect: custom }),
			/canonical-display-only/,
		);
		assert.equal(
			(
				await readHeartbeatDisplay({
					root: dir,
					path,
					inspect: custom,
					canonicalDisplayOnly: true,
				})
			).customChecks,
			"not-performed",
		);
		if (paired) {
			writeFileSync(paths.historyPath, "invalid header\n");
			const headOnly = await readHeartbeatDiscoveryHead({ root: dir, path });
			assert.equal(headOnly.headDigest, hash(head));
			const discovery = await discoverBoundHeartbeatSource({
				root: dir,
				ledgerPath: path,
				threadId: "metadata-chat",
			});
			assert.equal(discovery.candidates[0].associated, true);
			await assert.rejects(
				readHeartbeatDisplay({ root: dir, path }),
				/invalid|format|integrity/,
			);
		}
	}
});

test("large control and unrecognized metadata cells remain fail closed", async () => {
	const dir = realpathSync(root()),
		path = join(dir, "heartbeat.md");
	for (const field of ["status", "children", "unrecognized"]) {
		const header = `| id | source | item | status | evidence | ${field === "status" ? "note" : field} |`;
		const status = field === "status" ? "x".repeat(33 * 1024 * 1024) : "done";
		const other = field === "status" ? "-" : "x".repeat(33 * 1024 * 1024);
		writeFileSync(
			path,
			`## Items\n${header}\n| --- | --- | --- | --- | --- | --- |\n| I | report:r | task | ${status} | evidence | ${other} |\n`,
		);
		await assert.rejects(
			readHeartbeatDisplay({ root: dir, path }),
			/line exceeds limit/,
		);
	}
});

test("streamed planned header rejects noncanonical payloads and incomplete publication", async () => {
	const dir = realpathSync(root()),
		path = join(dir, "heartbeat.md");
	writeFileSync(
		path,
		`${wake("2026-01-01T10:00Z")}## Items\n| id | source | item | status | evidence |\n| --- | --- | --- | --- | --- |\n| I | report:r | task | done | receipt |\n`,
	);
	migrate({ root: dir, path });
	const paths = heartbeatLedgerPairPaths(path),
		original = readFileSync(paths.historyPath, "utf8");
	const planned = /planned=([A-Za-z0-9+/=]+)/.exec(original)[1];
	const variants = [
		original.replace(`planned=${planned}`, `planned=${"=" + planned.slice(1)}`),
		original.replace(/ bytes=(\d+) /, (_, n) => ` bytes=${Number(n) + 1} `),
		original.replace(
			`planned=${planned}`,
			`planned=${(planned[0] === "A" ? "B" : "A") + planned.slice(1)}`,
		),
		original.replace(" -->\n", " extra -->\n"),
		original.slice(0, original.indexOf("planned=") + 12),
	];
	for (const invalid of variants) {
		writeFileSync(paths.historyPath, invalid);
		clearHeartbeatDisplayCache();
		await assert.rejects(
			readHeartbeatDisplay({ root: dir, path }),
			/invalid|integrity|incomplete|format/,
		);
	}
});
