import AppKit
import CoreFoundation
import Darwin
import Foundation

private let dockDomain = "com.apple.dock" as CFString
private let persistentAppsKey = "persistent-apps" as CFString
private let managedBundleID = "com.codextaskprogress.codexlauncher"
private let originalBundleID = "com.openai.codex"
private var showAppAlert = false

#if TASK_PROGRESS_LAUNCHER_TESTING
private let launcherTesting = true
#else
private let launcherTesting = false
#endif

private func showFailureAlert(_ code: String) {
  guard showAppAlert else { return }
  let alert = NSAlert()
  alert.alertStyle = .warning
  alert.messageText = "Codex didn't open"
  switch code {
  case "HELPER_NOT_INSTALLED":
    alert.informativeText = "Goal Progress isn't installed yet. Install Goal Progress, then click this Dock icon again."
  case "HELPER_PATH_INVALID", "HELPER_LAUNCH_FAILED", "HELPER_LAUNCH_TIMEOUT":
    alert.informativeText = "The Goal Progress helper couldn't start. Run its repair command, then try again."
  default:
    alert.informativeText = "The launcher couldn't start Goal Progress. Check its diagnostics and try again."
  }
  alert.addButton(withTitle: "OK")
  alert.runModal()
}

private func emit(_ value: [String: Any], status: Int32 = 0) -> Never {
  if status != 0, showAppAlert { showFailureAlert((value["code"] as? String) ?? "LAUNCHER_FAILED") }
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(status)
}

private func error(_ code: String, _ detail: String? = nil) -> Never {
  var value: [String: Any] = ["ok": false, "code": code]
  if let detail { value["detail"] = String(detail.prefix(240)) }
  emit(value, status: 1)
}

private func parseOptions(_ values: [String], command: String) -> [String: String] {
  let valueOptions: [String: Set<String>] = [
    "fixture-launch": ["--helper"],
    "dock-status": ["--managed-app"],
    "dock-install": ["--original-app", "--managed-app", "--receipt"],
    "dock-remove": ["--managed-app", "--receipt"],
    "dock-fixture-seed": ["--plist", "--original-app", "--managed-app"],
    "dock-fixture": ["--plist", "--original-app", "--managed-app", "--output-plist", "--receipt-output", "--customize-managed-label"],
    "dock-fixture-remove": ["--plist", "--managed-app", "--receipt", "--output-plist"],
    "dock-fixture-migrate": ["--plist", "--original-app", "--managed-app", "--receipt", "--output-plist", "--receipt-output"],
    "dock-fixture-transaction": ["--operation", "--plist", "--original-app", "--managed-app", "--receipt", "--output-plist", "--receipt-output"],
    "dock-fixture-inspect": ["--plist"],
  ]
  let booleanOptions: [String: Set<String>] = [
    "fixture-launch": ["--json"],
    "dock-status": ["--json"],
    "dock-install": ["--json"],
    "dock-remove": ["--json"],
    "dock-fixture-seed": ["--without-canonical", "--include-remote-original", "--json"],
    "dock-fixture": ["--refresh-managed-caches", "--insert-unrelated-before-managed", "--append-original", "--json"],
    "dock-fixture-remove": ["--json"],
    "dock-fixture-migrate": ["--json", "--stage-only", "--dock-only"],
    "dock-fixture-transaction": ["--json", "--stage-only", "--dock-only", "--reload-only", "--reload-fail"],
    "dock-fixture-inspect": ["--json"],
  ]
  guard let allowedValues = valueOptions[command], let allowedBooleans = booleanOptions[command] else {
    if values.isEmpty { return [:] }
    error("LAUNCHER_ARGUMENT_INVALID")
  }
  var result: [String: String] = [:]
  var index = 0
  while index < values.count {
    let key = values[index]
    guard result[key] == nil else { error("LAUNCHER_ARGUMENT_INVALID") }
    if allowedBooleans.contains(key) {
      result[key] = "true"
      index += 1
      continue
    }
    guard allowedValues.contains(key), index + 1 < values.count, !values[index + 1].hasPrefix("--") else {
      error("LAUNCHER_ARGUMENT_INVALID")
    }
    result[key] = values[index + 1]
    index += 2
  }
  guard result["--json"] != nil else { error("LAUNCHER_ARGUMENT_INVALID") }
  return result
}

private func launchHelperPath() -> String {
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  let expected = URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/CodexTaskProgress/install/bin/goal-progress").standardizedFileURL.path
  let configured = Bundle.main.infoDictionary?["TaskProgressHelperPath"] as? String
  #if TASK_PROGRESS_LAUNCHER_TESTING
  let helper = launcherTesting ? (configured ?? expected) : expected
  let validPath = launcherTesting
    ? (helper.hasPrefix("/") && URL(fileURLWithPath: helper).standardizedFileURL.path == helper)
    : helper == expected
  #else
  let helper = configured ?? expected
  let validPath = helper.hasPrefix("/") && URL(fileURLWithPath: helper).standardizedFileURL.path == expected
  #endif
  guard validPath else { error("HELPER_PATH_INVALID", "The managed launcher helper path is invalid.") }
  var helperStat = stat()
  guard lstat(helper, &helperStat) == 0, (helperStat.st_mode & S_IFMT) == S_IFREG,
        FileManager.default.isExecutableFile(atPath: helper) else { error("HELPER_NOT_INSTALLED", "Install Goal Progress from the app or command line, then try again.") }
  return helper
}

private struct HelperResult {
  let status: Int32
  let stdout: Data
  let stderr: Data
  let timedOut: Bool
  let launchError: String?
}

private func invokeHelper(_ helper: String) -> HelperResult {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: helper)
  process.arguments = ["launch", "--json"]
  let output = Pipe()
  let errors = Pipe()
  process.standardOutput = output
  process.standardError = errors
  let outputLock = NSLock()
  let errorLock = NSLock()
  var outputData = Data()
  var errorData = Data()
  let outputEOF = DispatchSemaphore(value: 0)
  let errorEOF = DispatchSemaphore(value: 0)
  var outputEnded = false
  var errorEnded = false
  output.fileHandleForReading.readabilityHandler = { handle in
    let chunk = handle.availableData
    outputLock.lock()
    if chunk.isEmpty { if !outputEnded { outputEnded = true; outputEOF.signal() } }
    else if outputData.count < 1_048_576 { outputData.append(contentsOf: chunk.prefix(1_048_576 - outputData.count)) }
    outputLock.unlock()
  }
  errors.fileHandleForReading.readabilityHandler = { handle in
    let chunk = handle.availableData
    errorLock.lock()
    if chunk.isEmpty { if !errorEnded { errorEnded = true; errorEOF.signal() } }
    else if errorData.count < 1_048_576 { errorData.append(contentsOf: chunk.prefix(1_048_576 - errorData.count)) }
    errorLock.unlock()
  }
  let semaphore = DispatchSemaphore(value: 0)
  process.terminationHandler = { _ in semaphore.signal() }
  do { try process.run() } catch {
    output.fileHandleForReading.readabilityHandler = nil
    errors.fileHandleForReading.readabilityHandler = nil
    return HelperResult(status: 1, stdout: Data(), stderr: Data(), timedOut: false, launchError: error.localizedDescription)
  }
  if semaphore.wait(timeout: .now() + 90) == .timedOut {
    process.terminate()
    // This is the launcher-owned helper child, never the real Codex application.
    _ = kill(process.processIdentifier, SIGKILL)
    _ = process.waitUntilExit()
    output.fileHandleForReading.readabilityHandler = nil
    errors.fileHandleForReading.readabilityHandler = nil
    return HelperResult(status: 1, stdout: Data(), stderr: Data(), timedOut: true, launchError: nil)
  }
  // A child may exit before its final readability callback runs. Wait briefly for
  // EOF, but do not hang forever if a launched descendant inherited a pipe.
  _ = outputEOF.wait(timeout: .now() + 2)
  _ = errorEOF.wait(timeout: .now() + 2)
  output.fileHandleForReading.readabilityHandler = nil
  errors.fileHandleForReading.readabilityHandler = nil
  outputLock.lock(); let stdout = outputData; outputLock.unlock()
  errorLock.lock(); let stderr = errorData; errorLock.unlock()
  return HelperResult(status: process.terminationStatus, stdout: stdout, stderr: stderr, timedOut: false, launchError: nil)
}

