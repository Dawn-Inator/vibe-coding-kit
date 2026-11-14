// Keep regression implementations with the optional component. These wrappers use
// Node built-ins; native Dock tests compile a temporary Swift fixture only on macOS
// when Swift is available, so no plugin development toolchain is required.
import '../../optional/plugins/codex-task-progress/tests/startup-runtime.test.mjs';
import '../../optional/plugins/codex-task-progress/tests/dock-launcher-runtime.test.mjs';
