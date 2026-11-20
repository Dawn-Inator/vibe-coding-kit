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

1. Outline the story and choose a visual direction before coding. For a new design, read [style discovery](references/style-discovery.md), including when the user says "choose for me" or "generate directly". Direct generation skips the selection conversation, not resource research: compare relevant library directions and apply the selected recipe to composition, typography, graphics, and pacing. Give each slide a clear job. Use diagrams, photography, illustration, or working interactions when they explain the subject. Honor explicit brand, language, and visual preferences.
2. Design the motion with the story. Read [motion direction](references/motion-direction.md) before implementing an animated deck. Choose the main visual motif, the opening/closing relationship, and how explanatory scenes behave: a sequence can unfold, a comparison can converge, and an outcome can resolve. Choreograph related elements instead of attaching one entrance to every container. For code/time-function-driven graphics or motion-led briefs, also read [function animation](references/function-animation.md) and implement content-specific progress renderers, not a generic fade renamed as a function. Keep quiet reading moments where they serve the talk.
3. Implement the visual and motion plan, then wire the controller. Read [HTML architecture](html-template.md). The [starter](assets/starter.html) supplies navigation, stage scaling, accessibility, and an export hook; its sample page styling is not a deck theme or an animation recipe. Use only its needed mechanics, replace its composition with the chosen design, and keep controls visually subordinate. For a new fixed-stage deck, include [stage CSS](viewport-base.css) inline; default to 1920x1080 unless the user or existing deck calls for another ratio. Support keyboard navigation and visible progress. Local/system fonts are supported; check glyph coverage and offline dependencies.

4. Respect `prefers-reduced-motion`; use short opacity changes in place of large movement and retain the content and functionality. Favor compositor-friendly `transform` and `opacity`, clean up interrupted timelines, and do not rely on animation completion to reveal essential content. See [motion direction](references/motion-direction.md).
5. Verify design and choreography as well as functionality: check whether the chosen resource actually shaped the deck, whether scenes have a deliberate rhythm, and whether the opening/closing feel authored for this subject. A running deck or a count of animation types is not evidence of visual quality. Open the finished deck in a real browser and inspect every slide and representative transition frames, including reverse and rapid navigation. Exercise interactive examples, reduced motion, and at least desktop and phone viewports. Iterate on visible defects; report what was actually checked and any limitations. See [browser verification](references/browser-verification.md).

## Delivery

Provide the runnable artifact and concise navigation instructions. State any network or local-server requirement, whether media are embedded, and the practical limits of exports or small screens. Do not describe an animation as tested merely because its code exists.

## Conversion, export, and sharing

Read [tool usage](references/tools.md) only when extracting PPTX, exporting PDF, or publishing. The bundled tools are `scripts/extract-pptx.py`, `scripts/export-pdf.py`, and `scripts/deploy.py`. Optional Python packages, Chromium, and hosting CLI credentials are needed only for the selected operation, not to install or view the HTML skill. Do not silently install them.

PPTX extraction is a starting point for redesign, not a lossless conversion. Inspect omitted tables, charts, groups, media, and original slide rendering before claiming content preservation. PDF is a static snapshot; verify its pages separately. Publishing requires an explicit user request and a reviewed folder containing only intended public assets; no host is selected by default.