private func finishHelper(_ result: HelperResult, appMode: Bool) -> Never {
  if let detail = result.launchError { error("HELPER_LAUNCH_FAILED", detail) }
  if result.timedOut { error("HELPER_LAUNCH_TIMEOUT", "The launcher helper did not respond.") }
  if !result.stdout.isEmpty { FileHandle.standardOutput.write(result.stdout) }
  if !result.stderr.isEmpty { FileHandle.standardError.write(result.stderr) }
  let helperOutput = String(decoding: result.stdout, as: UTF8.self)
  if appMode && result.status != 0 && !helperOutput.contains("CODEX_CONNECTION_REBUILD_PENDING") {
    showFailureAlert("HELPER_LAUNCH_FAILED")
  }
  exit(result.status)
}

private final class LauncherApplicationDelegate: NSObject, NSApplicationDelegate {
  private var didLaunchHelper = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    #if TASK_PROGRESS_LAUNCHER_TESTING
    if let statusPath = Bundle.main.infoDictionary?["TaskProgressLauncherTestStatusPath"] as? String {
      let launched = "launched \(ProcessInfo.processInfo.processIdentifier)\n"
      try? Data(launched.utf8).write(to: URL(fileURLWithPath: statusPath), options: .atomic)
      // A timer proves the NSApplication run loop remains responsive while the helper is blocked.
      Timer.scheduledTimer(withTimeInterval: 0.1, repeats: false) { _ in
        try? Data((launched + "responsive\n").utf8).write(to: URL(fileURLWithPath: statusPath), options: .atomic)
      }
    }
    #endif
    guard !didLaunchHelper else { return }
    didLaunchHelper = true
    let helper = launchHelperPath()
    DispatchQueue.global(qos: .userInitiated).async {
      let result = invokeHelper(helper)
      DispatchQueue.main.async {
        finishHelper(result, appMode: true)
      }
    }
  }
}

private func launchApplication() -> Never {
  showAppAlert = true
  let application = NSApplication.shared
  let delegate = LauncherApplicationDelegate()
  application.delegate = delegate
  withExtendedLifetime(delegate) { application.run() }
  exit(0)
}

private func selfError(_ code: String, _ detail: String) -> Never { error(code, detail) }

private func fixtureLaunch(_ options: [String: String]) -> Never {
  guard let helper = options["--helper"], helper.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: helper) else { error("FIXTURE_HELPER_INVALID") }
  finishHelper(invokeHelper(helper), appMode: false)
}

private func readDockItems() -> [[String: Any]] {
  guard let raw = CFPreferencesCopyAppValue(persistentAppsKey, dockDomain), let entries = raw as? [[String: Any]] else {
    error("DOCK_PREFERENCES_UNAVAILABLE", "Dock's persistent app list could not be read safely.")
  }
  return entries
}

private func writeDockItems(_ entries: [[String: Any]], expected: [[String: Any]]) -> Bool {
  let latest = readDockItems()
  guard NSDictionary(dictionary: ["v": latest]).isEqual(to: ["v": expected]) else { return false }
  CFPreferencesSetAppValue(persistentAppsKey, entries as CFArray, dockDomain)
  guard CFPreferencesAppSynchronize(dockDomain) else { return false }
  return true
}

private func tileData(_ entry: [String: Any]) -> [String: Any]? { entry["tile-data"] as? [String: Any] }

private func localFileURL(_ value: String) -> URL? {
  if let url = URL(string: value), url.scheme != nil {
    guard url.isFileURL, url.host == nil || url.host == "" || url.host?.lowercased() == "localhost" else { return nil }
    return url
  }
  guard value.hasPrefix("/") else { return nil }
  return URL(fileURLWithPath: value)
}

