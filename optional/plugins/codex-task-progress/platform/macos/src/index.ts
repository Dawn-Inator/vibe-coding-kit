export {
  CODEX_BUNDLE_ID,
  CODEX_TEAM_ID,
  type CodexAppDiscoveryResult,
  type CodexMacosAppIdentity,
  type CommandResult,
  type CommandRunner,
  type DiscoverCodexAppsOptions,
  discoverCodexMacosApps,
  type InspectCodexAppOptions,
  inspectCodexMacosApp,
  type MacosExecutableArchitecture,
  type RejectedCodexAppCandidate,
  requireSingleCodexMacosApp,
  runSystemCommand,
} from "./app-discovery.js";

export {
  executeMacosCommand,
  MACOS_COMMAND_NAMES,
  type MacosCommandHandler,
  type MacosCommandHandlers,
  type MacosCommandInput,
  type MacosCommandName,
  type MacosCommandResult,
  type ParseMacosCommandResult,
  parseMacosCommand,
  serializeMacosCommandResult,
  serializeMacosCommandResultHuman,
} from "./command-protocol.js";

export {
  ensureMacosInstallationDirectories,
  GOAL_PROGRESS_LAUNCH_AGENT_LABEL,
  MACOS_PRIVATE_DIRECTORY_MODE,
  MACOS_PRIVATE_FILE_MODE,
  type MacosInstallationLayout,
  type ResolveMacosInstallationLayoutInput,
  resolveMacosInstallationLayout,
} from "./install-layout.js";
export {
  type InstallRollbackResult,
  type InstallStepResult,
  InstallTransaction,
} from "./install-transaction.js";
export {
  type CreateMacosCommandHandlersOptions,
  createLaunchAgentController,
  createMacosCommandHandlers,
  createPluginController,
  type LaunchAgentController,
  type PluginController,
} from "./installer.js";
export {
  createReleasePluginRuntimeFiles,
  type ReleasePluginRuntimeFiles,
} from "./plugin-release.js";
export {
  assertSafeMacosReleaseOutput,
  type CreateMacosReleaseManifestInput,
  createMacosReleaseManifest,
  GOAL_PROGRESS_MACOS_RELEASE_NODE_VERSION,
  type MacosReleaseFile,
  renderSha256Sums,
} from "./release.js";

export {
  type CheckGoalProgressUpdateOptions,
  checkGoalProgressUpdateManifest,
  GOAL_PROGRESS_UPDATE_CHECK_TIMEOUT_MS,
} from "./update-checker.js";
export {
  assertGoalProgressExtractedTree,
  assertGoalProgressRealDirectory,
  cleanupOrphanedGoalProgressUpdateDownloads,
  createGoalProgressUpdateFetch,
  GOAL_PROGRESS_UPDATE_ARCHIVE_ROOT,
  GOAL_PROGRESS_UPDATE_METADATA_TIMEOUT_MS,
  GOAL_PROGRESS_UPDATE_SHA256SUMS_MAX_BYTES,
  GOAL_PROGRESS_UPDATE_ZIP_MAX_BYTES,
  GOAL_PROGRESS_UPDATE_ZIP_TIMEOUT_MS,
  type GoalProgressUpdateDownloadProgress,
  type GoalProgressUpdateNodeRequest,
  type PreparedGoalProgressUpdate,
  type PrepareGoalProgressUpdateOptions,
  prepareGoalProgressUpdate,
} from "./update-downloader.js";

export {
  compareGoalProgressVersions,
  GOAL_PROGRESS_MACOS_UPDATE_ASSET,
  GOAL_PROGRESS_UPDATE_MANIFEST_MAX_BYTES,
  GOAL_PROGRESS_UPDATE_MANIFEST_URL,
  type GoalProgressUpdateManifest,
  goalProgressVersionedUpdateUrls,
  parseGoalProgressUpdateManifest,
} from "./update-manifest.js";
export {
  GOAL_PROGRESS_UPDATE_INSTALL_WORKER_LEASE_MS,
  type GoalProgressUpdateOperation,
  type GoalProgressUpdateOperationResult,
  GoalProgressUpdateOperationResultSchema,
  GoalProgressUpdateOperationSchema,
  type GoalProgressUpdateOperationStore,
  MacosGoalProgressUpdateOperationStore,
  resolveMacosUpdateOperationPath,
  verifyInstalledGoalProgressUpdate,
} from "./update-operation.js";
export {
  GOAL_PROGRESS_RELEASE_URL_PREFIX,
  goalProgressReleaseUrl,
  type MacosReleaseOpener,
  openMacosGoalProgressRelease,
} from "./update-release.js";

export {
  type GoalProgressUpdateStateStore,
  MacosGoalProgressUpdateStateStore,
  resolveMacosUpdateStatePath,
} from "./update-state-store.js";
