# Browser verification

Read when finishing or modifying the deck. Use available browser tooling and record observations rather than assuming that source code or a static screenshot proves the animation works.

1. Open the actual deliverable. Check all slides after motion settles at the target presentation size: text is legible, visual hierarchy is intact, no content clips or overlaps, and images load. Inspect at least one phone viewport; a fixed 16:9 stage may become small in portrait, so note that limitation rather than claiming responsive reflow.
2. Observe representative transitions at their midpoint as well as completion. For a deck requested to have distinct effects, inspect each transition, not just one. Check that layers and shared elements end in the correct place and do not obscure controls. A deterministic debug option to pause timelines at a chosen time can help, but should not interfere with normal playback.
3. Use next and previous controls, keyboard navigation, and fast direction changes. Confirm one slide remains active, no temporary overlay or hidden slide intercepts input, and stepwise reveals restore correctly. Test any timer, form, or other interaction in the delivered file; do not merely confirm that a button exists.
4. Exercise reduced motion using the browser/OS setting or an explicit development override. Confirm essential content and controls remain available and large motion is absent. Inspect runtime/console and failed asset requests if tooling allows.
5. When offline or self-contained behavior is promised, inspect dependencies and open without network access if feasible. If unavailable, explain what was verified and what was not. Check presentation-specific constraints (e.g. notes, editable text, export) only when offered as features.

Fix issues and repeat the affected checks. Deliver the file path or runnable URL, navigation instructions, and concise facts about what was checked; avoid reporting unobserved performance or exports as successful.