private func tilePaths(_ entry: [String: Any]) -> [String] {
  guard let tile = tileData(entry) else { return [] }
  if let fileData = tile["file-data"] as? [String: Any], let value = fileData["_CFURLString"] as? String {
    guard let url = localFileURL(value) else { return [] }
    return [url.resolvingSymlinksInPath().standardizedFileURL.path]
  }
  var candidates: [Data] = []
  func collect(_ value: Any, key: String = "") {
    if let data = value as? Data, key.localizedCaseInsensitiveContains("book") || key == "file-data" { candidates.append(data) }
    if let dictionary = value as? [String: Any] { for (childKey, child) in dictionary { collect(child, key: childKey) } }
    if let array = value as? [Any] { for child in array { collect(child, key: key) } }
  }
  collect(tile)
  var paths: [String] = []
  for bookmark in candidates {
    var stale = false
    if let url = try? URL(resolvingBookmarkData: bookmark, options: [.withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale) {
      paths.append(url.resolvingSymlinksInPath().standardizedFileURL.path)
    }
  }
  return paths
}

private func isTile(_ entry: [String: Any], bundle: String, path: String) -> Bool {
  guard let tile = tileData(entry), tile["bundle-identifier"] as? String == bundle else { return false }
  let target = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
  return tilePaths(entry).contains { $0 == target }
}

private func bookmarkPath(_ data: Data) -> String? {
  var stale = false
  guard let url = try? URL(resolvingBookmarkData: data, options: [.withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
  return url.resolvingSymlinksInPath().standardizedFileURL.path
}

private func canonicalDockEntry(_ source: [String: Any], originalPath: String, managedPath: String) -> [String: Any] {
  var entry = source
  var tile = tileData(source) ?? [:]
  tile["bundle-identifier"] = managedBundleID
  tile["file-label"] = "Codex"
  let managedURL = URL(fileURLWithPath: managedPath, isDirectory: true)
  let bookmark = try? managedURL.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
  let originalCanonical = URL(fileURLWithPath: originalPath).resolvingSymlinksInPath().standardizedFileURL.path
  func refreshBookmarks(_ value: Any, key: String = "") -> Any? {
    if key.localizedCaseInsensitiveContains("book"), let data = value as? Data, bookmarkPath(data) == originalCanonical { return bookmark }
    if let dictionary = value as? [String: Any] {
      var clean: [String: Any] = [:]
      for (childKey, child) in dictionary {
        if let result = refreshBookmarks(child, key: childKey) { clean[childKey] = result }
      }
      return clean
    }
    if let array = value as? [Any] { return array.compactMap { refreshBookmarks($0, key: key) } }
    return value
  }
  if let cleaned = refreshBookmarks(tile) as? [String: Any] { tile = cleaned }
  var fileData = tile["file-data"] as? [String: Any] ?? [:]
  fileData["_CFURLString"] = managedURL.absoluteString
  fileData["_CFURLStringType"] = 15
  tile["file-data"] = fileData
  if tile["book"] != nil { tile["book"] = bookmark }
  entry["tile-data"] = tile
  return (refreshBookmarks(entry) as? [String: Any]) ?? entry
}

private func newDockEntry(managedPath: String) -> [String: Any] {
  let managedURL = URL(fileURLWithPath: managedPath, isDirectory: true)
  var tile: [String: Any] = [
    "bundle-identifier": managedBundleID,
    "file-label": "Codex",
    "file-data": ["_CFURLString": managedURL.absoluteString, "_CFURLStringType": 15],
    "file-type": 41,
  ]
  if let bookmark = try? managedURL.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) { tile["book"] = bookmark }
  return [
    "tile-type": "file-tile",
    "tile-data": tile,
  ]
}

private struct DockInstallPlan {
  let entries: [[String: Any]]
  let originalEntries: [[String: Any]]
  let originalPositions: [Int]
  let replaced: Int
  let appended: Bool
  var changed: Bool { !NSDictionary(dictionary: ["v": entries]).isEqual(to: ["v": originalSnapshot]) }
  private let originalSnapshot: [[String: Any]]

  init(before: [[String: Any]], originalPath: String, managedPath: String) {
    originalSnapshot = before
    var planned = before
    var originals: [[String: Any]] = []
    var positions: [Int] = []
    var count = 0
    for index in planned.indices where isTile(planned[index], bundle: originalBundleID, path: originalPath) {
      originals.append(planned[index])
      positions.append(index)
      planned[index] = canonicalDockEntry(planned[index], originalPath: originalPath, managedPath: managedPath)
      count += 1
    }
    let hasManaged = planned.contains { isTile($0, bundle: managedBundleID, path: managedPath) }
    let didAppend = count == 0 && !hasManaged
    if didAppend { planned.append(newDockEntry(managedPath: managedPath)) }
    entries = planned
    originalEntries = originals
    originalPositions = positions
    replaced = count
    appended = didAppend
  }
}

private struct DockRestorePlan {
  let entries: [[String: Any]]
  let changed: Bool
  let keepManagedApp: Bool

  init(before: [[String: Any]], managedPath: String, receipt: [String: Any]) {
    guard let originals = receipt["originalEntries"] as? [[String: Any]],
          let installed = receipt["installedEntries"] as? [[String: Any]] else {
      entries = before
      changed = false
      keepManagedApp = true
      return
    }
    let managedPairs = before.enumerated().filter { isTile($0.element, bundle: managedBundleID, path: managedPath) }
    let managedNow = managedPairs.map(\.element)
    let currentPositions = managedPairs.map(\.offset)
    let installedPositions = receipt["installedPositions"] as? [Int] ?? []
    if managedNow.isEmpty {
      entries = before
      changed = false
      keepManagedApp = false
      return
    }
    var unmatchedInstalled = installed
    let tilesChanged = managedNow.contains { current in
      guard let index = unmatchedInstalled.firstIndex(where: { sameManagedTile(current, $0, managedPath: managedPath) }) else { return true }
      unmatchedInstalled.remove(at: index)
      return false
    } || !unmatchedInstalled.isEmpty
    let customized = currentPositions != installedPositions || tilesChanged
    if customized {
      entries = before
      changed = false
      keepManagedApp = true
      return
    }
    var restored = before.filter { !isTile($0, bundle: managedBundleID, path: managedPath) }
    let positions = receipt["originalPositions"] as? [Int] ?? []
    var unmatchedExisting = restored
    for (offset, original) in originals.enumerated() {
      let originalBundle = tileData(original)?["bundle-identifier"] as? String
      let originalPath = tilePaths(original).first
      let existingIndex = unmatchedExisting.firstIndex { existing in
        guard tileData(existing)?["bundle-identifier"] as? String == originalBundle,
              let originalPath else { return false }
        return tilePaths(existing).contains(originalPath)
      }
      if let existingIndex { unmatchedExisting.remove(at: existingIndex); continue }
      let position = offset < positions.count ? max(0, min(positions[offset], restored.count)) : restored.count
      restored.insert(original, at: position)
    }
    entries = restored
    changed = !NSDictionary(dictionary: ["v": restored]).isEqual(to: ["v": before])
    keepManagedApp = false
  }
}

private func comparableManagedTile(_ entry: [String: Any], managedPath: String) -> [String: Any] {
  var clone = entry
  guard var tile = tileData(entry) else { return clone }
  for key in ["book", "file-mod-date", "parent-mod-date"] { tile.removeValue(forKey: key) }
  if var fileData = tile["file-data"] as? [String: Any] {
    for key in ["book", "file-mod-date", "parent-mod-date"] { fileData.removeValue(forKey: key) }
    if let value = fileData["_CFURLString"] as? String {
      if let url = localFileURL(value), url.resolvingSymlinksInPath().standardizedFileURL.path == URL(fileURLWithPath: managedPath).resolvingSymlinksInPath().standardizedFileURL.path {
        fileData["_CFURLString"] = URL(fileURLWithPath: managedPath, isDirectory: true).absoluteString
        fileData["_CFURLStringType"] = 15
      }
    }
    tile["file-data"] = fileData
  }
  clone["tile-data"] = tile
  return clone
}

private func sameManagedTile(_ current: [String: Any], _ installed: [String: Any], managedPath: String) -> Bool {
  guard isTile(current, bundle: managedBundleID, path: managedPath), isTile(installed, bundle: managedBundleID, path: managedPath) else { return false }
  return NSDictionary(dictionary: ["v": comparableManagedTile(current, managedPath: managedPath)])
    .isEqual(to: ["v": comparableManagedTile(installed, managedPath: managedPath)])
}

// Migrate only the exact managed tiles recorded by the old installer. Retain the
// original pre-plugin snapshot so removal still restores the user's Dock.
private func migrateDockReceipt(before: [[String: Any]], legacyPath: String, managedPath: String, receipt: [String: Any]) -> (entries: [[String: Any]], receipt: [String: Any])? {
  guard !before.contains(where: { isTile($0, bundle: managedBundleID, path: managedPath) }) else { return nil }
  let restore = DockRestorePlan(before: before, managedPath: legacyPath, receipt: receipt)
  let pairs = before.enumerated().filter { isTile($0.element, bundle: managedBundleID, path: legacyPath) }
  guard !restore.keepManagedApp, !pairs.isEmpty else { return nil }
  var entries = before
  for pair in pairs { entries[pair.offset] = canonicalDockEntry(pair.element, originalPath: legacyPath, managedPath: managedPath) }
  var updated = receipt
  updated["managedAppPath"] = managedPath
  updated["installedEntries"] = pairs.map { entries[$0.offset] }
  updated["installedPositions"] = pairs.map(\.offset)
  return (entries, updated)
}

// A single receipt records both snapshots until the Dock write and final receipt
// are complete. Compare all entries while ignoring only managed Dock cache fields.
private func prepareMigration(before: [[String: Any]], legacyPath: String, managedPath: String, receipt: [String: Any]) -> [String: Any]? {
  guard receipt["pendingMigration"] == nil, receipt["managedAppPath"] as? String == legacyPath,
        let plan = migrateDockReceipt(before: before, legacyPath: legacyPath, managedPath: managedPath, receipt: receipt) else { return nil }
  var pending = receipt
  pending["pendingMigration"] = ["before": before, "after": plan.entries, "finalReceipt": plan.receipt]
  return pending
}

private func migrationResume(before: [[String: Any]], legacyPath: String, managedPath: String, receipt: [String: Any]) -> (entries: [[String: Any]], finalReceipt: [String: Any], needsDockWrite: Bool)? {
  guard receipt["managedAppPath"] as? String == legacyPath,
        let pending = receipt["pendingMigration"] as? [String: Any],
        let oldEntries = pending["before"] as? [[String: Any]],
        let newEntries = pending["after"] as? [[String: Any]],
        let finalReceipt = pending["finalReceipt"] as? [String: Any],
        finalReceipt["managedAppPath"] as? String == managedPath,
        finalReceipt["pendingMigration"] == nil,
        let expected = migrateDockReceipt(before: oldEntries, legacyPath: legacyPath, managedPath: managedPath, receipt: receiptWithoutPending(receipt)),
        migrationEntriesMatch(expected.entries, newEntries, managedPath: managedPath) else { return nil }
  var expectedReceipt = expected.receipt
  expectedReceipt["installedEntries"] = newEntries.filter { isTile($0, bundle: managedBundleID, path: managedPath) }
  guard samePlist(expectedReceipt, finalReceipt) else { return nil }
  if migrationEntriesMatch(oldEntries, before, managedPath: legacyPath) { return (newEntries, finalReceipt, true) }
  if migrationEntriesMatch(newEntries, before, managedPath: managedPath) { return (newEntries, finalReceipt, false) }
  return nil
}

private func migrationEntriesMatch(_ expected: [[String: Any]], _ actual: [[String: Any]], managedPath: String) -> Bool {
  guard expected.count == actual.count else { return false }
  return zip(expected, actual).allSatisfy { expectedEntry, actualEntry in
    if isTile(expectedEntry, bundle: managedBundleID, path: managedPath) {
      return sameManagedTile(expectedEntry, actualEntry, managedPath: managedPath)
    }
    return samePlist(expectedEntry, actualEntry)
  }
}

private func receiptWithoutPending(_ receipt: [String: Any]) -> [String: Any] {
  var result = receipt
  result.removeValue(forKey: "pendingMigration")
  return result
}

private func samePlist(_ lhs: Any, _ rhs: Any) -> Bool {
  NSDictionary(dictionary: ["value": lhs]).isEqual(to: ["value": rhs])
}

private func plistData(_ value: Any) throws -> Data {
  try PropertyListSerialization.data(fromPropertyList: value, format: .binary, options: 0)
}

private func readReceipt(_ path: String) -> [String: Any]? {
  guard FileManager.default.fileExists(atPath: path) else { return nil }
  guard let data = FileManager.default.contents(atPath: path),
        let receipt = (try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)) as? [String: Any],
        receipt["schemaVersion"] as? Int == 1,
        receipt["managedAppPath"] is String,
        receipt["originalEntries"] is [[String: Any]],
        receipt["installedEntries"] is [[String: Any]] else { error("DOCK_RECEIPT_INVALID") }
  return receipt
}

private func atomicWrite(_ data: Data, path: String) throws {
  let url = URL(fileURLWithPath: path)
  let parent = url.deletingLastPathComponent()
  try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  var parentStat = stat()
  guard lstat(parent.path, &parentStat) == 0, (parentStat.st_mode & S_IFMT) == S_IFDIR else {
    throw NSError(domain: "CodexTaskProgress", code: 1)
  }
  try data.write(to: url, options: .atomic)
  try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
}

private func checkedDockReload() throws {
  let bundleID = "com.apple.dock"
  let prior = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
  let priorPIDs = Set(prior.map { $0.processIdentifier })
  guard !priorPIDs.isEmpty else { throw NSError(domain: "DockReload", code: 1, userInfo: [NSLocalizedDescriptionKey: "Dock was not running before reload."]) }
  for pid in priorPIDs {
    if kill(pid, SIGTERM) != 0 && errno != ESRCH {
      throw NSError(domain: "DockReload", code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "Could not signal Dock (errno \(errno))."])
    }
  }
  let deadline = Date().addingTimeInterval(15)
  while Date() < deadline {
    let current = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
    let oldStillRunning = current.contains { priorPIDs.contains($0.processIdentifier) }
    if !oldStillRunning, let replacement = current.first(where: { !priorPIDs.contains($0.processIdentifier) }), replacement.isFinishedLaunching { return }
    _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
  }
  throw NSError(domain: "DockReload", code: 2, userInfo: [NSLocalizedDescriptionKey: "Dock did not relaunch and finish launching within 15 seconds."])
}

