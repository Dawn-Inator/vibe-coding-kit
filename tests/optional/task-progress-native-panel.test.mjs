// Task Progress release and native-panel suites. Their toolchain is a required dev dependency of the
// plugin: when it is missing the suite fails closed with install instructions (see support helper).
import { requireTaskProgressToolchain } from '../support/task-progress-toolchain.mjs';

requireTaskProgressToolchain('esbuild', '@playwright/test');
await import('../../optional/plugins/codex-task-progress/tests/plugin-release.test.mjs');
await import('../../optional/plugins/codex-task-progress/tests/native-panel.test.mjs');
