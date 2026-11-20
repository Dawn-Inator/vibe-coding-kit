# Sources and adaptations

The single Kit entry point remains `animated-presentations`, in the optional `non-code` presentation component. No second `frontend-slides` skill or plugin entry is installed.

Bundled resources come from [Frontend Slides](https://github.com/zarazhangrui/frontend-slides/tree/9906a34d640d2111f724544cbc50f7f130569ae1), revision `9906a34d640d2111f724544cbc50f7f130569ae1`. Its MIT copyright and permission notice is retained in [LICENSE](../LICENSE). The bold design recipes identify `zarazhangrui/beautiful-html-templates` as their source library; this import uses the pack shipped in the pinned Frontend Slides revision, not an independently fetched template library. Font and media examples do not confer licenses to third-party assets; check those when bundling them in a deliverable.

Imported resources:

- `STYLE_PRESETS.md`: 12 base style recipes.
- `bold-template-pack/selection-index.json` and 34 pairs of `preview.md`/`design.md`: progressive style selection and design recipes. No ready-made source `template.html` files are included.
- `viewport-base.css` and `animation-patterns.md`: stage layout and animation examples.
- `scripts/extract-pptx.py`: PPTX text, image, and notes extraction, adapted to reject an existing output folder.

Kit adaptations:

- Retain the existing motion and browser-verification guidance, inspired by [web-animation-skills](https://github.com/iart-ai/web-animation-skills); no additional files from that project are imported here.
- Replace the upstream HTML reference with `html-template.md` and a runnable `assets/starter.html` containing actual navigation, accessibility state, and an explicit export hook. The starter is a technical scaffold with static sample pages, not the visual or motion default.
- Replace the shell export/deploy helpers with Python adapters following the upstream screenshot/PDF and Vercel workflows. Dependency installation, login, publication, and opening apps are not automatic. Export preserves deck layout and uses an explicit final-state hook; publishing takes a reviewed complete folder.
- Add mandatory resource research for new visual directions even in direct-generation mode, and Kit-authored function-animation/choreography guidance with primary-source references.
- Keep the supplied style recipes intact as reference material, except the base-style introduction is clarified for Kit. Their original preferences for specific fonts, canvas size, or decorative vocabulary are subordinate to the entry point’s explicit user, brand, accessibility, and offline requirements. Omit the upstream pack workflow README and unused legacy stage controller to avoid competing controllers/instructions.

The optional catalog records the pinned source and the complete staged component tree hash. Update both provenance and the staged hash when changing this component. Do not import the upstream skill/plugin manifests as another entry point.
