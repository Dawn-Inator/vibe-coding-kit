# Style discovery

For a new deck, infer purpose, audience, duration, content, and speaker-led versus reading-first density from the request. Ask only for missing information that changes the result. Speaker-led decks favor one idea and fewer words per page; reading decks can carry structured detail, but split overflow instead of shrinking text.

Unless the user already chose a theme or wants direct generation, show three distinct single-slide HTML previews using the actual title and content:

1. A readable option from [STYLE_PRESETS.md](../STYLE_PRESETS.md).
2. A suitable bold design from [the compact selection index](../bold-template-pack/selection-index.json).
3. A context-specific custom direction or a contrasting second template.

Index paths are relative to the skill root. Match mood, formality, density, and audience; read only shortlisted candidates’ `preview.md` files. After selection, read only that template’s `design.md`. Do not bulk-load all designs. The pack contains design recipes, not ready-made `template.html` decks; generate actual slides from the chosen system. If the user chooses a custom direction, expand that preview’s own system.

Use real slide content in previews. Keep option names, template names, paths, process notes, and requirement labels in the accompanying message, outside the slide. Present previews with available browser tooling and let the user select or combine them before full generation. For a settled theme, skip selection and apply it directly.

Treat source recipes as visual guidance. Preserve explicit brand, font, accessibility, aspect ratio, delivery, and language requirements. Online font examples are optional; package licensed fonts locally or use suitable system fonts for offline delivery. Translate viewport-fluid recipe values into fixed-stage coordinates when using a fixed-stage deck. See [HTML architecture](../html-template.md).

Save temporary previews separately from the final artifact. Remove only previews generated for this task when no longer needed. Do not remove user assets or earlier work.
