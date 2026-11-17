// Native-only plugin suites. The tsx toolchain is a required dev dependency; a missing install fails closed.
import { pathToFileURL } from 'node:url';
import { requireTaskProgressToolchain } from '../support/task-progress-toolchain.mjs';

const require = requireTaskProgressToolchain('tsx/esm/api', 'esbuild');
const { register } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
register();
await import('../../optional/plugins/codex-task-progress/tests/native-installer-contract.test.mjs');
await import('../../optional/plugins/codex-task-progress/packages/host/test/native-only.test.ts');
await import('../../optional/plugins/codex-task-progress/tests/source-launcher.test.mjs');
