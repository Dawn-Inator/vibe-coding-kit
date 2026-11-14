import type { CdpController } from "./cdp-controller.js";
import type { MacosCommandInput, MacosCommandResult } from "./command-protocol.js";
import { createDoctorCommand, createVerifyCommand } from "./doctor-command.js";
import type { MacosCommandResultFactory } from "./install-command.js";
import type { InstallationState } from "./installation-state.js";
import type { LaunchAgentController } from "./launch-agent-controller.js";
import { createRepairCommand } from "./repair-command.js";
import type { CodexStartupRecoveryPolicy } from "./startup-recovery-policy.js";

export interface HealthCommandDependencies {
  readonly state: () => InstallationState;
  readonly launchAgent: LaunchAgentController;
  readonly cdp: CdpController;
  readonly commandResult: MacosCommandResultFactory;
  readonly installOrUpgrade: (
    command: "install" | "upgrade",
    input: MacosCommandInput,
  ) => Promise<MacosCommandResult>;
  readonly startupRecoveryPolicy: () => Promise<CodexStartupRecoveryPolicy>;
}

export function createHealthCommands(dependencies: HealthCommandDependencies) {
  const doctor = createDoctorCommand(dependencies);
  const verify = createVerifyCommand(dependencies);
  const repair = createRepairCommand({ ...dependencies, doctor });
  return { doctor, repair, verify };
}
