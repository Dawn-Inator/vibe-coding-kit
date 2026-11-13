# Task Progress visual prototype

`task-progress-frosted.html` is a self-contained, interactive design study. Open the HTML
file in a browser, or serve this directory with a local static HTTP server. It uses inline
CSS, JavaScript, SVG icons and explicitly labelled mock records; it has no external
dependencies, task-store connection or production-plugin effects.

The design includes a 44px task capsule with progress along its lower curved edge,
two 40px history/heartbeat buttons, and task → module → node disclosure. Only one
panel opens at a time. Escape first collapses a focused module, then closes the panel
and returns focus to its trigger. Short windows use a viewport-constrained panel.

Use the top-right buttons to compare light and dark themes. The default follows the
system theme. Deterministic preview parameters are also available:

- `theme=light` or `theme=dark`
- `state=idle`, `state=open`, `state=detail`, `state=history`, or `state=heartbeat`
- `title=long` to inspect a long task title
- `motion=reduce` to preview reduced motion; the system preference is also respected

For example: `task-progress-frosted.html?theme=dark&state=detail`.

Progress is derived from 13 completed mock nodes out of 24 effective nodes (54%).
Node status and evidence express progress without invented fractional percentages.
Heartbeat content is a read-only mock audit record, independent of execution status.

Browser acceptance on 2026-11-13 covered panel switching, module disclosure, keyboard
navigation, outside-click dismissal and focus return, both themes, a 390×844 narrow
window with a long title, a 390×400 short window, and the system reduced-motion
preference. No JavaScript runtime exceptions were observed. JavaScript syntax and
whitespace checks passed. The built-in browser accepts HTTP/HTTPS only, so browser
acceptance used a local static HTTP server rather than direct `file:` navigation.
The repository test suites were not run for this standalone design artifact.
