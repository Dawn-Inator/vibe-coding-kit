---
name: animated-presentations
description: Create or enhance browser-based presentations with visual storytelling, coordinated transitions, and accessible animation. Use for HTML slide decks, interactive talks, or animating existing web slides.
---

# Animated presentations

Build a presentation people can actually present: a clear narrative and readable pages, purposeful motion, and controls that work. This skill combines the presentation-design approach of [Frontend Slides](https://github.com/zarazhangrui/frontend-slides) with techniques from [web-animation-skills](https://github.com/iart-ai/web-animation-skills). Its instructions are self-contained; neither upstream skill needs to be installed.

## Scope and format

- Create a new browser deck, improve an existing one, or adapt provided slide content. Respect the requested format, framework, theme, language, and level of motion. If the user requests PPTX/PDF as the final deliverable, use an appropriate presentation/export workflow and verify the exported result; browser animations do not automatically survive export.
- For a new HTML deck, default to a self-contained file with inline CSS/JS and embedded or locally packaged assets when practical. Use a framework such as reveal.js or a timeline library when it fits the request; do not claim offline support if fonts, images, libraries, or other required assets are remote.
- For an existing deck, inspect its structure, dependencies, and behavior before making focused changes. A request for a fresh start means create a new narrative and design without reading or reusing the earlier deck unless the user authorizes it.
- Resolve purpose, audience, duration, aspect ratio, content, and delivery context from the request; ask only for missing information that materially changes the result. Live talks usually need fewer words and more progressive disclosure than reading decks.

## Design and motion workflow

1. Outline the story and choose a coherent visual direction before coding. Give each slide a clear job, a legible hierarchy, and breathing room. Use diagrams, photography, illustration, or working interactions when they help explain the subject; avoid decorative repetition. Honor explicit preferences such as a white background.
2. Plan motion as a sequence across the deck. Match transitions to meaning and vary their shape, direction, timing, or choreography when an expressive deck calls for variety. Animate related title, diagram, and emphasis elements as one composed beat, and preserve shared visual continuity where it helps orientation. Do not satisfy a request for varied motion with the same fade and repeated particles on every page. See [motion direction](references/motion-direction.md).
3. Build the deck and its controls. Support keyboard navigation, visible navigation/progress, a logical reading order, and presenter notes or editable text when useful. For fixed-stage slides, scale the whole intended aspect ratio to the viewport; keep all content inside the slide and account for overlays and controls. Avoid trapping interactive controls inside navigation gestures.
4. Respect `prefers-reduced-motion`; use short opacity changes in place of large movement and retain the content and functionality. Favor compositor-friendly `transform` and `opacity`, clean up interrupted timelines, and do not rely on animation completion to reveal essential content. See [motion direction](references/motion-direction.md).
5. Open the finished deck in a real browser and inspect every slide and representative transition frames, including reverse and rapid navigation. Exercise interactive examples, reduced motion, and at least desktop and phone viewports. Iterate on visible defects; report what was actually checked and any limitations. See [browser verification](references/browser-verification.md).

## Delivery

Provide the runnable artifact and concise navigation instructions. State any network or local-server requirement, whether media are embedded, and the practical limits of exports or small screens. Do not describe an animation as tested merely because its code exists.
