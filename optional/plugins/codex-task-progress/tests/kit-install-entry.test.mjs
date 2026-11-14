import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  classifyInstallerResult,
  createCommandPlan,
  installerNeedsRestart,
  main as runInstallerMain,
} from "../scripts/install-from-kit.mjs";
import {
  checksumFromOfficialFile,
  ensurePinnedNodeRuntime,
  inspectPinnedNodeRuntime,
  NODE_ARCHIVE_NAME,
  NODE_VERSION,
} from "../scripts/release-node-runtime.mjs";
import {
  configureReleaseSigning,
  createCodesignArgs,
  defaultReleaseSigningConfigPath,
  GOAL_PROGRESS_HELPER_SIGNING_IDENTIFIER,
  GOAL_PROGRESS_STARTUP_LISTENER_SIGNING_IDENTIFIER,
  inspectReleaseSigning,
  parseSigningIdentities,
  resolveReleaseSigning,
} from "../scripts/release-signing.mjs";

test("Kit installer check reports signing status without installing", async () => {
  let report;
  await runInstallerMain({
    check: true,
    signingRunner: signingFixtureRunner(),
    emit: (value) => {
      report = value;
    },
  });
  assert.ok(["ready-to-build", "setup-required"].includes(report.status));
  assert.equal(typeof report.prerequisites.node, "boolean");
  assert.equal(report.prerequisites.releaseRebuildRequired, true);
  assert.ok(["ready", "confirmation-required", "unavailable"].includes(report.signing.status));
});

test("configured signing proceeds through the injected runtime and build pipeline", async () => {
  const commandCalls = [];
  let report;
  const env = {
    GOAL_PROGRESS_CODESIGN_IDENTITY: "9A0CFCD701BC9E8FAE05C12DCB5564C2BE0D1EFA",
    GOAL_PROGRESS_NODE_BINARY: "/fixture/node",
    PATH: "/fixture/bin",
  };
  const fakeRunner = (command, args) => {
    commandCalls.push({ command, args });
    if (command === "/fixture/node" && args[0] === "--version") {
      return { status: 0, stdout: "v24.19.0\n", stderr: "" };
    }
    if (args[0] === "/fixture/pnpm.cjs") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "install" && args[1] === "--json") {
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, code: "INSTALL_OK" }),
        stderr: "",
      };
    }
    throw new Error(`Unexpected injected command: ${command} ${args.join(" ")}`);
  };
  await runInstallerMain({
    env,
    check: false,
    signingRunner: signingFixtureRunner(),
    run: fakeRunner,
    inspectPinnedNodeRuntime: async ({ suppliedBinary }) => ({
      suppliedValid: suppliedBinary === "/fixture/node",
      cachedBinary: null,
      runtimeRoot: "/fixture/runtime",
    }),
    fetchImpl: async () => {
      throw new Error("injected runtime must not download");
    },
    readFileImpl: async () => {
      throw new Error("configured environment identity must not read local config");
    },
    ensurePinnedNodeRuntime: async ({ fetchImpl }) => {
      assert.equal(typeof fetchImpl, "function");
      return {
        nodeBinary: "/fixture/node",
        runtimeRoot: "/fixture/runtime",
        source: "provided",
      };
    },
    resolvePnpm: async (nodeBinary, runtimeRoot, runner, baseEnv) => {
      assert.equal(nodeBinary, "/fixture/node");
      assert.equal(runtimeRoot, "/fixture/runtime");
      assert.equal(runner, fakeRunner);
      assert.deepEqual(baseEnv, env);
      return { pnpmCli: "/fixture/pnpm.cjs", env: { PATH: "/fixture/build-bin" } };
    },
    componentDependenciesInstalled: () => true,
    installerExists: true,
    emit: (value) => {
      report = value;
    },
  });
  assert.deepEqual(report, {
    status: "installed",
    output: { ok: true, code: "INSTALL_OK" },
  });
  assert.deepEqual(
    commandCalls.map(({ args }) => args),
    [
      ["--version"],
      ["/fixture/pnpm.cjs", "run", "build:code"],
      ["/fixture/pnpm.cjs", "run", "build:renderer"],
      ["/fixture/pnpm.cjs", "run", "build:plugin"],
      ["/fixture/pnpm.cjs", "exec", "tsx", "scripts/build_macos_release.ts"],
      ["install", "--json"],
    ],
  );
});

