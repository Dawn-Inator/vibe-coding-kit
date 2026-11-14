import AppKit
import CoreFoundation
import Darwin
import Foundation

private let dockDomain = "com.apple.dock" as CFString
private let persistentAppsKey = "persistent-apps" as CFString
private let managedBundleID = "com.codextaskprogress.codexlauncher"
private let originalBundleID = "com.openai.codex"
private var showAppAlert = false

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

private func launchHelper() -> Never {
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  let expected = URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/CodexTaskProgress/install/bin/goal-progress").standardizedFileURL.path
  let configured = Bundle.main.infoDictionary?["TaskProgressHelperPath"] as? String
  let helper = configured ?? expected
  guard helper.hasPrefix("/"), URL(fileURLWithPath: helper).standardizedFileURL.path == expected else { error("HELPER_PATH_INVALID", "The managed launcher helper path is invalid.") }
  var helperStat = stat()
  guard lstat(helper, &helperStat) == 0, (helperStat.st_mode & S_IFMT) == S_IFREG,
        FileManager.default.isExecutableFile(atPath: helper) else { error("HELPER_NOT_INSTALLED", "Install Goal Progress from the app or command line, then try again.") }
  invokeHelper(helper)
}

private func invokeHelper(_ helper: String) -> Never {
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
  do { try process.run() } catch { selfError("HELPER_LAUNCH_FAILED", error.localizedDescription) }
  if semaphore.wait(timeout: .now() + 90) == .timedOut {
    process.terminate()
    error("HELPER_LAUNCH_TIMEOUT", "The launcher helper did not respond.")
  }
  // A child may exit before its final readability callback runs. Wait briefly for
  // EOF, but do not hang forever if a launched descendant inherited a pipe.
  _ = outputEOF.wait(timeout: .now() + 2)
  _ = errorEOF.wait(timeout: .now() + 2)
  output.fileHandleForReading.readabilityHandler = nil
  errors.fileHandleForReading.readabilityHandler = nil
  outputLock.lock(); let stdout = outputData; outputLock.unlock()
  errorLock.lock(); let stderr = errorData; errorLock.unlock()
  if !stdout.isEmpty { FileHandle.standardOutput.write(stdout) }
  if !stderr.isEmpty { FileHandle.standardError.write(stderr) }
  let helperOutput = String(decoding: stdout, as: UTF8.self)
  if process.terminationStatus != 0 && !helperOutput.contains("CODEX_CONNECTION_REBUILD_PENDING") {
    showFailureAlert("HELPER_LAUNCH_FAILED")
  }
  exit(process.terminationStatus)
}

private func selfError(_ code: String, _ detail: String) -> Never { error(code, detail) }

private func fixtureLaunch(_ options: [String: String]) -> Never {
  guard let helper = options["--helper"], helper.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: helper) else { error("FIXTURE_HELPER_INVALID") }
  invokeHelper(helper)
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

private func restartDock() {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/killall")
  process.arguments = ["Dock"]
  try? process.run()
  process.waitUntilExit()
}

private func dockStatus(_ managedPath: String?) -> Never {
  if let managedPath {
    let expected = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Codex Task Progress.app").standardizedFileURL.path
    guard URL(fileURLWithPath: managedPath).standardizedFileURL.path == expected else { error("DOCK_PATH_INVALID") }
  }
  let entries = readDockItems()
  let configured = managedPath.map { path in entries.contains { isTile($0, bundle: managedBundleID, path: path) } } ?? entries.contains { tileData($0)?["bundle-identifier"] as? String == managedBundleID }
  emit(["ok": true, "code": "DOCK_STATUS", "dockConfigured": configured, "currentCodex": "untouched"])
}