private struct DockTransaction {
  let kind: String
  let before: [[String: Any]]
  let after: [[String: Any]]
  let beforePath: String
  let afterPath: String
  let finalReceipt: [String: Any]?
  let receipt: [String: Any]
  let needsWrite: Bool
}

private func transactionEntriesMatch(_ expected: [[String: Any]], _ actual: [[String: Any]], path: String) -> Bool {
  guard expected.count == actual.count else { return false }
  return zip(expected, actual).allSatisfy { lhs, rhs in
    if isTile(lhs, bundle: managedBundleID, path: path) { return sameManagedTile(lhs, rhs, managedPath: path) }
    return samePlist(lhs, rhs)
  }
}

private func makePendingTransaction(kind: String, before: [[String: Any]], after: [[String: Any]], beforePath: String, afterPath: String, finalReceipt: [String: Any]?, baseReceipt: [String: Any]) -> [String: Any] {
  var pendingReceipt = receiptWithoutPending(baseReceipt)
  pendingReceipt.removeValue(forKey: "pendingTransaction")
  var transaction: [String: Any] = [
    "kind": kind, "before": before, "after": after,
    "beforePath": beforePath, "afterPath": afterPath,
    "hasFinalReceipt": finalReceipt != nil,
  ]
  if let finalReceipt { transaction["finalReceipt"] = finalReceipt }
  pendingReceipt["pendingTransaction"] = transaction
  return pendingReceipt
}

private func resumeTransaction(current: [[String: Any]], receipt: [String: Any], expectedKind: String) -> DockTransaction? {
  guard let pending = receipt["pendingTransaction"] as? [String: Any],
        pending["kind"] as? String == expectedKind,
        let before = pending["before"] as? [[String: Any]], let after = pending["after"] as? [[String: Any]],
        let beforePath = pending["beforePath"] as? String, let afterPath = pending["afterPath"] as? String else { return nil }
  let finalReceipt = pending["finalReceipt"] as? [String: Any]
  guard (pending["hasFinalReceipt"] as? Bool) == (finalReceipt != nil) else { return nil }
  let oldState = transactionEntriesMatch(before, current, path: beforePath)
  let newState = transactionEntriesMatch(after, current, path: afterPath)
  guard oldState || newState else { return nil }
  return DockTransaction(kind: expectedKind, before: before, after: after, beforePath: beforePath, afterPath: afterPath,
                         finalReceipt: finalReceipt, receipt: receipt, needsWrite: oldState && !newState)
}

private enum DockTransactionFailure: Error {
  case preferencesChanged
  case receiptWrite(String)
}

private enum DockTransactionPhase {
  case complete, stageOnly, dockOnly, reloadOnly
}

private struct DockTransactionResult {
  let reloadCount: Int
  let phase: String
}

private func completeDockTransaction(
  _ transaction: DockTransaction,
  phase: DockTransactionPhase = .complete,
  persistPending: () throws -> Void = {},
  readDock: () -> [[String: Any]],
  writeDock: (_ entries: [[String: Any]], _ expected: [[String: Any]]) -> Bool,
  reloadDock: () throws -> Void,
  commit: (_ finalReceipt: [String: Any]?) throws -> Void
) throws -> DockTransactionResult {
  try persistPending()
  if case .stageOnly = phase { return DockTransactionResult(reloadCount: 0, phase: "prepared") }
  var current = readDock()
  guard let resumable = resumeTransaction(current: current, receipt: transaction.receipt, expectedKind: transaction.kind) else { throw DockTransactionFailure.preferencesChanged }
  if resumable.needsWrite {
    guard writeDock(resumable.after, current) else { throw DockTransactionFailure.preferencesChanged }
  }
  if case .dockOnly = phase { return DockTransactionResult(reloadCount: 0, phase: "dock-written") }
  current = readDock()
  guard transactionEntriesMatch(resumable.after, current, path: resumable.afterPath) else { throw DockTransactionFailure.preferencesChanged }
  try reloadDock()
  current = readDock()
  guard transactionEntriesMatch(resumable.after, current, path: resumable.afterPath) else { throw DockTransactionFailure.preferencesChanged }
  if case .reloadOnly = phase { return DockTransactionResult(reloadCount: 1, phase: "reloaded-pending") }
  do { try commit(resumable.finalReceipt) }
  catch { throw DockTransactionFailure.receiptWrite(error.localizedDescription) }
  return DockTransactionResult(reloadCount: 1, phase: "complete")
}

private func dockStatus(_ managedPath: String?) -> Never {
  if let managedPath {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let expected = ["Applications/Codex.app", "Applications/Codex Task Progress.app"].map { home.appendingPathComponent($0).standardizedFileURL.path }
    guard expected.contains(URL(fileURLWithPath: managedPath).standardizedFileURL.path) else { error("DOCK_PATH_INVALID") }
  }
  let entries = readDockItems()
  let configured = managedPath.map { path in entries.contains { isTile($0, bundle: managedBundleID, path: path) } } ?? entries.contains { tileData($0)?["bundle-identifier"] as? String == managedBundleID }
  emit(["ok": true, "code": "DOCK_STATUS", "dockConfigured": configured, "currentCodex": "untouched"])
}