test("pinned Node checksum is checked before tar extraction and temporary files are cleaned", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "goal-progress-test-"));
  const cacheRoot = resolve(sandbox, "cache");
  const temporaryRoot = resolve(sandbox, "temporary");
  await mkdir(temporaryRoot);
  let request = 0;
  let tarWasCalled = false;
  const archive = Buffer.from("not-the-official-archive");
  const fetchImpl = async (url) => {
    request += 1;
    const isChecksumFile = url.endsWith("/SHASUMS256.txt");
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        isChecksumFile ? Buffer.from(`${"0".repeat(64)}  ${NODE_ARCHIVE_NAME}\n`) : archive,
    };
  };
  try {
    await assert.rejects(
      ensurePinnedNodeRuntime({
        cacheRoot,
        temporaryRoot,
        fetchImpl,
        runner: (command) => {
          if (command === "/usr/bin/tar") tarWasCalled = true;
          return { status: 99, stdout: "", stderr: "" };
        },
      }),
      /SHA-256 mismatch/u,
    );
    assert.equal(request, 2);
    assert.equal(tarWasCalled, false);
    assert.deepEqual(await readdir(temporaryRoot), []);
    await assert.rejects(readFile(resolve(cacheRoot, "node-v24.19.0-darwin-arm64/bin/node")));
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("matching cached Node runtime is reused without network access", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "goal-progress-test-"));
  const cacheRoot = resolve(sandbox, "cache");
  const runtimeRoot = resolve(cacheRoot, "node-v24.19.0-darwin-arm64");
  const binary = resolve(runtimeRoot, "bin/node");
  await mkdir(resolve(runtimeRoot, "bin"), { recursive: true });
  const runner = (command, args) => ({
    status: 0,
    stdout: command === binary && args[0] === "--version" ? `${NODE_VERSION}\n` : "",
    stderr: "",
  });
  try {
    const inspected = await inspectPinnedNodeRuntime({ cacheRoot, runner });
    assert.equal(inspected.cachedBinary, binary);
    const result = await ensurePinnedNodeRuntime({
      cacheRoot,
      runner,
      fetchImpl: async () => {
        throw new Error("cache hit must not fetch");
      },
    });
    assert.equal(result.nodeBinary, binary);
    assert.equal(result.source, "private-cache");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("official Node archive is extracted into one cache root and that exact binary is reused", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "goal-progress-test-"));
  const cacheRoot = resolve(sandbox, "cache");
  const temporaryRoot = resolve(sandbox, "temporary");
  await mkdir(temporaryRoot);
  const archive = Buffer.from("verified archive fixture");
  const digest = createHash("sha256").update(archive).digest("hex");
  let downloads = 0;
  const fetchImpl = async (url) => {
    downloads += 1;
    const body = url.endsWith("/SHASUMS256.txt")
      ? Buffer.from(`${digest}  ${NODE_ARCHIVE_NAME}\n`)
      : archive;
    return { ok: true, status: 200, arrayBuffer: async () => body };
  };
  const runner = (command, args) => {
    if (command === "/usr/bin/tar" && args[0] === "-tzf") {
      return {
        status: 0,
        stdout:
          "node-v24.19.0-darwin-arm64/\nnode-v24.19.0-darwin-arm64/bin/\nnode-v24.19.0-darwin-arm64/bin/node\n",
        stderr: "",
      };
    }
    if (command === "/usr/bin/tar" && args.includes("-xzf")) {
      const extractRoot = args[args.indexOf("-C") + 1];
      mkdirSync(resolve(extractRoot, "bin"), { recursive: true });
      writeFileSync(resolve(extractRoot, "bin/node"), "verified Node fixture");
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "--version" && existsSync(command)) {
      return { status: 0, stdout: `${NODE_VERSION}\n`, stderr: "" };
    }
    return { status: 98, stdout: "", stderr: "unexpected fixture command" };
  };
  try {
    const downloaded = await ensurePinnedNodeRuntime({
      cacheRoot,
      temporaryRoot,
      fetchImpl,
      runner,
    });
    const expectedRuntimeRoot = resolve(cacheRoot, "node-v24.19.0-darwin-arm64");
    const expectedBinary = resolve(expectedRuntimeRoot, "bin/node");
    assert.equal(downloaded.source, "downloaded-official");
    assert.equal(downloaded.runtimeRoot, expectedRuntimeRoot);
    assert.equal(downloaded.nodeBinary, expectedBinary);
    assert.equal(await readFile(expectedBinary, "utf8"), "verified Node fixture");
    assert.deepEqual(await readdir(temporaryRoot), []);

    const reused = await ensurePinnedNodeRuntime({
      cacheRoot,
      fetchImpl: async () => {
        throw new Error("cached runtime must not download again");
      },
      runner,
    });
    assert.equal(reused.source, "private-cache");
    assert.equal(reused.nodeBinary, expectedBinary);
    assert.equal(downloads, 2);
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("missing component dependencies put frozen pnpm install before the build plan", () => {
  assert.deepEqual(createCommandPlan({ dependenciesInstalled: false }), [
    ["install", "--frozen-lockfile"],
    ["run", "build:code"],
    ["run", "build:renderer"],
    ["run", "build:plugin"],
    ["exec", "tsx", "scripts/build_macos_release.ts"],
  ]);
  assert.equal(
    createCommandPlan({ dependenciesInstalled: true }).some((step) => step[0] === "install"),
    false,
  );
});

test("installer reports success only for the explicit INSTALL_OK contract", () => {
  assert.deepEqual(classifyInstallerResult(0, { ok: true, code: "INSTALL_OK" }), {
    status: "installed",
  });
  assert.equal(classifyInstallerResult(0, { ok: false, code: "INSTALL_FAILED" }).status, "error");
  assert.equal(classifyInstallerResult(0, { ok: true, code: "OTHER" }).status, "error");
  assert.equal(classifyInstallerResult(1, { ok: true, code: "INSTALL_OK" }).status, "error");
  const pendingConnection = { ok: true, code: "INSTALL_OK", connectionPending: true };
  assert.equal(classifyInstallerResult(0, pendingConnection).status, "error");
  assert.deepEqual(classifyInstallerResult(0, pendingConnection, { deferConnection: true }), {
    status: "installed",
  });
});

test("deferred managed launcher install forwards no-connection flag and accepts backend install while connection is pending", async () => {
  const commandCalls = [];
  let report;
  const env = {
    GOAL_PROGRESS_CODESIGN_IDENTITY: "9A0CFCD701BC9E8FAE05C12DCB5564C2BE0D1EFA",
    GOAL_PROGRESS_NODE_BINARY: "/fixture/node",
    PATH: "/fixture/bin",
  };
  const fakeRunner = (command, args) => {
    commandCalls.push({ command, args });
    if (command === "/fixture/node" && args[0] === "--version")
      return { status: 0, stdout: "v24.19.0\n", stderr: "" };
    if (args[0] === "/fixture/pnpm.cjs") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "install" && args.includes("--defer-connection"))
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, code: "INSTALL_OK", connectionPending: true }),
        stderr: "",
      };
    throw new Error(`Unexpected injected command: ${command} ${args.join(" ")}`);
  };
  await runInstallerMain({
    env,
    deferConnection: true,
    signingRunner: signingFixtureRunner(),
    run: fakeRunner,
    inspectPinnedNodeRuntime: async () => ({
      suppliedValid: true,
      cachedBinary: null,
      runtimeRoot: "/fixture/runtime",
    }),
    ensurePinnedNodeRuntime: async () => ({
      nodeBinary: "/fixture/node",
      runtimeRoot: "/fixture/runtime",
      source: "provided",
    }),
    resolvePnpm: async () => ({
      pnpmCli: "/fixture/pnpm.cjs",
      env: { PATH: "/fixture/build-bin" },
    }),
    componentDependenciesInstalled: () => true,
    installerExists: true,
    emit: (value) => {
      report = value;
    },
  });
  assert.equal(report.status, "installed");
  assert.equal(commandCalls.at(-1).args.includes("--defer-connection"), true);
  assert.equal(commandCalls.at(-1).args.at(-1), "--json");
});

