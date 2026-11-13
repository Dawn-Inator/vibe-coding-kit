import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
	appendHeartbeatWake,
	heartbeatLedgerPairPaths,
	inspectHeartbeatLedgerPair,
	migrateHeartbeatLedgerPair,
	readHeartbeatLedgerPair,
	readHeartbeatLedgerPairVersion,
	recoverHeartbeatLedgerPair,
	writeHeartbeatLedgerPair,
} from "../../src/supervision/heartbeat-ledger-files.mjs";
import { discoverHeartbeatLedgers } from "../../src/tasks/heartbeat-task-source.mjs";
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
	const live = `${wake("2026-01-01T11:00Z")}\n${table("| I1 | report:r1 | changed | done | |")}\n## Notes\n| I2 | report:r2 | stray | done | receipt |\n`;
	const pair = write({ root: dir, path, text: live });
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
	const pair = write({
		root: dir,
		path,
		text: `${wake("2026-01-01T11:00Z")}\n${table("| I1 | report:r1 | changed | owner <- it is hard | |")}`,
	});
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
	const dispatched = write({
		root: dir,
		path,
		text: `${wake("2026-01-01T12:00Z")}\n${table("| I1 | report:r1 | changed | dispatched worker | |")}`,
	});
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

test("bounded reads reject FIFO companions without waiting for a writer", {
	skip: process.platform === "win32",
}, (t) => {
	const dir = root(),
		path = join(dir, "heartbeat.md");
	writeFileSync(path, wake("2026-01-01T10:00Z"));
	const fifo = heartbeatLedgerPairPaths(path).historyPath;
	const result = spawnSync("mkfifo", [fifo], {
		encoding: "utf8",
		timeout: 2000,
	});
	if (result.error?.code === "ENOENT") {
		t.skip("mkfifo unavailable");
		return;
	}
	assert.equal(result.status, 0, result.stderr);
	assert.throws(
		() => readHeartbeatLedgerPair({ root: dir, path, maxBytes: 1024 }),
		/not a file|regular file/i,
	);
});
