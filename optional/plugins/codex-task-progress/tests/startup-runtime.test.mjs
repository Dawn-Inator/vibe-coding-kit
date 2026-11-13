import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  forwardStartupListenerLine,
  StartupListenerBridge,
} from "../runtime/startup-listener-bridge.mjs";

const runtimeRoot = new URL("../runtime/", import.meta.url);

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