test("restart-required or pending install responses remain setup-required without a Codex restart", () => {
  for (const output of [
    { code: "INSTALL_RESTART_REQUIRED" },
    { code: "INSTALL_PENDING" },
    { code: "INSTALL_RESTART_PENDING" },
    { details: { restartScheduled: true } },
    { details: { restartRequired: true } },
    { details: { needsRestart: true } },
  ]) {
    assert.equal(installerNeedsRestart(output), true);
    assert.equal(classifyInstallerResult(0, output).status, "setup-required");
  }
  assert.equal(classifyInstallerResult(0, { status: "installed" }).status, "error");
  const plan = createCommandPlan({ dependenciesInstalled: true }).flat().join(" ");
  assert.doesNotMatch(plan, /restart|quit|killall|open -a/u);
});

test("archive digest fixture uses the exact official filename", () => {
  const digest = createHash("sha256").update("fixture").digest("hex");
  assert.equal(
    checksumFromOfficialFile(`${digest}  ${NODE_ARCHIVE_NAME}\n`, NODE_ARCHIVE_NAME),
    digest,
  );
  assert.throws(
    () => checksumFromOfficialFile(`${digest}  other.tar.gz\n`, NODE_ARCHIVE_NAME),
    /no entry/u,
  );
});

test("release signing identity prefers the environment without reading local config", async () => {
  let read = false;
  const signing = await resolveReleaseSigning({
    env: {
      GOAL_PROGRESS_CODESIGN_IDENTITY: " Developer ID Application: Example (A1B2C3D4E5) ",
      GOAL_PROGRESS_CODESIGN_CONFIG: "/tmp/ignored-release-signing.json",
    },
    readFileImpl: async () => {
      read = true;
      throw Object.assign(new Error("must not read config"), { code: "ENOENT" });
    },
  });
  assert.equal(signing.identity, "Developer ID Application: Example (A1B2C3D4E5)");
  assert.equal(signing.source, "environment");
  assert.equal(signing.warning, undefined);
  assert.equal(read, false);
});