private func installDock(originalPath: String, managedPath: String, receiptPath: String) -> Never {
  validateManagedPath(managedPath, receiptPath: receiptPath)
  let before = readDockItems()
  let existingReceipt = readReceipt(receiptPath)
  let legacyPath = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Codex Task Progress.app").standardizedFileURL.path
  if let receipt = existingReceipt, receipt["pendingMigration"] != nil {
    guard let legacyPending = receipt["pendingMigration"] as? [String: Any],
          let oldEntries = legacyPending["before"] as? [[String: Any]],
          let resume = migrationResume(before: before, legacyPath: legacyPath, managedPath: managedPath, receipt: receipt) else {
      error("DOCK_USER_EDIT_PRESERVED", "Legacy migration recovery state no longer matches Dock; recovery record retained.")
    }
    let upgraded = makePendingTransaction(kind: "migrate", before: oldEntries, after: resume.entries, beforePath: legacyPath, afterPath: managedPath, finalReceipt: resume.finalReceipt, baseReceipt: receipt)
    do { try atomicWrite(try plistData(upgraded), path: receiptPath) } catch { selfError("DOCK_RECEIPT_WRITE_FAILED", error.localizedDescription) }
    guard let transaction = resumeTransaction(current: before, receipt: upgraded, expectedKind: "migrate") else { error("DOCK_USER_EDIT_PRESERVED", "Legacy migration recovery state changed; receipt retained.") }
    do {
      try completeDockTransaction(transaction, readDock: readDockItems, writeDock: writeDockItems, reloadDock: checkedDockReload) { finalReceipt in
        guard let finalReceipt else { throw NSError(domain: "DockReceipt", code: 1) }
        try atomicWrite(try plistData(finalReceipt), path: receiptPath)
      }
    } catch DockTransactionFailure.preferencesChanged { error("DOCK_PREFERENCES_CHANGED", "Dock settings changed; recovery record retained. Retry the install command.") }
      catch DockTransactionFailure.receiptWrite(let detail) { selfError("DOCK_RECEIPT_WRITE_FAILED", detail) }
      catch { selfError("DOCK_RELOAD_FAILED", error.localizedDescription) }
    emit(["ok": true, "code": "DOCK_MIGRATED", "changed": true, "dockConfigured": true])
  }
  if let receipt = existingReceipt, receipt["pendingTransaction"] != nil {
    let kind = ((receipt["pendingTransaction"] as? [String: Any])?["kind"] as? String) ?? ""
    guard kind == "install" || kind == "migrate" else { error("DOCK_TRANSACTION_PENDING", "A Dock removal is pending; finish removal with the uninstall command before installing.") }
    guard let transaction = resumeTransaction(current: before, receipt: receipt, expectedKind: kind) else { error("DOCK_USER_EDIT_PRESERVED", "Dock changed during the pending transaction; recovery record retained.") }
    do {
      try completeDockTransaction(transaction, readDock: readDockItems, writeDock: writeDockItems, reloadDock: checkedDockReload) { finalReceipt in
        guard let finalReceipt else { throw NSError(domain: "DockReceipt", code: 1) }
        try atomicWrite(try plistData(finalReceipt), path: receiptPath)
      }
    } catch DockTransactionFailure.preferencesChanged { error("DOCK_PREFERENCES_CHANGED", "Dock settings changed; recovery record retained. Retry the install command.") }
      catch DockTransactionFailure.receiptWrite(let detail) { selfError("DOCK_RECEIPT_WRITE_FAILED", detail) }
      catch { selfError("DOCK_RELOAD_FAILED", error.localizedDescription) }
    emit(["ok": true, "code": kind == "migrate" ? "DOCK_MIGRATED" : "DOCK_CONFIGURED", "changed": true, "dockConfigured": true])
  }
  if let receipt = existingReceipt, let receiptApp = receipt["managedAppPath"] as? String, receiptApp != managedPath {
    guard receiptApp == legacyPath, managedPath == FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Codex.app").standardizedFileURL.path else { error("DOCK_RECEIPT_INVALID") }
    guard let plan = migrateDockReceipt(before: before, legacyPath: legacyPath, managedPath: managedPath, receipt: receipt) else { error("DOCK_USER_EDIT_PRESERVED", "Legacy Dock tile or its position changed; migration was not applied.") }
    let pending = makePendingTransaction(kind: "migrate", before: before, after: plan.entries, beforePath: legacyPath, afterPath: managedPath, finalReceipt: plan.receipt, baseReceipt: receipt)
    do { try atomicWrite(try plistData(pending), path: receiptPath) } catch { selfError("DOCK_RECEIPT_WRITE_FAILED", error.localizedDescription) }
    guard let transaction = resumeTransaction(current: before, receipt: pending, expectedKind: "migrate") else { error("DOCK_USER_EDIT_PRESERVED") }
    do {
      try completeDockTransaction(transaction, readDock: readDockItems, writeDock: writeDockItems, reloadDock: checkedDockReload) { finalReceipt in
        guard let finalReceipt else { throw NSError(domain: "DockReceipt", code: 1) }
        try atomicWrite(try plistData(finalReceipt), path: receiptPath)
      }
    } catch DockTransactionFailure.preferencesChanged { error("DOCK_PREFERENCES_CHANGED", "Dock settings changed during migration; recovery record retained.") }
      catch DockTransactionFailure.receiptWrite(let detail) { selfError("DOCK_RECEIPT_WRITE_FAILED", detail) }
      catch { selfError("DOCK_RELOAD_FAILED", error.localizedDescription) }
    emit(["ok": true, "code": "DOCK_MIGRATED", "changed": true, "dockConfigured": true])
  }
  if before.contains(where: { isTile($0, bundle: managedBundleID, path: legacyPath) }) && legacyPath != managedPath {
    error("DOCK_RECEIPT_INVALID", "Legacy managed tile requires its original migration receipt.")
  }
  let plan = DockInstallPlan(before: before, originalPath: originalPath, managedPath: managedPath)
  let entries = plan.entries
  let originalEntries = plan.originalEntries
  let originalPositions = plan.originalPositions
  let replaced = plan.replaced
  let changed = plan.changed
  let previousOriginals = existingReceipt?["originalEntries"] as? [[String: Any]] ?? []
  let previousPositions = existingReceipt?["originalPositions"] as? [Int] ?? []
  let installedPairs = entries.enumerated().filter { isTile($0.element, bundle: managedBundleID, path: managedPath) }
  let mergedOriginals = previousOriginals + originalEntries
  let mergedPositions = previousPositions + originalPositions
  var finalReceipt = existingReceipt ?? [:]
  if existingReceipt == nil || !originalEntries.isEmpty {
    finalReceipt = [
      "schemaVersion": 1,
      "originalEntries": mergedOriginals,
      "originalPositions": mergedPositions,
      "installedEntries": (existingReceipt?["installedEntries"] as? [[String: Any]] ?? []) + (existingReceipt == nil ? installedPairs.map(\.element) : originalPositions.map { entries[$0] }),
      "installedPositions": (existingReceipt?["installedPositions"] as? [Int] ?? []) + (existingReceipt == nil ? installedPairs.map(\.offset) : originalPositions),
      "managedAppPath": managedPath,
    ]
  }
  guard changed else {
    if existingReceipt == nil { do { try atomicWrite(try plistData(finalReceipt), path: receiptPath) } catch { selfError("DOCK_RECEIPT_WRITE_FAILED", error.localizedDescription) } }
    emit(["ok": true, "code": "DOCK_ALREADY_CONFIGURED", "changed": false, "dockConfigured": true])
  }
  let pending = makePendingTransaction(kind: "install", before: before, after: entries, beforePath: managedPath, afterPath: managedPath, finalReceipt: finalReceipt, baseReceipt: finalReceipt)
  do { try atomicWrite(try plistData(pending), path: receiptPath) } catch { selfError("DOCK_RECEIPT_WRITE_FAILED", error.localizedDescription) }
  guard let transaction = resumeTransaction(current: before, receipt: pending, expectedKind: "install") else { error("DOCK_RECEIPT_INVALID") }
  do {
    try completeDockTransaction(transaction, readDock: readDockItems, writeDock: writeDockItems, reloadDock: checkedDockReload) { finalReceipt in
      guard let finalReceipt else { throw NSError(domain: "DockReceipt", code: 1) }
      try atomicWrite(try plistData(finalReceipt), path: receiptPath)
    }
  } catch DockTransactionFailure.preferencesChanged { error("DOCK_PREFERENCES_CHANGED", "Dock settings changed; recovery record retained. Retry the install command.") }
    catch DockTransactionFailure.receiptWrite(let detail) { selfError("DOCK_RECEIPT_WRITE_FAILED", detail) }
    catch { selfError("DOCK_RELOAD_FAILED", error.localizedDescription) }
  emit(["ok": true, "code": "DOCK_CONFIGURED", "changed": true, "dockConfigured": true, "replaced": replaced, "appended": plan.appended])
}

