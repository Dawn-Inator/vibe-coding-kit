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

1. **Read and establish the design before coding.** Select a primary direction from the library or the user's reference, then read its complete recipe before authoring any slide in that direction. Read large recipes in bounded sections until all sections are covered; a truncated read or a preview card is not the full recipe. Identify the recipe's composition, palette, type hierarchy, density, and signature graphic treatments. Preserve these traits; adapt only for concrete content, language, accessibility, or delivery needs, and disclose any material departure before expansion. Do not silently blend presets or interpret "internal", "clear", or "restrained" as permission to erase the selected design's character.
2. **Plan content and motion together.** Read [motion direction](references/motion-direction.md). Map each representative scene to its focal graphic, initial/middle/final states, timing, and relationship to adjacent scenes. For function-driven briefs, read [function animation](references/function-animation.md). Implement meaningful progress renderers and choreography, with quiet reading moments where appropriate.
3. **Build representative pages first.** For a new direction, normally prove a cover, a process/diagram, and a comparison or other demanding content layout. Use real content, the complete selected recipe, and actual motion. Read [HTML architecture](html-template.md); the [starter](assets/starter.html) provides mechanics only. Wire keyboard navigation, progress, replay, reduced motion, and deterministic scene state as needed. Keep controls outside or subordinate to the slide composition. Do not generate the remaining slides to make a rejected direction look complete.
4. **Review the actual proof.** Open the representative pages in a browser. Check recipe fidelity and narrative/animation quality separately from readability, clipping, navigation, interruption, and reduced motion. Capture settled pages and inspect motion in playback and intermediate states. Present the working artifact plus concise adaptation notes. When the user requested confirmation, stop here and wait for their response; only the user's confirmation authorizes expansion. Use the direct-output exception in the reference only when the user's actual request explicitly supports it, not because a test packet or convenience instruction invented a waiver.
5. **Expand the approved direction, then verify.** Reuse its composition grammar, graphic vocabulary, palette, type hierarchy, and motion language across the deck; do not switch style or simplify its defining features after approval. Inspect every slide and transitions, including reverse/rapid navigation, desktop/phone views, offline dependencies when promised, and exports actually requested. Read [browser verification](references/browser-verification.md). Do not report the aesthetic goal achieved just because checks pass or resources were read.

## Delivery

Provide the runnable artifact and concise navigation instructions. State any network or local-server requirement, whether media are embedded, and the practical limits of exports or small screens. Do not describe an animation as tested merely because its code exists.

## Conversion, export, and sharing

Read [tool usage](references/tools.md) only when extracting PPTX, exporting PDF, or publishing. The bundled tools are `scripts/extract-pptx.py`, `scripts/export-pdf.py`, and `scripts/deploy.py`. Optional Python packages, Chromium, and hosting CLI credentials are needed only for the selected operation, not to install or view the HTML skill. Do not silently install them.

PPTX extraction is a starting point for redesign, not a lossless conversion. Inspect omitted tables, charts, groups, media, and original slide rendering before claiming content preservation. PDF is a static snapshot; verify its pages separately. Publishing requires an explicit user request and a reviewed folder containing only intended public assets; no host is selected by default.
