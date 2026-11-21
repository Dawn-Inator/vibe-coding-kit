---
name: animated-presentations
description: Create or enhance browser-based presentations with visual storytelling, coordinated transitions, and accessible animation. Use for HTML slide decks, interactive talks, animating existing web slides, or adapting PPTX content into HTML.
---

# Animated presentations

Build a presentation people can actually present: a clear narrative and readable pages, purposeful motion, and controls that work. This skill combines the presentation-design approach of [Frontend Slides](https://github.com/zarazhangrui/frontend-slides) with techniques from [web-animation-skills](https://github.com/iart-ai/web-animation-skills). Frontend Slides resources are bundled at a pinned revision; no separate upstream skill or plugin installation is needed. See [sources and adaptations](references/sources.md).

## Scope and format

- Create a new browser deck, improve an existing one, or adapt provided slide content. Respect the requested format, framework, theme, language, and level of motion. If the user requests PPTX/PDF as the final deliverable, use an appropriate presentation/export workflow and verify the exported result; browser animations do not automatically survive export.
- For a new HTML deck, default to a self-contained file with inline CSS/JS and embedded or locally packaged assets when practical. Use a framework such as reveal.js or a timeline library when it fits the request; do not claim offline support if fonts, images, libraries, or other required assets are remote.
- For an existing deck, inspect its structure, dependencies, and behavior before making focused changes. A request for a fresh start means create a new narrative and design without reading or reusing the earlier deck unless the user authorizes it.
- Resolve purpose, audience, duration, aspect ratio, content, and delivery context from the request; ask only for missing information that materially changes the result. Live talks usually need fewer words and more progressive disclosure than reading decks.

## Design and motion workflow

Follow the staged process in [style discovery](references/style-discovery.md) for a new deck or a new visual direction. Keep explicit user milestones; a request for representative pages is not authorization to generate the whole deck. Narrow edits to an approved deck keep its direction and need no new approval exercise.

1. **Shape the story before selecting a style.** Outline the narrative and give each slide a clear job. Decide its focal relationship, legible hierarchy, and breathing room; use diagrams, photography, illustration, or working interactions when they help explain the subject. Consider audience, duration, content density, diagram and comparison needs, and user references when choosing a visual direction. Library recipes, a custom direction, and a user reference are equally valid starting points. When library use is requested, actually consult it and explain the choice. Refer to authorized, user-approved prior work to retain its advantages.
2. **Co-design the motion and visual direction.** Read [motion direction](references/motion-direction.md). Plan meaningful, varied choreography as a sequence across scenes: coordinate title, diagram, and emphasis into composed beats, maintain useful continuity, and leave quiet reading moments. Map representative scenes to initial/middle/final states and timing. For function-driven briefs, read [function animation](references/function-animation.md) and implement actual progress renderers. When a library recipe is selected, read it completely before writing any slide in that direction; preserve its essential grammar and disclose material departures before expansion. Do not impose optional motifs on every scene or fill space merely to simulate density; choose a better-fitting direction if needed.
3. **Build representative pages first.** For a new direction, normally prove a cover, a process/diagram, and a comparison or other demanding content layout, using real content and actual motion. Read [HTML architecture](html-template.md); the [starter](assets/starter.html) provides mechanics only. Wire keyboard navigation, progress, replay, reduced motion, deterministic scene state, and cancellation of interrupted timelines as needed. Keep preview, replay, pause, and seek controls outside the authored slide canvas; provide a clean artwork view. Explicit user scope and confirmation gates remain in force.
4. **Review the actual proof.** Open the representative pages in a browser. Assess story, composition, direction fidelity, and motion quality separately from readability, clipping, navigation, interruption, reduced motion, and deterministic export behavior. Inspect settled pages, playback, and intermediate states. If an unapproved proof repeatedly misses the aesthetic goal, decide whether a composition change within the grammar can solve it or whether the art direction is wrong; openly return to selection in the latter case before expanding. Present the working artifact and concise adaptation notes. When the user requested confirmation, stop and wait; only the user's confirmation authorizes expansion.
5. **Expand the approved direction, then verify.** Reuse its composition grammar, graphic vocabulary, palette, type hierarchy, and motion language across the deck. Inspect every slide and transitions, including reverse/rapid navigation, desktop/phone views, offline dependencies when promised, and exports actually requested. Read [browser verification](references/browser-verification.md). Do not report the aesthetic goal achieved just because technical checks pass or resources were read.

## Delivery

Provide the runnable artifact and concise navigation instructions. State any network or local-server requirement, whether media are embedded, and the practical limits of exports or small screens. Do not describe an animation as tested merely because its code exists.

## Conversion, export, and sharing

Read [tool usage](references/tools.md) only when extracting PPTX, exporting PDF, or publishing. The bundled tools are `scripts/extract-pptx.py`, `scripts/export-pdf.py`, and `scripts/deploy.py`. Optional Python packages, Chromium, and hosting CLI credentials are needed only for the selected operation, not to install or view the HTML skill. Do not silently install them.

PPTX extraction is a starting point for redesign, not a lossless conversion. Inspect omitted tables, charts, groups, media, and original slide rendering before claiming content preservation. PDF is a static snapshot; verify its pages separately. Publishing requires an explicit user request and a reviewed folder containing only intended public assets; no host is selected by default.
