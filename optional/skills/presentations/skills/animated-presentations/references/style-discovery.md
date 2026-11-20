# Style discovery

Resolve purpose, audience, duration, content, and speaker-led versus reading-first density from the request. Ask only for missing information that changes the result. Speaker-led decks favor one idea and fewer words per page; reading decks can carry structured detail, but split overflow instead of shrinking text.

## Research before implementation

For a new visual direction, read [STYLE_PRESETS.md](../STYLE_PRESETS.md) and [the compact bold selection index](../bold-template-pack/selection-index.json). Shortlist a suitable base preset and a contrasting bold candidate using audience, formality, density, and mood. Read only shortlisted bold `preview.md` cards; index paths are relative to the skill root. Choose a direction, then read its actual recipe: the relevant preset section or the selected bold `design.md`. Do not bulk-load all designs.

A direction must affect actual design decisions: typography and hierarchy, layout rhythm, palette, graphic vocabulary, and opening/closing composition. Do not satisfy this step by naming a template, changing only an accent color, or copying the starter. Preserve the user's content instead of copying template demo text. A custom direction is valid when it better fits the subject; identify its primary library recipe, read that recipe (not only its preview), and explain the useful traits retained and the reason for departing. A clearly specified existing theme or a narrow edit does not need a new selection exercise.

## Direct generation versus user selection

"Choose for me", "do not ask", or "generate directly" means select the best researched direction yourself and proceed. Do not wait for approval or force previews. It does not waive the research and recipe steps above. Record a concise rationale and actual resource paths in the requested process notes or delivery evidence, outside the slides.

When the user wants to explore or has not waived selection, show three real title-slide HTML previews: a base preset, a suitable bold candidate, and a contrasting custom or second template. Use actual title/content, keep internal option/template names and paths outside the slide, and let the user choose before full generation. In this user-selection mode, load the final bold design after the user chooses; in direct mode, load it after your own selection without waiting. Expand the selected system consistently across the deck rather than switching themes later.

## Make the design serve the talk

Choose a subject-relevant graphic motif and a relationship between the opening and closing. Vary composition for statement, sequence, comparison, evidence, and action scenes; do not turn every scene into the same row of cards. Design movement with those forms, using [motion direction](motion-direction.md), before wiring the controller. This is a design judgment, not a quota of effects, motifs, or slide layouts.

Source recipes are guidance, subordinate to brand, accessibility, language, aspect ratio, delivery, and offline requirements. Online fonts are optional; package licensed fonts locally or use suitable system fonts. Translate viewport-fluid proportions into fixed-stage coordinates when using a fixed-stage deck. See [HTML architecture](../html-template.md).

Save temporary previews separately and remove only task-generated previews when no longer needed. Keep user assets and earlier work.