private func dockFixture(_ options: [String: String]) -> Never {
  guard let inputPath = options["--plist"], let originalPath = options["--original-app"], let managedPath = options["--managed-app"],
        let data = FileManager.default.contents(atPath: inputPath),
        let root = (try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)) as? [String: Any],
        let before = root["persistent-apps"] as? [[String: Any]] else { error("DOCK_FIXTURE_INVALID") }
  let plan = DockInstallPlan(before: before, originalPath: originalPath, managedPath: managedPath)
  var plannedEntries = plan.entries
  if let customLabel = options["--customize-managed-label"] {
    for index in plannedEntries.indices where isTile(plannedEntries[index], bundle: managedBundleID, path: managedPath) {
      var entry = plannedEntries[index]
      var tile = tileData(entry) ?? [:]
      tile["file-label"] = customLabel
      entry["tile-data"] = tile
      plannedEntries[index] = entry
    }
  }
  if options["--refresh-managed-caches"] != nil {
    for index in plannedEntries.indices where isTile(plannedEntries[index], bundle: managedBundleID, path: managedPath) {
      var entry = plannedEntries[index]
      var tile = tileData(entry) ?? [:]
      tile["book"] = Data([0xCA, 0xFE, UInt8(index & 0xff)])
      tile["file-mod-date"] = Date(timeIntervalSince1970: Double(index + 1))
      tile["parent-mod-date"] = Date(timeIntervalSince1970: Double(index + 3))
      entry["tile-data"] = tile
      plannedEntries[index] = entry
    }
  }
  if options["--insert-unrelated-before-managed"] != nil {
    let inserted: [String: Any] = ["tile-type": "file-tile", "tile-data": ["bundle-identifier": "com.example.user.app", "file-label": "User app", "file-data": ["_CFURLString": "file:///Applications/User%20App.app/", "_CFURLStringType": 15]]]
    let insertionIndex = plannedEntries.firstIndex(where: { isTile($0, bundle: managedBundleID, path: managedPath) }) ?? plannedEntries.count
    plannedEntries.insert(inserted, at: insertionIndex)
  }
  if options["--append-original"] != nil {
    var entry = newDockEntry(managedPath: originalPath)
    var tile = tileData(entry) ?? [:]
    tile["bundle-identifier"] = originalBundleID
    tile["file-label"] = "Repinned Codex"
    entry["tile-data"] = tile
    plannedEntries.append(entry)
  }
  if let outputPath = options["--output-plist"] {
    var changedRoot = root
    changedRoot["persistent-apps"] = plannedEntries
    do { try atomicWrite(try plistData(changedRoot), path: outputPath) } catch { selfError("DOCK_FIXTURE_WRITE_FAILED", error.localizedDescription) }
  }
  if let receiptPath = options["--receipt-output"] {
    let managedPairs = plan.entries.enumerated().filter { isTile($0.element, bundle: managedBundleID, path: managedPath) }
    let receipt: [String: Any] = ["schemaVersion": 1, "originalEntries": plan.originalEntries, "originalPositions": plan.originalPositions, "installedEntries": plan.entries.filter { isTile($0, bundle: managedBundleID, path: managedPath) }, "installedPositions": managedPairs.map(\.offset), "managedAppPath": managedPath]
    do { try atomicWrite(try plistData(receipt), path: receiptPath) } catch { selfError("DOCK_FIXTURE_WRITE_FAILED", error.localizedDescription) }
  }
  let managedBookmarksCurrent = plannedEntries.filter { isTile($0, bundle: managedBundleID, path: managedPath) }.allSatisfy { entry in
    guard let data = tileData(entry)?["book"] as? Data else { return false }
    return bookmarkPath(data) == URL(fileURLWithPath: managedPath).resolvingSymlinksInPath().standardizedFileURL.path
  }
  emit(["ok": true, "code": "DOCK_FIXTURE_PLAN", "changed": plan.changed, "replaced": plan.replaced, "appended": plan.appended, "entryCount": plan.entries.count, "managedBookmarksCurrent": managedBookmarksCurrent])
}

private func jsonSafePlistValue(_ value: Any) -> Any {
  if let data = value as? Data { return ["kind": "data", "bytes": data.count] }
  if let date = value as? Date { return ["kind": "date", "timeIntervalSince1970": date.timeIntervalSince1970] }
  if let dictionary = value as? [String: Any] {
    return dictionary.mapValues(jsonSafePlistValue)
  }
  if let array = value as? [Any] { return array.map(jsonSafePlistValue) }
  if value is NSNull { return NSNull() }
  if let string = value as? String { return string }
  if let number = value as? NSNumber { return number }
  return String(describing: value)
}

private func migrateDockFixture(_ options: [String: String]) -> Never {
  guard let input = options["--plist"], let old = options["--original-app"], let target = options["--managed-app"],
        let receiptPath = options["--receipt"], let output = options["--output-plist"], let receiptOutput = options["--receipt-output"],
        let data = FileManager.default.contents(atPath: input),
        var root = (try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)) as? [String: Any],
        let entries = root["persistent-apps"] as? [[String: Any]], let receipt = readReceipt(receiptPath) else { error("DOCK_FIXTURE_MIGRATION_REJECTED") }
  let pending: [String: Any]
  if receipt["pendingMigration"] != nil { pending = receipt }
  else {
    guard let prepared = prepareMigration(before: entries, legacyPath: old, managedPath: target, receipt: receipt) else { error("DOCK_FIXTURE_MIGRATION_REJECTED") }
    pending = prepared
  }
  guard let resume = migrationResume(before: entries, legacyPath: old, managedPath: target, receipt: pending) else { error("DOCK_FIXTURE_MIGRATION_REJECTED") }
  let stageOnly = options["--stage-only"] != nil
  let dockOnly = options["--dock-only"] != nil
  root["persistent-apps"] = stageOnly || !resume.needsDockWrite ? entries : resume.entries
  do {
    try atomicWrite(try plistData(root), path: output)
    try atomicWrite(try plistData(stageOnly || dockOnly ? pending : resume.finalReceipt), path: receiptOutput)
  } catch { selfError("DOCK_FIXTURE_WRITE_FAILED", error.localizedDescription) }
  emit(["ok": true, "code": "DOCK_FIXTURE_MIGRATED"])

}

