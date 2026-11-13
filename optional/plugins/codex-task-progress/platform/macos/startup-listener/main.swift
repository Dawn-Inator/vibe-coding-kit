import AppKit
import Darwin
import Foundation

private struct StartupEvent: Encodable {
    let schemaVersion = 1
    let event = "codex.didLaunch"
    let pid: Int32
    let bundleId: String
    let appPath: String
    let executablePath: String
    let launchedAt: String
    let deadlineAtMs: Int64
}

private struct StartupReady: Encodable {
    let schemaVersion = 1
    let event = "listener.ready"
    let pid: Int32
}

private struct StartupResponse: Decodable {
    let schemaVersion: Int
    let pid: Int32
    let action: String
}

private final class CodexStartupListener: NSObject {
    private let bundleId: String
    private let appPath: String
    private let executablePath: String
    private let formatter = ISO8601DateFormatter()
    private var inputBuffer = Data()
    private var pendingPid: pid_t?
    private var safetyTimeout: DispatchWorkItem?
    private var signalSources: [DispatchSourceSignal] = []

    init(bundleId: String, appPath: String, executablePath: String) {
        self.bundleId = bundleId
        self.appPath = appPath
        self.executablePath = executablePath
        super.init()
    }

    private func clearPendingProcess() {
        safetyTimeout?.cancel()
        safetyTimeout = nil
        pendingPid = nil
    }

    private func handleResponseLine(_ line: Data) {
        guard let response = try? JSONDecoder().decode(StartupResponse.self, from: line),
              response.schemaVersion == 1,
              response.pid == pendingPid else {
            return
        }
        guard response.action == "continue" || response.action == "complete" else {
            clearPendingProcess()
            return
        }
        safetyTimeout?.cancel()
        safetyTimeout = nil
        pendingPid = nil
    }

    private func consumeInput(_ data: Data) {
        inputBuffer.append(data)
        while let newline = inputBuffer.firstIndex(of: 0x0A) {
            let line = inputBuffer[..<newline]
            inputBuffer.removeSubrange(...newline)
            if !line.isEmpty {
                handleResponseLine(Data(line))
            }
        }
    }

    private func configureInput() {
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async {
                guard let self else {
                    return
                }
                if data.isEmpty {
                    self.clearPendingProcess()
                    exit(0)
                }
                self.consumeInput(data)
            }
        }
    }

    private func configureSignals() {
        for signalNumber in [SIGINT, SIGTERM] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(
                signal: signalNumber,
                queue: .main
            )
            source.setEventHandler { [weak self] in
                self?.clearPendingProcess()
                exit(0)
            }
            source.resume()
            signalSources.append(source)
        }
    }

    private func send<T: Encodable>(_ event: T) -> Bool {
        do {
            var data = try JSONEncoder().encode(event)
            data.append(0x0A)
            try FileHandle.standardOutput.write(contentsOf: data)
            return true
        } catch {
            return false
        }
    }

    private func handleDidLaunch(_ application: NSRunningApplication) {
        guard pendingPid == nil,
              application.bundleIdentifier == bundleId,
              application.bundleURL?.path == appPath,
              application.executableURL?.path == executablePath else {
            return
        }

        let pid = application.processIdentifier
        pendingPid = pid
        let launchedAt = formatter.string(from: application.launchDate ?? Date())
        let event = StartupEvent(
            pid: pid,
            bundleId: bundleId,
            appPath: appPath,
            executablePath: executablePath,
            launchedAt: launchedAt,
            deadlineAtMs: Int64(Date().timeIntervalSince1970 * 1_000) + 20_000
        )
        guard send(event) else {
            clearPendingProcess()
            return
        }

        let timeout = DispatchWorkItem { [weak self] in
            self?.clearPendingProcess()
        }
        safetyTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: timeout)
    }

    func run() {
        configureInput()
        configureSignals()
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didLaunchApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let application = notification.userInfo?[
                NSWorkspace.applicationUserInfoKey
            ] as? NSRunningApplication else {
                return
            }
            self?.handleDidLaunch(application)
        }
        guard send(StartupReady(pid: getpid())) else {
            exit(1)
        }
        RunLoop.main.run()
    }
}

let arguments = CommandLine.arguments
guard arguments.count == 4 else {
    fputs("usage: goal-progress-startup-listener <bundle-id> <app-path> <executable-path>\n", stderr)
    exit(64)
}

private let listener = CodexStartupListener(
    bundleId: arguments[1],
    appPath: arguments[2],
    executablePath: arguments[3]
)
listener.run()
