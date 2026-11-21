# Deep Space Theatre: a reusable optional theme

Use this direction when a speaker-led talk benefits from a large celestial main object, a chapter map, and continuity between explanations. Inspect the [six-page runnable example](../assets/examples/deep-space-theatre/index.html), [composition preview](../assets/examples/deep-space-theatre/preview.png), and source together. Its subject, **从一句需求到可验收交付**, is an example of content adaptation. Other themes remain equally valid; the presenter runtime works without a starfield.

The direction draws on the local PKU presentation's chapter continuity, content-specific diagrams and speaker pacing. It does not bundle that presentation's speech, images, music or project-specific engine. The [Delivery Practice example](delivery-practice.md) remains a separate approved direction with its original scene playback.

## Complete visual recipe

Use the example's **1600 × 900** fixed stage, **88 px** horizontal safe margins, ink `#090f18`, warm paper `#f4f0e6`, fog `#b6c3cc`, amber `#e9bd82` and cyan `#8bd9cf`. Ink and fog establish depth; paper carries the main claim or source material; amber and cyan indicate emphasis and different relationships. Do not scatter both accents across every object.

Large chapter and cover type uses a CJK serif stack (`Songti SC`, `STSong`, `Noto Serif CJK SC`, serif); explanatory type uses `PingFang SC`, `Microsoft YaHei`, sans-serif. The example's cover is about **112 px** with **1.17** line height; page headings are about **65 px**, supporting copy **28–32 px**, main diagram labels **27–31 px**, and notes **20–22 px**. These sizes belong to this stage. System font metrics differ: measure actual CJK text and preserve the intended hierarchy when substituting a font or changing the canvas.

The main object must carry enough scale and detail to organize the page. Cover and chapter scenes pair a large claim with a sculptural planet, orbit or network; the atlas distributes distinct main objects over a connected route. Retain generous negative space around them and keep light behind the object rather than behind body text. A few tiny stars on a plain gradient do not reproduce this direction. Equally, a planet need not appear beside an unrelated table or screenshot.

Keep the chapter's type, palette and lighting vocabulary while changing the body composition with its job:

- **Cover:** a large claim and one dominant celestial object establish the stage; introduce them as a composed beat.
- **Atlas:** objects become an overview of the explanation, linked spatially in the order the speaker will follow.
- **Process:** keep the global route visible; use the center for the workpiece currently changing or being handed off.
- **Comparison:** align concrete clues and observable outcomes so the difference has a visible relationship, rather than two interchangeable bullet cards.
- **Evidence:** let the complete material dominate a calmer stage. Preserve its caption and source context, and offer original-image inspection when useful. The bundled delivery record is labelled **示意** and is not a real acceptance receipt.
- **Closing:** return to the opening's visual vocabulary with a clear next action; the echo should feel resolved rather than like a duplicate cover.

This range is the recipe's grammar. The number and order of pages follow the real story, not the example's six-page count.

## Meaning becomes motion

For each beat choose **content meaning → main object/relationship → semantic step → progress function**. The speaker advances the explanation; time performs the current action and then stops at a readable result. The example's stable scene keys are `cover`, `atlas`, `process`, `comparison`, `evidence` and `closing`.

The process combines a persistent route with a changing workpiece, so the audience can locate the current operation without losing the whole sequence. Comparison steps connect a clue to behavior before resolving the difference. Material-led scenes reduce environmental intensity instead of competing with the material. Cover, atlas and closing can use more expressive scale, light and orbital movement. A shared camera or light transition gives useful chapter continuity; generic wrapper fades do not supply the explanation.

Keep finite actions, semantic steps and ambient time distinct. Subtle star or planet movement may continue during a reading hold when it does not compete, but pause, reduced motion and export must freeze it. Each step's renderer must work after arbitrary seeking, backward navigation or page reordering. Read [function animation](function-animation.md) for those invariants.

## Reuse the code

For the complete example, copy `assets/runtime/`, `assets/themes/deep-space-theatre/`, and `assets/examples/deep-space-theatre/` together, preserving their relative layout. Open the copied example's `index.html`; its local script order loads the presenter, bundled Three.js, theme renderer and example scene factories. If relocating the HTML, update all relative CSS/JS paths. No CDN, package installation or private PKU asset is required. Keep the associated license notices when distributing it.

Adapt the scene factories in `scenes.js` and the authored sections in `index.html` together. Replace visible copy, labels, document metadata, accessibility labels, source captions and illustrative examples. Remove or reorder unused `section[data-scene]` elements; their stable keys select scoped factories and their present DOM order determines navigation. Rebuild measured geometry for new labels rather than stretching an old diagram around longer text. The example stylesheet is part of the composition recipe, not a generic unthemed starter.

The [presenter](../assets/runtime/presenter.js) is theme-independent:

```js
const theme = createDeepSpaceTheme(themeHost, {
  width: 1600, height: 900, seed: 20261121, webgl: true
});
const proof = createPresenter({stage, sceneDefinitions, theme});
```

Each `sceneDefinitions[key](section)` returns `steps: [{durationMs, render(p)}]`, optional `measure()`, and static `theme` parameters or `getTheme({step, progress, timeMs})`. `render(p)` paints a complete semantic state, including prior results and future visibility. The controller owns time and keyboard navigation. Use `proof.onChange(callback)` to update controls outside the authored canvas. The public inspection and export contract is described in [function animation](function-animation.md).

The [theme renderer](../assets/themes/deep-space-theatre/theme.js) can also be used with another controller. `createDeepSpaceTheme(host, {width, height, seed, webgl})` returns `render(state)`, `resize()`, `dispose()` and `getState()`. It has no autonomous animation loop or knowledge of slide titles, page numbers or keyboard controls. A render state contains:

```js
{
  timeMs: 1200,
  light: [0.78, 0.3], tint: '#8bd9cf', level: 0.6, cameraX: 0,
  objects: [{
    id: 'chapter-object', kind: 'planet',
    x: 1160, y: 450, radius: 210,
    rotation: 0.3, reveal: 1, color: '#e9bd82'
  }]
}
```

`light` uses normalized coordinates; object positions and radii use stage pixels. Object kinds are `planet`, `network` and `ring`. Keep IDs stable while interpolating a shared object. A fixed seed and explicit time make the field repeatable. The theme uses local MIT Three.js r180 with original procedural graphics and supplies a Canvas fallback when WebGL is unavailable. A fallback must retain the intended main object and composition; verify it alongside normal rendering after changing object geometry or positions. See [sources and adaptations](sources.md) for provenance.

## Review the adapted presentation

Watch each step and sample its initial, middle and final states; inspect the last animated frame against the first cleaned-up frame. Check step-back/forward replay, direct page navigation, rapid reversals, pause/seek, backgrounding, live reduced motion and stable whole-page/step export. Confirm that meaningful graphics still explain the new content and do not cross text. Inspect the actual WebGL fallback and offline delivered folder.

Review consecutive pages to judge chapter continuity, changing composition and quiet reading moments together, within the authorized proof scope. Provide actual playable motion when asking for visual approval. Technical checks establish behavior; they do not establish that a new composition matches the intended visual quality. Follow [browser verification](browser-verification.md), and retain any explicit user confirmation milestone before expanding a new direction.