private func dockFixtureTransaction(_ options: [String: String]) -> Never {
  guard let operation = options["--operation"], ["install", "migrate", "remove"].contains(operation),
        let input = options["--plist"], let original = options["--original-app"], let managed = options["--managed-app"],
        let output = options["--output-plist"], let receiptOutput = options["--receipt-output"],
        let data = FileManager.default.contents(atPath: input),
        var root = (try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)) as? [String: Any],
        let current = root["persistent-apps"] as? [[String: Any]] else { error("DOCK_FIXTURE_INVALID") }
  var receipt = options["--receipt"].flatMap(readReceipt)
  var kind = operation
  var beforePath = managed
  var afterPath = managed
  var after = current
  var finalReceipt: [String: Any]? = receipt
  if let receipt, receipt["pendingTransaction"] != nil {
    guard let pendingKind = (receipt["pendingTransaction"] as? [String: Any])?["kind"] as? String, pendingKind == operation else { error("DOCK_TRANSACTION_PENDING", "Finish the pending \(((receipt["pendingTransaction"] as? [String: Any])?["kind"] as? String) ?? "") transaction first.") }
    kind = pendingKind
  } else if operation == "migrate" {
    guard let receipt, let plan = migrateDockReceipt(before: current, legacyPath: original, managedPath: managed, receipt: receipt) else { error("DOCK_FIXTURE_MIGRATION_REJECTED") }
    beforePath = original
    after = plan.entries
    finalReceipt = plan.receipt
  } else if operation == "install" {
    let plan = DockInstallPlan(before: current, originalPath: original, managedPath: managed)
    after = plan.entries
    if receipt == nil || !plan.originalEntries.isEmpty {
      let installedPairs = after.enumerated().filter { isTile($0.element, bundle: managedBundleID, path: managed) }
      let oldOriginals = receipt?["originalEntries"] as? [[String: Any]] ?? []
      let oldPositions = receipt?["originalPositions"] as? [Int] ?? []
      finalReceipt = [
        "schemaVersion": 1, "originalEntries": oldOriginals + plan.originalEntries,
        "originalPositions": oldPositions + plan.originalPositions,
        "installedEntries": (receipt?["installedEntries"] as? [[String: Any]] ?? []) + (receipt == nil ? installedPairs.map(\.element) : plan.originalPositions.map { after[$0] }),
        "installedPositions": (receipt?["installedPositions"] as? [Int] ?? []) + (receipt == nil ? installedPairs.map(\.offset) : plan.originalPositions),
        "managedAppPath": managed,
      ]
    }
  } else if operation == "remove" {
    guard let receipt, receipt["managedAppPath"] as? String == managed else { error("DOCK_RECEIPT_INVALID") }
    let plan = DockRestorePlan(before: current, managedPath: managed, receipt: receipt)
    guard !plan.keepManagedApp else { error("DOCK_USER_EDIT_PRESERVED") }
    after = plan.entries
    finalReceipt = nil
  }

  if (receipt?["pendingTransaction"] == nil) && (receipt?["pendingMigration"] == nil) && samePlist(current, after) {
    do {
      try atomicWrite(try plistData(root), path: output)
      if let finalReceipt { try atomicWrite(try plistData(finalReceipt), path: receiptOutput) }
      else if FileManager.default.fileExists(atPath: receiptOutput) { try FileManager.default.removeItem(atPath: receiptOutput) }
    } catch { selfError("DOCK_FIXTURE_WRITE_FAILED", error.localizedDescription) }
    emit(["ok": true, "code": "DOCK_FIXTURE_TRANSACTION", "reloadCount": 0, "receiptRetained": finalReceipt != nil, "phase": "complete"])
  }

  if let existing = receipt, existing["pendingTransaction"] != nil {
    guard let resumed = resumeTransaction(current: current, receipt: existing, expectedKind: kind) else { error("DOCK_USER_EDIT_PRESERVED", "Dock changed outside the recorded transaction; pending receipt retained.") }
    beforePath = resumed.beforePath
    afterPath = resumed.afterPath
    after = resumed.after
    finalReceipt = resumed.finalReceipt
  } else {
    guard let baseReceipt = receipt ?? finalReceipt else { error("DOCK_RECEIPT_INVALID") }
    receipt = makePendingTransaction(kind: kind, before: current, after: after, beforePath: beforePath, afterPath: afterPath, finalReceipt: finalReceipt, baseReceipt: baseReceipt)
  }
  guard let pendingReceipt = receipt else { error("DOCK_RECEIPT_INVALID") }
  let stageOnly = options["--stage-only"] != nil
  let dockOnly = options["--dock-only"] != nil
  let reloadOnly = options["--reload-only"] != nil
  let reloadFail = options["--reload-fail"] != nil
  guard let transaction = resumeTransaction(current: current, receipt: pendingReceipt, expectedKind: kind) else { error("DOCK_USER_EDIT_PRESERVED") }
  var simulatedDock = current
  var simulatedRoot = root
  var actualReloadAttempts = 0
  let phase: DockTransactionPhase = stageOnly ? .stageOnly : (dockOnly ? .dockOnly : (reloadOnly ? .reloadOnly : .complete))
  var result: DockTransactionResult
  do {
    result = try completeDockTransaction(transaction, phase: phase, persistPending: {
      try atomicWrite(try plistData(pendingReceipt), path: receiptOutput)
    }, readDock: { simulatedDock }, writeDock: { entries, expected in
      guard transactionEntriesMatch(expected, simulatedDock, path: transaction.beforePath) else { return false }
      simulatedDock = entries
      simulatedRoot["persistent-apps"] = entries
      do { try atomicWrite(try plistData(simulatedRoot), path: output); return true }
      catch { return false }
    }, reloadDock: {
      actualReloadAttempts += 1
      if reloadFail { throw NSError(domain: "DockReload", code: 1, userInfo: [NSLocalizedDescriptionKey: "Injected Dock reload failure."]) }
    }, commit: { final in
      if let final { try atomicWrite(try plistData(final), path: receiptOutput) }
      else if FileManager.default.fileExists(atPath: receiptOutput) { try FileManager.default.removeItem(atPath: receiptOutput) }
    })
  } catch {
    do { try atomicWrite(try plistData(simulatedRoot), path: output) } catch { selfError("DOCK_FIXTURE_WRITE_FAILED", error.localizedDescription) }
    if reloadFail {
      emit(["ok": false, "code": "DOCK_RELOAD_FAILED", "reloadCount": actualReloadAttempts, "receiptRetained": true, "phase": "reloaded-pending"], status: 1)
    }
    selfError("DOCK_FIXTURE_TRANSACTION_FAILED", error.localizedDescription)
  }
  do { try atomicWrite(try plistData(simulatedRoot), path: output) } catch { selfError("DOCK_FIXTURE_WRITE_FAILED", error.localizedDescription) }
  emit(["ok": true, "code": "DOCK_FIXTURE_TRANSACTION", "reloadCount": actualReloadAttempts,
        "receiptRetained": stageOnly || dockOnly || reloadOnly || kind != "remove", "phase": result.phase])
}

private func inspectDockFixture(_ options: [String: String]) -> Never {
  guard let inputPath = options["--plist"], let data = FileManager.default.contents(atPath: inputPath),
        let root = (try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)) as? [String: Any],
        let entries = root["persistent-apps"] as? [[String: Any]] else { error("DOCK_FIXTURE_INVALID") }
  let summary = entries.map { entry -> [String: Any] in
    let tile = tileData(entry) ?? [:]
    let fileData = tile["file-data"] as? [String: Any] ?? [:]
    let bookmark = tile["book"] as? Data
    return [
      "tileType": entry["tile-type"] as? String ?? "",
      "bundleId": tile["bundle-identifier"] as? String ?? "",
      "fileLabel": tile["file-label"] as? String ?? "",
      "fileURL": fileData["_CFURLString"] as? String ?? "",
      "bookmarkBytes": bookmark?.count ?? 0,
      "bookmarkPath": bookmark.flatMap(bookmarkPath) ?? "",
      "dockExtra": jsonSafePlistValue(tile["dock-extra"] ?? NSNull()),
      "unknownEntryValue": jsonSafePlistValue(entry["unknown-entry-value"] ?? NSNull()),
    ]
  }
  emit(["ok": true, "code": "DOCK_FIXTURE_INSPECTED", "persistentApps": summary, "unknownPreference": jsonSafePlistValue(root["unknown-preference"] ?? NSNull())])
}

private func dockFixtureRemove(_ options: [String: String]) -> Never {
  guard let inputPath = options["--plist"], let managedPath = options["--managed-app"], let receiptPath = options["--receipt"],
        let data = FileManager.default.contents(atPath: inputPath),
        let root = (try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)) as? [String: Any],
        let before = root["persistent-apps"] as? [[String: Any]],
        let receiptData = FileManager.default.contents(atPath: receiptPath),
        let receipt = (try? PropertyListSerialization.propertyList(from: receiptData, options: [], format: nil)) as? [String: Any] else { error("DOCK_FIXTURE_INVALID") }
  let plan = DockRestorePlan(before: before, managedPath: managedPath, receipt: receipt)
  if let outputPath = options["--output-plist"] {
    var changedRoot = root
    changedRoot["persistent-apps"] = plan.entries
    do { try atomicWrite(try plistData(changedRoot), path: outputPath) } catch { selfError("DOCK_FIXTURE_WRITE_FAILED", error.localizedDescription) }
  }
  emit(["ok": true, "code": "DOCK_FIXTURE_RESTORE", "changed": plan.changed, "keepManagedApp": plan.keepManagedApp, "entryCount": plan.entries.count])
}