test("missing release signing config keeps ad-hoc identity and reports its prompt risk", async () => {
  const signing = await resolveReleaseSigning({
    env: {},
    home: "/tmp/codex-home",
    readFileImpl: async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.equal(signing.identity, "-");
  assert.equal(signing.source, "ad-hoc-default");
  assert.match(signing.warning, /repeated Documents access prompts/u);
});

test("an explicit missing signing config fails closed instead of using ad-hoc signing", async () => {
  await assert.rejects(
    resolveReleaseSigning({
      env: { GOAL_PROGRESS_CODESIGN_CONFIG: "/tmp/missing-release-signing.json" },
      readFileImpl: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    }),
    /GOAL_PROGRESS_CODESIGN_CONFIG_MISSING/u,
  );
  await assert.rejects(
    inspectReleaseSigning({
      env: { GOAL_PROGRESS_CODESIGN_CONFIG: "/tmp/missing-release-signing.json" },
      runner: signingFixtureRunner(),
      readFileImpl: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    }),
    /GOAL_PROGRESS_CODESIGN_CONFIG_MISSING/u,
  );
  await assert.rejects(
    resolveReleaseSigning({ env: { GOAL_PROGRESS_CODESIGN_CONFIG: "" } }),
    /GOAL_PROGRESS_CODESIGN_CONFIG_MUST_BE_ABSOLUTE/u,
  );
  await assert.rejects(
    inspectReleaseSigning({
      env: { GOAL_PROGRESS_CODESIGN_CONFIG: "" },
      runner: signingFixtureRunner(),
    }),
    /GOAL_PROGRESS_CODESIGN_CONFIG_MUST_BE_ABSOLUTE/u,
  );
});

test("malformed existing release signing config fails closed", async () => {
  await assert.rejects(
    resolveReleaseSigning({
      env: { GOAL_PROGRESS_CODESIGN_CONFIG: "/tmp/broken-release-signing.json" },
      readFileImpl: async () =>
        '{"schemaVersion":1,"identity":"Developer ID","privateKey":"secret"}',
    }),
    /GOAL_PROGRESS_CODESIGN_CONFIG_INVALID/u,
  );
  await assert.rejects(
    resolveReleaseSigning({
      env: { GOAL_PROGRESS_CODESIGN_CONFIG: "/tmp/invalid-release-signing.json" },
      readFileImpl: async () => '{"schemaVersion":1,"identity":"  "}',
    }),
    /GOAL_PROGRESS_CODESIGN_CONFIG_INVALID/u,
  );
  await assert.rejects(
    resolveReleaseSigning({
      env: { GOAL_PROGRESS_CODESIGN_CONFIG: "/tmp/unreadable-release-signing.json" },
      readFileImpl: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    }),
    /GOAL_PROGRESS_CODESIGN_CONFIG_READ_FAILED/u,
  );
});

test("stable signing identifiers stay fixed across release versions and signing never falls back", () => {
  const identity = "0123456789abcdef0123456789abcdef01234567";
  for (const version of ["0.5.6", "0.5.7", "1.0.0"]) {
    assert.ok(version);
    assert.deepEqual(
      createCodesignArgs(
        identity,
        GOAL_PROGRESS_HELPER_SIGNING_IDENTIFIER,
        `/releases/${version}/helper`,
      ),
      [
        "--force",
        "--sign",
        identity,
        "--identifier",
        "com.codextaskprogress.helper",
        `/releases/${version}/helper`,
      ],
    );
    assert.deepEqual(
      createCodesignArgs(
        identity,
        GOAL_PROGRESS_STARTUP_LISTENER_SIGNING_IDENTIFIER,
        `/releases/${version}/listener`,
      ),
      [
        "--force",
        "--sign",
        identity,
        "--identifier",
        "com.codextaskprogress.startup-listener",
        `/releases/${version}/listener`,
      ],
    );
  }
  assert.deepEqual(
    createCodesignArgs("-", GOAL_PROGRESS_HELPER_SIGNING_IDENTIFIER, "/release/helper"),
    [
      "--force",
      "--sign",
      "-",
      "--identifier",
      GOAL_PROGRESS_HELPER_SIGNING_IDENTIFIER,
      "/release/helper",
    ],
  );
  assert.throws(
    () => createCodesignArgs(identity, "com.codextaskprogress.other", "/release/helper"),
    /GOAL_PROGRESS_CODESIGN_IDENTIFIER_INVALID/u,
  );
});

const signingFixtureOutput = [
  `  1) 9A0CFCD701BC9E8FAE05C12DCB5564C2BE0D1EFA "Apple Development: Example (A1B2C3D4E5)"`,
  `  2) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Example (A1B2C3D4E5)"`,
  `  3) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Apple Distribution: Example (A1B2C3D4E5)"`,
  `  4) ABCDEF0123456789ABCDEF0123456789ABCDEF02 "Developer ID Installer: Example (A1B2C3D4E5)"`,
].join("\n");

function signingFixtureRunner(calls = []) {
  return (command, args) => {
    calls.push({ command, args });
    assert.equal(command, "/usr/bin/security");
    assert.deepEqual(args, ["find-identity", "-v", "-p", "codesigning"]);
    return { status: 0, stdout: `  2 valid identities found\n${signingFixtureOutput}`, stderr: "" };
  };
}

test("signing inspection is read-only and requires confirmation for eligible but unconfigured identities", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "goal-progress-signing-"));
  const calls = [];
  try {
    const signing = await inspectReleaseSigning({
      env: {},
      home: sandbox,
      runner: signingFixtureRunner(calls),
      readFileImpl: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });
    assert.equal(signing.status, "confirmation-required");
    assert.equal(signing.configPath, defaultReleaseSigningConfigPath(sandbox));
    assert.deepEqual(signing.candidates, [
      {
        identity: "9A0CFCD701BC9E8FAE05C12DCB5564C2BE0D1EFA",
        name: "Apple Development: Example (A1B2C3D4E5)",
      },
      {
        identity: "0123456789ABCDEF0123456789ABCDEF01234567",
        name: "Developer ID Application: Example (A1B2C3D4E5)",
      },
    ]);
    assert.equal(calls.length, 1);
    await assert.rejects(readFile(signing.configPath));
    assert.deepEqual(await readdir(sandbox), []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("missing eligible certificates are unavailable and block installer work before runtime setup", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "goal-progress-signing-"));
  let buildOrDownloadCalls = 0;
  let report;
  try {
    await runInstallerMain({
      check: false,
      home: sandbox,
      env: {},
      signingRunner: () => ({ status: 0, stdout: "0 valid identities found\n", stderr: "" }),
      readFileImpl: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      run: () => {
        buildOrDownloadCalls += 1;
        throw new Error("must stop before runtime work");
      },
      emit: (value) => {
        report = value;
      },
    });
    assert.equal(report.status, "setup-required");
    assert.equal(report.signing.status, "unavailable");
    assert.match(report.configureCommand, /--configure-signing/u);
    assert.equal(buildOrDownloadCalls, 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("signing inspection reports configured matching identities and explicit ad-hoc opt-out", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "goal-progress-signing-"));
  const configPath = defaultReleaseSigningConfigPath(sandbox);
  await mkdir(resolve(configPath, ".."), { recursive: true });
  try {
    await writeFileSync(
      resolve(configPath),
      JSON.stringify({
        schemaVersion: 1,
        identity: "9A0CFCD701BC9E8FAE05C12DCB5564C2BE0D1EFA",
      }),
    );
    const configured = await inspectReleaseSigning({
      env: {},
      home: sandbox,
      runner: signingFixtureRunner(),
    });
    assert.equal(configured.status, "ready");
    assert.equal(configured.identity, "9A0CFCD701BC9E8FAE05C12DCB5564C2BE0D1EFA");
    const adhoc = await inspectReleaseSigning({
      env: { GOAL_PROGRESS_CODESIGN_IDENTITY: "-" },
      home: sandbox,
      runner: signingFixtureRunner(),
    });
    assert.equal(adhoc.status, "ready");
    assert.match(adhoc.warning, /ad-hoc signing/iu);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("signing configuration accepts only the selected eligible fingerprint and writes a private key-free file", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "goal-progress-signing-"));
  const configPath = defaultReleaseSigningConfigPath(sandbox);
  const calls = [];
  let writes = 0;
  try {
    await assert.rejects(
      configureReleaseSigning({
        identity: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
        home: sandbox,
        runner: signingFixtureRunner(calls),
        writeFileImpl: async () => {
          writes += 1;
        },
      }),
      /GOAL_PROGRESS_CODESIGN_IDENTITY_NOT_ELIGIBLE/u,
    );
    assert.equal(writes, 0);
    assert.equal(calls.length, 1);

    const configured = await configureReleaseSigning({
      identity: "9a0cFCD701BC9E8FAE05C12DCB5564C2BE0D1EFA",
      home: sandbox,
      runner: signingFixtureRunner(calls),
    });
    assert.equal(configured.changed, true);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved, {
      schemaVersion: 1,
      identity: "9A0CFCD701BC9E8FAE05C12DCB5564C2BE0D1EFA",
    });
    assert.deepEqual(Object.keys(saved).sort(), ["identity", "schemaVersion"]);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);

    const idempotent = await configureReleaseSigning({
      identity: saved.identity,
      home: sandbox,
      runner: signingFixtureRunner(calls),
      writeFileImpl: async () => {
        writes += 1;
      },
    });
    assert.equal(idempotent.changed, false);
    assert.equal(writes, 0);
    await assert.rejects(
      configureReleaseSigning({
        identity: "0123456789ABCDEF0123456789ABCDEF01234567",
        home: sandbox,
        runner: signingFixtureRunner(calls),
      }),
      /GOAL_PROGRESS_CODESIGN_CONFIG_EXISTS_DIFFERENT_IDENTITY/u,
    );
    const replaced = await configureReleaseSigning({
      identity: "0123456789ABCDEF0123456789ABCDEF01234567",
      replace: true,
      home: sandbox,
      runner: signingFixtureRunner(calls),
    });
    assert.equal(replaced.changed, true);
    assert.equal(
      JSON.parse(await readFile(configPath, "utf8")).identity,
      "0123456789ABCDEF0123456789ABCDEF01234567",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a racing writer with the same selected identity is treated as idempotent", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "goal-progress-signing-same-race-"));
  const configPath = defaultReleaseSigningConfigPath(sandbox);
  const identity = "9A0CFCD701BC9E8FAE05C12DCB5564C2BE0D1EFA";
  try {
    const result = await configureReleaseSigning({
      identity,
      home: sandbox,
      runner: signingFixtureRunner(),
      linkImpl: async (_temporaryPath, finalPath) => {
        await mkdir(resolve(finalPath, ".."), { recursive: true });
        await writeFile(finalPath, JSON.stringify({ schemaVersion: 1, identity }));
        throw Object.assign(new Error("already exists"), { code: "EEXIST" });
      },
    });
    assert.equal(result.status, "configured");
    assert.equal(result.changed, false);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).identity, identity);
    assert.deepEqual(await readdir(resolve(configPath, "..")), ["release-signing.json"]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("concurrent different signing choices cannot overwrite the first published config", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "goal-progress-signing-race-"));
  const configPath = defaultReleaseSigningConfigPath(sandbox);
  let releaseFirstReads;
  let releaseSecondReads;
  const firstReadsReady = new Promise((resolveReady) => {
    releaseFirstReads = resolveReady;
  });
  const secondReadsReady = new Promise((resolveReady) => {
    releaseSecondReads = resolveReady;
  });
  let configReads = 0;
  const synchronizedReadFile = async (path, encoding) => {
    if (path !== configPath) return readFile(path, encoding);
    configReads += 1;
    if (configReads <= 2) {
      if (configReads === 2) releaseFirstReads();
      await firstReadsReady;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    if (configReads <= 4) {
      if (configReads === 4) releaseSecondReads();
      await secondReadsReady;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    return readFile(path, encoding);
  };
  try {
    const results = await Promise.allSettled([
      configureReleaseSigning({
        identity: "9A0CFCD701BC9E8FAE05C12DCB5564C2BE0D1EFA",
        home: sandbox,
        runner: signingFixtureRunner(),
        readFileImpl: synchronizedReadFile,
      }),
      configureReleaseSigning({
        identity: "0123456789ABCDEF0123456789ABCDEF01234567",
        home: sandbox,
        runner: signingFixtureRunner(),
        readFileImpl: synchronizedReadFile,
      }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.match(
      rejected.reason.message,
      /GOAL_PROGRESS_CODESIGN_CONFIG_EXISTS_DIFFERENT_IDENTITY/u,
    );
    const published = JSON.parse(await readFile(configPath, "utf8"));
    const winner = results.find((result) => result.status === "fulfilled");
    assert.equal(published.identity, winner.value.identity);
    assert.deepEqual(await readdir(resolve(configPath, "..")), ["release-signing.json"]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("signing candidate parser filters Apple Distribution and non-application identities", () => {
  assert.deepEqual(
    parseSigningIdentities(signingFixtureOutput).map(({ name }) => name),
    ["Apple Development: Example (A1B2C3D4E5)", "Developer ID Application: Example (A1B2C3D4E5)"],
  );
});
