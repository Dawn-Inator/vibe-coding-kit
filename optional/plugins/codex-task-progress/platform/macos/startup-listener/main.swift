import AppKit
import Darwin
import Foundation

private struct StartupEvent: Encodable {
    let schemaVersion = 1
    let event: String
    let pid: Int32
    let bundleId: String
    let appPath: String
    let executablePath: String
    let launchedAt: String
    let deadlineAtMs: Int64
}

private struct StartupReplacementRequest: Decodable {
    let schemaVersion: Int
    let event: String
    let pid: Int32
    let requestId: String
    let launchedAt: String
    let deadlineAtMs: Int64
}

private struct StartupReplacementReply: Encodable {
    let schemaVersion = 1
    let event = "startup.replacement-check"
    let pid: Int32
    let requestId: String
    let allowed: Bool
    let checkedAtMs: Int64
    let reason: String
}

private struct PendingLaunch {
    let application: NSRunningApplication
    let pid: pid_t
    let launchedAt: String
    let birthDate: Date?
    let deadlineAtMs: Int64
    let eventName: String
    var queuedDidLaunch: NSRunningApplication?
}

private struct LaunchEdgeIdentity: Hashable {
    let pid: pid_t
    let birthDate: Date
    let bundleId: String
    let appPath: String
    let executablePath: String
    let eventName: String
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
    private var pendingLaunch: PendingLaunch?
    private var recentlyEmittedEdges: [LaunchEdgeIdentity] = []
    private var discardingOversizedLine = false
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
        pendingLaunch = nil
    }

    private func handleResponseLine(_ line: Data) {
        guard let response = try? JSONDecoder().decode(StartupResponse.self, from: line),
              response.schemaVersion == 1,
              response.pid == pendingLaunch?.pid else {
            return
        }
        guard response.action == "continue" || response.action == "complete" else {
            clearPendingProcess()
            return
        }
        let queuedDidLaunch = response.action == "continue"
            ? pendingLaunch?.queuedDidLaunch
            : nil
        let shouldEmitQueuedDidLaunch = queuedDidLaunch.map {
            matchesConfiguredApplication($0)
                && hasSameActualLaunch(as: pendingLaunch?.application, and: $0)
                && !$0.isTerminated
        } ?? false
        safetyTimeout?.cancel()
        safetyTimeout = nil
        pendingLaunch = nil
        if shouldEmitQueuedDidLaunch, let queuedDidLaunch {
            handleLaunch(queuedDidLaunch, eventName: "codex.didLaunch")
        }
    }

    private func consumeInput(_ data: Data) {
        let boundedInput = data.prefix(16_384)
        for byte in boundedInput {
            if discardingOversizedLine {
                if byte == 0x0A {
                    discardingOversizedLine = false
                }
                continue
            }
            if byte == 0x0A {
                let line = inputBuffer
                inputBuffer.removeAll(keepingCapacity: true)
                if !line.isEmpty {
                    handleInputLine(line)
                }
            } else if inputBuffer.count >= 4_096 || inputBuffer.count >= 16_384 {
                inputBuffer.removeAll(keepingCapacity: true)
                discardingOversizedLine = true
            } else {
                inputBuffer.append(byte)
            }
        }
        if data.count > 16_384 {
            inputBuffer.removeAll(keepingCapacity: true)
            discardingOversizedLine = !data.dropFirst(16_384).contains(0x0A)
        }
    }

    private func handleInputLine(_ line: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
            return
        }
        if object["event"] as? String == "startup.inspect-replacement" {
            handleReplacementRequest(line)
            return
        }
        if object["event"] != nil {
            sendFailureReply(from: object, reason: "unknown_message")
            return
        }
        handleResponseLine(line)
    }

    private func sendFailureReply(from object: [String: Any], reason: String) {
        guard let pidValue = object["pid"] as? Int,
              let pid = Int32(exactly: pidValue),
              let requestId = object["requestId"] as? String else {
            return
        }
        _ = send(StartupReplacementReply(
            pid: pid,
            requestId: requestId,
            allowed: false,
            checkedAtMs: Int64(Date().timeIntervalSince1970 * 1_000),
            reason: reason
        ))
    }

    private func handleReplacementRequest(_ line: Data) {
        let request = try? JSONDecoder().decode(StartupReplacementRequest.self, from: line)
        guard let request else {
            guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  object["event"] as? String == "startup.inspect-replacement" else {
                return
            }
            sendFailureReply(from: object, reason: "request_invalid")
            return
        }
        let now = Date()
        let nowMs = Int64(now.timeIntervalSince1970 * 1_000)
        let pending = pendingLaunch
        let appLaunchDate = pending?.application.launchDate
        let launchAge = appLaunchDate.map { now.timeIntervalSince($0) }
        let allowed = request.schemaVersion == 1
            && request.event == "startup.inspect-replacement"
            && UUID(uuidString: request.requestId) != nil
            && request.pid == pending?.pid
            && request.launchedAt == pending?.launchedAt
            && request.deadlineAtMs >= nowMs
            && request.deadlineAtMs <= (pending?.deadlineAtMs ?? 0)
            && pending?.application.bundleIdentifier == bundleId
            && pending?.application.bundleURL?.path == appPath
            && pending?.application.executableURL?.path == executablePath
            && pending?.birthDate != nil
            && appLaunchDate != nil
            && appLaunchDate == pending?.birthDate
            && launchAge.map { $0 >= 0 && $0 <= 5 } == true
            && pending?.application.isFinishedLaunching == false
            && pending?.application.isActive == false
            && pending?.application.isTerminated == false
        let reason: String
        if allowed {
            reason = "verified"
        } else if pending == nil || request.pid != pending?.pid {
            reason = "pending_event_mismatch"
        } else if request.launchedAt != pending?.launchedAt {
            reason = "launch_timestamp_mismatch"
        } else if appLaunchDate == nil || pending?.birthDate == nil || appLaunchDate != pending?.birthDate {
            reason = "launch_birth_unconfirmed"
        } else if launchAge.map({ $0 < 0 || $0 > 5 }) ?? true {
            reason = "launch_not_fresh"
        } else if request.deadlineAtMs < nowMs || request.deadlineAtMs > (pending?.deadlineAtMs ?? 0) {
            reason = "deadline_invalid"
        } else if pending?.application.isFinishedLaunching != false {
            reason = "already_finished_launching"
        } else if pending?.application.isActive != false {
            reason = "application_active"
        } else if pending?.application.isTerminated != false {
            reason = "application_terminated"
        } else {
            reason = "identity_mismatch"
        }
        _ = send(StartupReplacementReply(
            pid: request.pid,
            requestId: request.requestId,
            allowed: allowed,
            checkedAtMs: nowMs,
            reason: reason
        ))
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

    private func matchesConfiguredApplication(_ application: NSRunningApplication) -> Bool {
        application.bundleIdentifier == bundleId
            && application.bundleURL?.path == appPath
            && application.executableURL?.path == executablePath
    }

    private func hasSameActualLaunch(
        as first: NSRunningApplication?,
        and second: NSRunningApplication
    ) -> Bool {
        guard let first,
              first.processIdentifier == second.processIdentifier,
              matchesConfiguredApplication(first),
              matchesConfiguredApplication(second),
              let firstBirth = first.launchDate,
              let secondBirth = second.launchDate else {
            return false
        }
        return firstBirth == secondBirth
    }

    private func edgeIdentity(
        for application: NSRunningApplication,
        eventName: String
    ) -> LaunchEdgeIdentity? {
        guard let birthDate = application.launchDate,
              matchesConfiguredApplication(application) else {
            return nil
        }
        return LaunchEdgeIdentity(
            pid: application.processIdentifier,
            birthDate: birthDate,
            bundleId: bundleId,
            appPath: appPath,
            executablePath: executablePath,
            eventName: eventName
        )
    }

    private func handleLaunch(_ application: NSRunningApplication, eventName: String) {
        guard matchesConfiguredApplication(application) else {
            return
        }

        if let pending = pendingLaunch {
            if eventName == "codex.didLaunch",
               pending.eventName == "codex.willLaunch",
               pending.queuedDidLaunch == nil,
               hasSameActualLaunch(as: pending.application, and: application) {
                pendingLaunch?.queuedDidLaunch = application
            }
            return
        }
        let edge = edgeIdentity(for: application, eventName: eventName)
        if let edge, recentlyEmittedEdges.contains(edge) {
            return
        }

        let pid = application.processIdentifier
        let observationTime = Date()
        let launchedAt = formatter.string(from: application.launchDate ?? observationTime)
        let deadlineAtMs = Int64(observationTime.timeIntervalSince1970 * 1_000) + 20_000
        pendingLaunch = PendingLaunch(
            application: application,
            pid: pid,
            launchedAt: launchedAt,
            birthDate: application.launchDate,
            deadlineAtMs: deadlineAtMs,
            eventName: eventName,
            queuedDidLaunch: nil
        )
        let event = StartupEvent(
            event: eventName,
            pid: pid,
            bundleId: bundleId,
            appPath: appPath,
            executablePath: executablePath,
            launchedAt: launchedAt,
            deadlineAtMs: deadlineAtMs
        )
        guard send(event) else {
            clearPendingProcess()
            return
        }
        if let edge {
            recentlyEmittedEdges.append(edge)
        }
        if recentlyEmittedEdges.count > 64 {
            recentlyEmittedEdges.removeFirst(recentlyEmittedEdges.count - 64)
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
            forName: NSWorkspace.willLaunchApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let application = notification.userInfo?[
                NSWorkspace.applicationUserInfoKey
            ] as? NSRunningApplication else {
                return
            }
            self?.handleLaunch(application, eventName: "codex.willLaunch")
        }
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
            self?.handleLaunch(application, eventName: "codex.didLaunch")
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