private func seedDockFixture(_ options: [String: String]) -> Never {
  guard let outputPath = options["--plist"], let originalPath = options["--original-app"], let managedPath = options["--managed-app"] else { error("DOCK_FIXTURE_INVALID") }
  let originalURL = URL(fileURLWithPath: originalPath, isDirectory: true)
  let fixtureRoot = URL(fileURLWithPath: outputPath).deletingLastPathComponent().standardizedFileURL
  let originalRelative = originalURL.standardizedFileURL.path.replacingOccurrences(of: fixtureRoot.path + "/", with: "")
  let managedURL = URL(fileURLWithPath: managedPath, isDirectory: true)
  let managedRelative = managedURL.standardizedFileURL.path.replacingOccurrences(of: fixtureRoot.path + "/", with: "")
  guard !originalRelative.hasPrefix("../"), originalRelative != originalURL.standardizedFileURL.path,
        !managedRelative.hasPrefix("../"), managedRelative != managedURL.standardizedFileURL.path else { error("DOCK_FIXTURE_PATH_INVALID") }
  try? FileManager.default.createDirectory(at: originalURL, withIntermediateDirectories: true)
  try? FileManager.default.createDirectory(at: managedURL, withIntermediateDirectories: true)
  guard let bookmark = try? originalURL.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) else { error("DOCK_FIXTURE_BOOKMARK_FAILED") }
  func tile(path: String, book: Data?) -> [String: Any] {
    var tile: [String: Any] = [
      "tile-type": "file-tile",
      "tile-data": [
        "bundle-identifier": originalBundleID,
        "file-label": "ChatGPT",
        "file-data": ["_CFURLString": URL(fileURLWithPath: path).absoluteString, "_CFURLStringType": 15],
        "file-type": 41,
        "dock-extra": ["unmodified": "preserve"],
      ],
    ]
    if let book {
      var data = tile["tile-data"] as! [String: Any]
      data["book"] = book
      tile["tile-data"] = data
    }
    return tile
  }
  var entries: [[String: Any]] = [
    tile(path: originalPath, book: bookmark),
    tile(path: originalPath, book: bookmark),
    tile(path: URL(fileURLWithPath: originalPath).deletingLastPathComponent().appendingPathComponent("Elsewhere").appendingPathComponent(URL(fileURLWithPath: originalPath).lastPathComponent).path, book: nil),
    ["tile-type": "folder-tile", "unknown-entry-value": ["preserve", 9]] as [String: Any],
  ]
  if options["--without-canonical"] != nil { entries.removeFirst(2) }
  if options["--include-remote-original"] != nil {
    var remote = tile(path: originalPath, book: nil)
    var data = tileData(remote)!
    data["file-data"] = ["_CFURLString": "file://remote-host" + originalURL.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)!, "_CFURLStringType": 15]
    remote["tile-data"] = data
    entries.append(remote)
  }
  let root: [String: Any] = ["persistent-apps": entries, "unknown-preference": ["must": "round-trip"]]
  do { try atomicWrite(try plistData(root), path: outputPath) } catch { selfError("DOCK_FIXTURE_WRITE_FAILED", error.localizedDescription) }
  emit(["ok": true, "code": "DOCK_FIXTURE_SEEDED", "entryCount": entries.count, "managedPath": managedPath])
}

private func validateManagedPath(_ managedPath: String, receiptPath: String) {
  let home = FileManager.default.homeDirectoryForCurrentUser
  let expectedApps = ["Applications/Codex.app", "Applications/Codex Task Progress.app"].map { home.appendingPathComponent($0).standardizedFileURL.path }
  let expectedReceipt = home.appendingPathComponent("Library/Application Support/CodexTaskProgress/launcher/dock-receipt.plist").standardizedFileURL.path
  guard expectedApps.contains(URL(fileURLWithPath: managedPath).standardizedFileURL.path),
        URL(fileURLWithPath: receiptPath).standardizedFileURL.path == expectedReceipt else { error("DOCK_PATH_INVALID") }
}

private func removeDock(managedPath: String, receiptPath: String) -> Never {
  validateManagedPath(managedPath, receiptPath: receiptPath)
  let before = readDockItems()
  guard let receipt = readReceipt(receiptPath), receipt["originalEntries"] is [[String: Any]], receipt["installedEntries"] is [[String: Any]] else {
    if before.contains(where: { isTile($0, bundle: managedBundleID, path: managedPath) }) { error("DOCK_RECEIPT_MISSING", "The managed Dock tile is present but its restore record is unavailable.") }
    emit(["ok": true, "code": "DOCK_RECEIPT_MISSING", "changed": false, "dockConfigured": false, "keepManagedApp": false])
  }
  if receipt["pendingTransaction"] != nil {
    let kind = ((receipt["pendingTransaction"] as? [String: Any])?["kind"] as? String) ?? ""
    guard kind == "remove" else { error("DOCK_TRANSACTION_PENDING", "A Dock install or migration is pending; finish it with the install command before uninstalling.") }
    guard let transaction = resumeTransaction(current: before, receipt: receipt, expectedKind: "remove") else { error("DOCK_USER_EDIT_PRESERVED", "Dock changed during removal; recovery record retained.") }
    do {
      try completeDockTransaction(transaction, readDock: readDockItems, writeDock: writeDockItems, reloadDock: checkedDockReload) { _ in
        try FileManager.default.removeItem(atPath: receiptPath)
      }
    } catch DockTransactionFailure.preferencesChanged { error("DOCK_PREFERENCES_CHANGED", "Dock settings changed; recovery record retained. Retry the uninstall command.") }
      catch DockTransactionFailure.receiptWrite(let detail) { selfError("DOCK_RECEIPT_WRITE_FAILED", detail) }
      catch { selfError("DOCK_RELOAD_FAILED", error.localizedDescription) }
    emit(["ok": true, "code": "DOCK_RESTORED", "changed": true, "dockConfigured": false, "keepManagedApp": false])
  }
  guard receipt["pendingMigration"] == nil else { error("DOCK_TRANSACTION_PENDING", "A Dock migration is pending; finish installation before uninstalling.") }
  guard receipt["managedAppPath"] as? String == managedPath else { error("DOCK_RECEIPT_INVALID") }
  let plan = DockRestorePlan(before: before, managedPath: managedPath, receipt: receipt)
  guard !plan.keepManagedApp else { emit(["ok": true, "code": "DOCK_USER_EDIT_PRESERVED", "changed": false, "dockConfigured": true, "keepManagedApp": true]) }
  if plan.changed {
    let pending = makePendingTransaction(kind: "remove", before: before, after: plan.entries, beforePath: managedPath, afterPath: managedPath, finalReceipt: nil, baseReceipt: receipt)
    do { try atomicWrite(try plistData(pending), path: receiptPath) } catch { selfError("DOCK_RECEIPT_WRITE_FAILED", error.localizedDescription) }
    guard let transaction = resumeTransaction(current: before, receipt: pending, expectedKind: "remove") else { error("DOCK_RECEIPT_INVALID") }
    do {
      try completeDockTransaction(transaction, readDock: readDockItems, writeDock: writeDockItems, reloadDock: checkedDockReload) { _ in
        try FileManager.default.removeItem(atPath: receiptPath)
      }
    } catch DockTransactionFailure.preferencesChanged { error("DOCK_PREFERENCES_CHANGED", "Dock settings changed; recovery record retained. Retry the uninstall command.") }
      catch DockTransactionFailure.receiptWrite(let detail) { selfError("DOCK_RECEIPT_WRITE_FAILED", detail) }
      catch { selfError("DOCK_RELOAD_FAILED", error.localizedDescription) }
  }
  if !plan.changed {
    do { try FileManager.default.removeItem(atPath: receiptPath) } catch { selfError("DOCK_RECEIPT_WRITE_FAILED", error.localizedDescription) }
  }
  emit(["ok": true, "code": "DOCK_RESTORED", "changed": plan.changed, "dockConfigured": false, "keepManagedApp": false])
}

private func runDockCommand(_ command: String, options: [String: String]) -> Never {
  switch command {
  case "dock-status": dockStatus(options["--managed-app"])
  case "dock-install":
    guard let original = options["--original-app"], let managed = options["--managed-app"], let receipt = options["--receipt"] else { error("LAUNCHER_ARGUMENT_INVALID") }
    installDock(originalPath: original, managedPath: managed, receiptPath: receipt)
  case "dock-remove":
    guard let managed = options["--managed-app"], let receipt = options["--receipt"] else { error("LAUNCHER_ARGUMENT_INVALID") }
    removeDock(managedPath: managed, receiptPath: receipt)
  default: error("LAUNCHER_MODE_INVALID")
  }
}

let argv = CommandLine.arguments
let command = argv.count > 1 ? argv[1] : "launch"
let options = parseOptions(Array(argv.dropFirst(min(2, argv.count))), command: command)
if command == "launch" {
  guard argv.count == 1 else { error("LAUNCHER_ARGUMENT_INVALID") }
  if Bundle.main.bundleURL.pathExtension == "app" { launchApplication() }
  finishHelper(invokeHelper(launchHelperPath()), appMode: false)
}
if command == "fixture-launch" { fixtureLaunch(options) }
if command == "dock-fixture" { dockFixture(options) }
if command == "dock-fixture-remove" { dockFixtureRemove(options) }
if command == "dock-fixture-seed" { seedDockFixture(options) }
if command == "dock-fixture-inspect" { inspectDockFixture(options) }
if command == "dock-fixture-migrate" { migrateDockFixture(options) }
if command == "dock-fixture-transaction" { dockFixtureTransaction(options) }
if command.hasPrefix("dock-") { runDockCommand(command, options: options) }
error("LAUNCHER_MODE_INVALID")
