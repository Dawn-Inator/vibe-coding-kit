import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import vm from "node:vm";
import {
  forwardStartupListenerLine,
  StartupListenerBridge,
} from "../runtime/startup-listener-bridge.mjs";

const runtimeRoot = new URL("../runtime/", import.meta.url);
const startupListenerSource = new URL(
  "../platform/macos/startup-listener/main.swift",
  import.meta.url,
);
const execFileAsync = promisify(execFile);

test("native startup listener replacement query is positive-only and observes both launch edges", async () => {
  const source = await readFile(startupListenerSource, "utf8");
  assert.match(source, /willLaunchApplicationNotification/u);
  assert.match(source, /didLaunchApplicationNotification/u);
  assert.match(source, /startup\.inspect-replacement/u);
  assert.match(source, /startup\.replacement-check/u);
  for (const field of [
    "schemaVersion",
    "pid",
    "requestId",
    "launchedAt",
    "deadlineAtMs",
    "allowed",
    "checkedAtMs",
    "reason",
  ]) {
    assert.match(source, new RegExp(`\\b${field}\\b`, "u"));
  }
  assert.doesNotMatch(source, /kill\(|SIGSTOP|SIGCONT|terminate\(/u);
  assert.match(source, /inputBuffer\.count >= 4_096/u);
  assert.match(source, /data\.prefix\(16_384\)/u);
  assert.match(source, /\[SIGINT, SIGTERM\]/u);
});

test("native AppKit listener proves the launch window and fails closed after readiness", async (context) => {
  if (process.platform !== "darwin") {
    context.skip("requires macOS AppKit and a GUI login session");
    return;
  }
  try {
    await execFileAsync("swiftc", ["-version"]);
  } catch {
    context.skip("requires swiftc");
    return;
  }
  try {
    await execFileAsync("/bin/launchctl", ["print", `gui/${process.getuid()}`], { timeout: 3_000 });
  } catch {
    context.skip("requires an available Aqua GUI bootstrap (launchctl print gui/<uid> failed)");
    return;
  }

  const scratch = await realpath(await mkdtemp(join(tmpdir(), "codex-startup-fixture-")));
  const appPath = join(scratch, "StartupFixture.app");
  const contentsPath = join(appPath, "Contents");
  const executablePath = join(contentsPath, "MacOS", "StartupFixture");
  const fixtureSourcePath = join(scratch, "Fixture.swift");
  const listenerPath = join(scratch, "goal-progress-startup-listener");
  const fixtureReadyPath = join(scratch, "ready");
  const fixtureMetadataPath = join(scratch, "fixture-metadata.json");
  const bundleId = "com.codextaskprogress.startup-fixture";
  let fixturePid;
  let fixtureMetadata;
  let listener;
  let listenerExit;
  let listenerOutput = "";
  let listenerError = "";
  const responses = [];
  let stdoutBuffer = "";
  let readyResolve;
  let launchResolve;
  let stdoutFailure;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  const launched = new Promise((resolve) => {
    launchResolve = resolve;
  });
  const fail = new Promise((_, reject) => {
    stdoutFailure = reject;
  });
  const diagnostics = async () => {
    let metadata = null;
    try {
      metadata = JSON.parse(await readFile(fixtureMetadataPath, "utf8"));
    } catch {
      // Absence of the fixture's own startup marker means Launch Services did not run it.
    }
    const diagnosis = metadata
      ? "fixture process started; missing notification indicates an AppKit identity or notification mapping issue"
      : "fixture process did not write its startup marker; GUI/Launch Services may be unavailable or the app failed before entry";
    return `${diagnosis}\nlistener stdout: ${listenerOutput || "<empty>"}\nlistener stderr: ${listenerError || "<empty>"}\nfixture metadata: ${metadata ? JSON.stringify(metadata) : "<not written>"}`;
  };
  const withTimeout = (promise, label, ms = 10_000) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        diagnostics().then(
          (details) => reject(new Error(`timed out waiting for ${label}\n${details}`)),
          reject,
        );
      }, ms);
      Promise.race([promise, fail])
        .then(resolve, reject)
        .finally(() => clearTimeout(timeout));
    });

  const fixtureSource = `import AppKit\nimport Foundation\n\nlet readyPath = CommandLine.arguments[1]\nlet metadataPath = CommandLine.arguments[2]\nlet metadata: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "executablePath": CommandLine.arguments[0], "bundlePath": Bundle.main.bundleURL.path, "bundleIdentifier": Bundle.main.bundleIdentifier ?? ""]\nif let data = try? JSONSerialization.data(withJSONObject: metadata) { try? data.write(to: URL(fileURLWithPath: metadataPath), options: .atomic) }\nfinal class FixtureDelegate: NSObject, NSApplicationDelegate {\n    func applicationWillFinishLaunching(_ notification: Notification) {\n        Thread.sleep(forTimeInterval: 1.2)\n    }\n    func applicationDidFinishLaunching(_ notification: Notification) {\n        FileManager.default.createFile(atPath: readyPath, contents: Data())\n        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { NSApp.terminate(nil) }\n    }\n}\nlet app = NSApplication.shared\nlet delegate = FixtureDelegate()\napp.delegate = delegate\napp.setActivationPolicy(.regular)\napp.run()\n`;
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleExecutable</key><string>StartupFixture</string><key>CFBundleName</key><string>StartupFixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><false/></dict></plist>`;

  try {
    await mkdir(join(contentsPath, "MacOS"), { recursive: true });
    await writeFile(join(contentsPath, "Info.plist"), infoPlist);
    await writeFile(fixtureSourcePath, fixtureSource);
    await execFileAsync("swiftc", [fixtureSourcePath, "-o", executablePath]);
    await execFileAsync("swiftc", [startupListenerSource.pathname, "-o", listenerPath]);
    listener = spawn(listenerPath, [bundleId, appPath, executablePath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    listenerExit = once(listener, "exit").catch(() => undefined);
    listener.stdout.setEncoding("utf8");
    listener.stderr.setEncoding("utf8");
    listener.stdout.on("data", (chunk) => {
      listenerOutput += chunk;
      stdoutBuffer += chunk;
      while (true) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.event === "listener.ready") readyResolve(message);
          if (message.event === "codex.willLaunch" || message.event === "codex.didLaunch")
            launchResolve(message);
          if (message.event === "startup.replacement-check") responses.push(message);
        } catch {
          stdoutFailure(new Error(`invalid native listener output: ${line}`));
        }
      }
    });
    listener.stderr.on("data", (chunk) => {
      listenerError += chunk;
    });
    listener.once("error", stdoutFailure);
    listener.once("exit", (code, signal) => {
      if (code !== 0)
        stdoutFailure(new Error(`native listener exited ${code ?? signal}: ${listenerError}`));
    });
    await withTimeout(ready, "listener.ready");

    await execFileAsync("/usr/bin/open", [
      "-n",
      "-g",
      appPath,
      "--args",
      fixtureReadyPath,
      fixtureMetadataPath,
    ]);
    const launchEvent = await withTimeout(launched, "fixture launch notification");
    fixturePid = launchEvent.pid;
    fixtureMetadata = JSON.parse(await readFile(fixtureMetadataPath, "utf8"));
    assert.equal(
      fixtureMetadata.pid,
      fixturePid,
      "Launch Services notification PID must identify the test fixture",
    );
    assert.equal(await realpath(fixtureMetadata.executablePath), executablePath);

    const request = (overrides = {}) => ({
      schemaVersion: 1,
      event: "startup.inspect-replacement",
      pid: launchEvent.pid,
      requestId: randomUUID(),
      launchedAt: launchEvent.launchedAt,
      deadlineAtMs: launchEvent.deadlineAtMs,
      ...overrides,
    });
    const ask = async (payload) => {
      const previous = responses.length;
      listener.stdin.write(`${JSON.stringify(payload)}\n`);
      while (responses.length === previous) {
        await new Promise((resolve, reject) => {
          let poll;
          const timeout = setTimeout(() => {
            clearInterval(poll);
            reject(new Error("timed out waiting for replacement-check"));
          }, 3_000);
          poll = setInterval(() => {
            if (responses.length > previous) {
              clearInterval(poll);
              clearTimeout(timeout);
              resolve();
            }
          }, 10);
          timeout.unref?.();
        });
      }
      return responses[previous];
    };

    const immediate = await ask(request());
    assert.equal(immediate.pid, fixturePid);
    assert.equal(
      immediate.allowed,
      true,
      `expected pre-finish positive native proof: ${JSON.stringify(immediate)}`,
    );
    assert.equal((await ask(request({ pid: fixturePid + 1 }))).allowed, false);
    assert.equal((await ask(request({ launchedAt: "1970-01-01T00:00:00Z" }))).allowed, false);
    assert.equal((await ask(request({ deadlineAtMs: Date.now() - 1 }))).allowed, false);
    const unknown = await ask({ ...request(), event: "startup.unknown" });
    assert.equal(unknown.allowed, false);
    assert.equal(unknown.reason, "unknown_message");

    const readyDeadline = Date.now() + 5_000;
    let readyExists = false;
    while (Date.now() < readyDeadline && !readyExists) {
      try {
        await readFile(fixtureReadyPath);
        readyExists = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(readyExists, true, "fixture should reach applicationDidFinishLaunching");
    const afterReady = await ask(request());
    assert.equal(afterReady.allowed, false);
  } finally {
    if (listener?.stdin.writable) {
      listener.stdin.write(
        `${JSON.stringify({ schemaVersion: 1, pid: fixturePid, action: "continue" })}\n`,
      );
      listener.stdin.end();
    }
    if (!fixtureMetadata) {
      try {
        fixtureMetadata = JSON.parse(await readFile(fixtureMetadataPath, "utf8"));
      } catch {
        fixtureMetadata = null;
      }
    }
    if (fixtureMetadata && Number.isInteger(fixtureMetadata.pid)) {
      try {
        const reportedCommand = (
          await execFileAsync("/bin/ps", ["-p", String(fixtureMetadata.pid), "-o", "command="])
        ).stdout.trim();
        const ownsFixture =
          (await realpath(fixtureMetadata.executablePath)
            .then((path) => path === executablePath)
            .catch(() => false)) &&
          fixtureMetadata.bundlePath === appPath &&
          fixtureMetadata.bundleIdentifier === bundleId &&
          (reportedCommand === executablePath || reportedCommand.startsWith(`${executablePath} `));
        if (ownsFixture) {
          await execFileAsync("/bin/kill", ["-TERM", String(fixtureMetadata.pid)]);
        }
      } catch {
        // The owned fixture may already have exited during cleanup.
      }
    }
    if (listener && listener.exitCode === null && listener.signalCode === null) {
      listener.kill("SIGTERM");
      await Promise.race([
        listenerExit?.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    await rm(scratch, { recursive: true, force: true });
  }
});

test("JXA source observes matching didLaunch notifications without controlling the app", async () => {
  const source = await readFile(new URL("startup-listener.jxa", runtimeRoot), "utf8");
  const output = [];
  const taskInstances = [];
  const responseData = [
    JSON.stringify({ schemaVersion: 1, pid: 42, action: "complete" }),
    "malformed response",
    "",
  ];
  let observerName;
  let observerHandler;
  const stdout = {
    writeData(data) {
      output.push(JSON.parse(data));
    },
  };
  const taskFactory = {
    get init() {
      const task = {
        launchAndReturnError() {
          taskInstances.push(this);
          return true;
        },
      };
      Object.defineProperty(task, "waitUntilExit", {
        get() {
          if (taskInstances.length === 1) {
            const valid = {
              bundleIdentifier: "com.openai.codex",
              bundleURL: { path: "/Applications/Codex.app" },
              executableURL: { path: "/Applications/Codex.app/Contents/MacOS/Codex" },
            };
            observerHandler({
              userInfo: { objectForKey: () => ({ ...valid, processIdentifier: 43 }) },
            });
          }
          return undefined;
        },
      });
      pipe.fileHandleForReading.readDataToEndOfFile = responseData[taskInstances.length - 1];
      return task;
    },
  };
  const fileHandle = { readDataToEndOfFile: "" };
  const pipe = { fileHandleForReading: fileHandle };
  const center = {
    addObserverForNameObjectQueueUsingBlock(name, _object, _queue, handler) {
      observerName = name;
      observerHandler = handler;
      return "observer-token";
    },
    removeObserver(token) {
      assert.equal(token, "observer-token");
    },
  };
  const runLoop = {};
  Object.defineProperty(runLoop, "run", {
    get() {
      const fire = (identity, pid) =>
        observerHandler({
          userInfo: {
            objectForKey: () => ({
              ...identity,
              processIdentifier: pid,
              launchDate: "launch-date",
            }),
          },
        });
      fire(
        {
          bundleIdentifier: "wrong",
          bundleURL: { path: "/Applications/Codex.app" },
          executableURL: { path: "/Applications/Codex.app/Contents/MacOS/Codex" },
        },
        10,
      );
      fire(
        {
          bundleIdentifier: "com.openai.codex",
          bundleURL: { path: "/Applications/Other.app" },
          executableURL: { path: "/Applications/Codex.app/Contents/MacOS/Codex" },
        },
        11,
      );
      fire(
        {
          bundleIdentifier: "com.openai.codex",
          bundleURL: { path: "/Applications/Codex.app" },
          executableURL: { path: "/Applications/Codex.app/Contents/MacOS/Other" },
        },
        12,
      );
      const valid = {
        bundleIdentifier: "com.openai.codex",
        bundleURL: { path: "/Applications/Codex.app" },
        executableURL: { path: "/Applications/Codex.app/Contents/MacOS/Codex" },
      };
      fire(valid, 42);
      fire(valid, 44); // A malformed response must release the pending observer slot.
      fire(valid, 45);
      return undefined;
    },
  });
  const appKit = {
    NSWorkspaceDidLaunchApplicationNotification: "did-launch",
    NSWorkspaceApplicationKey: "application-key",
    NSWorkspace: { sharedWorkspace: { notificationCenter: center } },
  };
  const foundation = {
    NSUTF8StringEncoding: "utf8",
    NSOperationQueue: { mainQueue: "main-queue" },
    NSTask: { alloc: taskFactory },
    NSPipe: { pipe },
    NSURL: { fileURLWithPath: (path) => path },
    NSFileHandle: { fileHandleWithStandardOutput: stdout, fileHandleWithNullDevice: "null" },
    NSString: { alloc: { initWithDataEncoding: (data) => data } },
    NSISO8601DateFormatter: { alloc: { init: { stringFromDate: () => "2026-11-13T12:00:00Z" } } },
    NSProcessInfo: { processInfo: { processIdentifier: 7 } },
    NSRunLoop: { mainRunLoop: runLoop },
  };
  const context = {
    ObjC: {
      import() {},
      unwrap: (value) => value,
    },
    Ref: () => ({}),
    $: (value) => ({ dataUsingEncoding: () => value }),
    Date,
    JSON,
    Number,
    Array,
    Object,
    String,
    Math,
    Error,
  };
  Object.assign(context.$, appKit, foundation);
  vm.runInNewContext(source, context, { filename: "startup-listener.jxa" });
  assert.throws(() => context.run([]), /usage: startup-listener\.jxa/u);
  context.run([
    "com.openai.codex",
    "/Applications/Codex.app",
    "/Applications/Codex.app/Contents/MacOS/Codex",
    "/tmp/socket",
  ]);

  assert.equal(observerName, "did-launch");
  assert.deepEqual(
    output.map(({ event }) => event),
    ["listener.ready", "codex.didLaunch", "codex.didLaunch", "codex.didLaunch"],
  );
  assert.deepEqual(
    { ...output[1], deadlineAtMs: undefined },
    {
      schemaVersion: 1,
      event: "codex.didLaunch",
      pid: 42,
      bundleId: "com.openai.codex",
      appPath: "/Applications/Codex.app",
      executablePath: "/Applications/Codex.app/Contents/MacOS/Codex",
      launchedAt: "2026-11-13T12:00:00Z",
      deadlineAtMs: undefined,
    },
  );
  assert.ok(Number.isSafeInteger(output[1].deadlineAtMs));
  assert.deepEqual(
    output.filter(({ event }) => event === "codex.didLaunch").map(({ pid }) => pid),
    [42, 44, 45],
  );
  assert.equal("kill" in context.$, false);
});

test("source bridge accepts didLaunch IPC, times out and closes without app signals", () => {
  let timerCallback;
  let nextTimer = 0;
  const timersCleared = [];
  const bridge = new StartupListenerBridge({
    setTimer(callback) {
      timerCallback = callback;
      return ++nextTimer;
    },
    clearTimer(timer) {
      timersCleared.push(timer);
    },
  });
  const connection = new EventEmitter();
  connection.destroyed = false;
  connection.destroy = () => {
    connection.destroyed = true;
  };
  connection.end = (value) => {
    connection.response = value;
  };

  assert.equal(bridge.acceptLaunch(42), true); // Node wrapper maps codex.didLaunch to this IPC slot.
  assert.equal(bridge.pendingPid, 42);
  bridge.acceptConnection(connection);
  assert.equal(bridge.acceptResponse({ schemaVersion: 1, pid: 42, action: "complete" }), true);
  assert.equal(JSON.parse(connection.response).pid, 42);
  assert.equal(bridge.pendingPid, null);
  assert.deepEqual(timersCleared, [1]);

  assert.equal(bridge.acceptLaunch(43), true);
  const timeoutConnection = new EventEmitter();
  timeoutConnection.destroyed = false;
  timeoutConnection.destroy = () => {
    timeoutConnection.destroyed = true;
  };
  timeoutConnection.end = () => undefined;
  bridge.acceptConnection(timeoutConnection);
  timerCallback();
  assert.equal(bridge.pendingPid, null);
  assert.equal(timeoutConnection.destroyed, true);
  assert.equal(bridge.acceptLaunch(44), true);
  bridge.close();
  assert.equal(bridge.pendingPid, null);
  assert.equal("continueProcess" in bridge, false);
});

test("runtime dispatcher routes launch events through IPC and forwards valid output", () => {
  const bridge = new StartupListenerBridge({ setTimer: () => 1, clearTimer() {} });
  const output = [];
  for (const line of [
    JSON.stringify({ schemaVersion: 1, event: "listener.ready", pid: 7 }),
    JSON.stringify({ schemaVersion: 1, event: "codex.didLaunch", pid: 42 }),
    JSON.stringify({ schemaVersion: 1, event: "codex.willLaunch", pid: 43 }),
    "not json",
    JSON.stringify({ schemaVersion: 1, event: "codex.didLaunch", pid: "44" }),
  ]) {
    forwardStartupListenerLine(line, bridge, (value) => output.push(value));
  }
  assert.equal(bridge.pendingPid, 42);
  assert.equal(output.length, 4);
  assert.match(output[0], /listener\.ready/u);
  assert.match(output[1], /codex\.didLaunch/u);
  assert.match(output[2], /codex\.willLaunch/u);
  assert.match(output[3], /codex\.didLaunch/u);
  bridge.close();
});
