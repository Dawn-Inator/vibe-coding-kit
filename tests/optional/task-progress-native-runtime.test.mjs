// Native-only plugin suites. The tsx toolchain is a required dev dependency; a missing install fails closed.
import {
  importTaskProgressToolchainModule,
  requireTaskProgressToolchain,
} from '../support/task-progress-toolchain.mjs';

requireTaskProgressToolchain('tsx/esm/api', 'esbuild');
const { register } = await importTaskProgressToolchainModule('tsx/esm/api');
register();
await import('../../optional/plugins/codex-task-progress/tests/native-installer-contract.test.mjs');
await import('../../optional/plugins/codex-task-progress/packages/host/test/native-only.test.ts');
await import('../../optional/plugins/codex-task-progress/tests/source-launcher.test.mjs');