private func installDock(originalPath: String, managedPath: String, receiptPath: String) -> Never {
  validateManagedPath(managedPath, receiptPath: receiptPath)
  let before = readDockItems()
  let plan = DockInstallPlan(before: before, originalPath: originalPath, managedPath: managedPath)
  let entries = plan.entries
  let originalEntries = plan.originalEntries
  let originalPositions = plan.originalPositions
  let replaced = plan.replaced
  let changed = plan.changed
  let previousReceiptData = FileManager.default.contents(atPath: receiptPath)
  let existingReceipt = readReceipt(receiptPath)
  let previousOriginals = existingReceipt?["originalEntries"] as? [[String: Any]] ?? []
  let previousPositions = existingReceipt?["originalPositions"] as? [Int] ?? []
  let installedPairs = entries.enumerated().filter { isTile($0.element, bundle: managedBundleID, path: managedPath) }
  let mergedOriginals = previousOriginals + originalEntries
  let mergedPositions = previousPositions + originalPositions
  if existingReceipt == nil || !originalEntries.isEmpty {
    let receipt: [String: Any] = [
      "schemaVersion": 1,
      "originalEntries": mergedOriginals,
      "originalPositions": mergedPositions,
      "installedEntries": (existingReceipt?["installedEntries"] as? [[String: Any]] ?? []) + (existingReceipt == nil ? installedPairs.map(\.element) : originalPositions.map { entries[$0] }),
      "installedPositions": (existingReceipt?["installedPositions"] as? [Int] ?? []) + (existingReceipt == nil ? installedPairs.map(\.offset) : originalPositions),
      "managedAppPath": managedPath,
    ]
    do { try atomicWrite(try plistData(receipt), path: receiptPath) } catch { selfError("DOCK_RECEIPT_WRITE_FAILED", error.localizedDescription) }
  }
  guard changed else { emit(["ok": true, "code": "DOCK_ALREADY_CONFIGURED", "changed": false, "dockConfigured": true]) }
  guard writeDockItems(entries, expected: before) else {
    if let previousReceiptData { try? atomicWrite(previousReceiptData, path: receiptPath) }
    else { try? FileManager.default.removeItem(atPath: receiptPath) }
    error("DOCK_PREFERENCES_CHANGED", "Dock settings changed during install; retry.")
  }
  restartDock()
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
  let expectedApp = home.appendingPathComponent("Applications/Codex Task Progress.app").standardizedFileURL.path
  let expectedReceipt = home.appendingPathComponent("Library/Application Support/CodexTaskProgress/launcher/dock-receipt.plist").standardizedFileURL.path
  guard URL(fileURLWithPath: managedPath).standardizedFileURL.path == expectedApp,
        URL(fileURLWithPath: receiptPath).standardizedFileURL.path == expectedReceipt else { error("DOCK_PATH_INVALID") }
}

private func removeDock(managedPath: String, receiptPath: String) -> Never {
  validateManagedPath(managedPath, receiptPath: receiptPath)
  let before = readDockItems()
  guard let receipt = readReceipt(receiptPath), receipt["originalEntries"] is [[String: Any]], receipt["installedEntries"] is [[String: Any]] else {
    if before.contains(where: { isTile($0, bundle: managedBundleID, path: managedPath) }) { error("DOCK_RECEIPT_MISSING", "The managed Dock tile is present but its restore record is unavailable.") }
    emit(["ok": true, "code": "DOCK_RECEIPT_MISSING", "changed": false, "dockConfigured": false, "keepManagedApp": false])
  }
  guard receipt["managedAppPath"] as? String == managedPath else { error("DOCK_RECEIPT_INVALID") }
  let plan = DockRestorePlan(before: before, managedPath: managedPath, receipt: receipt)
  guard !plan.keepManagedApp else { emit(["ok": true, "code": "DOCK_USER_EDIT_PRESERVED", "changed": false, "dockConfigured": true, "keepManagedApp": true]) }
  if plan.changed {
    guard writeDockItems(plan.entries, expected: before) else { error("DOCK_PREFERENCES_CHANGED", "Dock settings changed during restore; retry.") }
    restartDock()
  }
  try? FileManager.default.removeItem(atPath: receiptPath)
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
  showAppAlert = argv.count == 1 && Bundle.main.bundleURL.pathExtension == "app"
  launchHelper()
}
if command == "fixture-launch" { fixtureLaunch(options) }
if command == "dock-fixture" { dockFixture(options) }
if command == "dock-fixture-remove" { dockFixtureRemove(options) }
if command == "dock-fixture-seed" { seedDockFixture(options) }
if command == "dock-fixture-inspect" { inspectDockFixture(options) }
if command.hasPrefix("dock-") { runDockCommand(command, options: options) }
error("LAUNCHER_MODE_INVALID")
