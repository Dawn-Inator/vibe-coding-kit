import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { cleanupTempDirs, mkdtempTracked } from "../support/temp-dirs.mjs";

after(cleanupTempDirs);

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = join(HERE, "..", "..");
const TSC = join(KIT_ROOT, "node_modules", "typescript", "bin", "tsc");
const API = join(KIT_ROOT, "src", "supervision", "heartbeat-ledger-api.mjs");

test("heartbeat declarations distinguish raw callback rows/findings from normalized reports", () => {
	assert.ok(existsSync(TSC), `Kit TypeScript compiler is missing: ${TSC}`);
	const fixtureRoot = mkdtempTracked("heartbeat-ledger-types-");
	const fixture = join(fixtureRoot, "api-types.ts");
	const modulePath = relative(fixtureRoot, API).split(sep).join("/");
	const specifier = modulePath.startsWith(".") ? modulePath : `./${modulePath}`;
	writeFileSync(
		fixture,
		[
			`import { heartbeatAuditDue, inspectHeartbeatLedger } from ${JSON.stringify(specifier)};`,
			"const text = \"ledger\";",
			"const report = inspectHeartbeatLedger(text, {",
			"  mode: 'current',",
			"  extraChecks: (context) => {",
			"    // Raw registry rows may omit columns when the table header is malformed.",
			"    // @ts-expect-error owner is optional on callback rows and must be narrowed",
			"    const invalidOwnerLength: number = context.items[0].owner.length;",
			"    const owner = context.items[0].owner;",
			"    if (owner !== undefined) owner.length;",
			"    void invalidOwnerLength;",
			"    return [{ rule: 'custom-check', message: 'finding without severity is normalized' }];",
			"  },",
			"});",
			"const normalizedSeverity: 'error' | 'advisory' = report.findings[0].severity;",
			"const cadenceReason: string = heartbeatAuditDue(text).reason;",
			"void [normalizedSeverity, cadenceReason];",
		].join("\n"),
	);
	const result = spawnSync(
		process.execPath,
		[
			TSC,
			"--pretty", "false",
			"--strict",
			"--noEmit",
			"--target", "ES2022",
			"--module", "NodeNext",
			"--moduleResolution", "NodeNext",
			fixture,
		],
		{ cwd: KIT_ROOT, encoding: "utf8" },
	);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
