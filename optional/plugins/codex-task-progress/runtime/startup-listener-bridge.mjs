export function forwardStartupListenerLine(line, bridge, writeLine) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }
  if (
    (event?.event === "codex.willLaunch" || event?.event === "codex.didLaunch") &&
    Number.isSafeInteger(event.pid)
  ) {
    bridge.acceptLaunch(event.pid);
  }
  writeLine(`${line}\n`);
  return true;
}

export class StartupListenerBridge {
  #pendingPid = null;
  #pendingConnection = null;
  #queuedResponse = null;
  #pendingTimer = null;
  #setTimer;
  #clearTimer;

  constructor(options = {}) {
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
  }

  get pendingPid() {
    return this.#pendingPid;
  }

  acceptConnection(connection) {
    if (this.#pendingConnection && this.#pendingConnection !== connection) {
      this.#pendingConnection.destroy();
    }
    this.#pendingConnection = connection;
    connection.on?.("error", () => undefined);
    if (this.#queuedResponse) {
      this.#deliver(this.#queuedResponse);
    }
  }

  acceptLaunch(pid, timeoutMs = 21_000) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || this.#pendingPid !== null) {
      return false;
    }
    this.#pendingPid = pid;
    this.#pendingTimer = this.#setTimer(() => this.release(), timeoutMs);
    return true;
  }

  acceptResponse(response) {
    if (!response || typeof response !== "object") {
      return false;
    }
    if (!Number.isSafeInteger(response.pid) || response.pid !== this.#pendingPid) {
      return false;
    }
    if (response.action !== "continue" && response.action !== "complete") {
      this.release();
      return false;
    }
    this.#deliver(response);
    return true;
  }

  release() {
    // Expiring the IPC observation must never signal or otherwise control the app.
    this.#reset(true);
  }

  close() {
    this.release();
  }

  #deliver(response) {
    if (!this.#pendingConnection) {
      this.#queuedResponse = response;
      return;
    }
    this.#pendingConnection.end(`${JSON.stringify(response)}\n`);
    this.#reset(false);
  }

  #reset(destroyConnection) {
    this.#pendingPid = null;
    this.#queuedResponse = null;
    if (this.#pendingTimer) {
      this.#clearTimer(this.#pendingTimer);
      this.#pendingTimer = null;
    }
    if (this.#pendingConnection) {
      if (destroyConnection) {
        this.#pendingConnection.destroy();
      }
      this.#pendingConnection = null;
    }
  }
}
