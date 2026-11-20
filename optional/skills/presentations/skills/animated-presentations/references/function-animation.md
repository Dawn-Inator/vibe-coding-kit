# Function-driven animation

Read for code/time-function-driven graphics, coordinated explanatory scenes, or a motion-led brief. A function animation maps normalized progress to visual state; it need not illustrate mathematical functions. Use native JavaScript/SVG/Canvas or the existing stack. No animation package is required for a self-contained deck.

## Define state before the clock

Give a meaningful scene a renderer `render(p)` for `p` in `[0, 1]`. Its result must depend on `p`, not accumulated frame deltas, random values, or how many times it was called. Keep unrelated scene state outside the renderer. It must be safe to seek forward, backward, or directly to the stable final state.

Useful building blocks (original examples, not a copied library implementation):

```js
const clamp01 = x => Math.max(0, Math.min(1, x));
const lerp = (a, b, p) => a + (b - a) * p;
const easeOutCubic = p => 1 - (1 - clamp01(p)) ** 3;
const smoothstep = p => { p = clamp01(p); return p * p * (3 - 2 * p); };
const segment = (p, start, end) => clamp01((p - start) / (end - start));

// Measure path geometry once, outside the animation loop.
const length = path.getTotalLength();
path.style.strokeDasharray = String(length);
function render(p) {
  const travel = smoothstep(segment(p, 0.12, 0.78));
  const point = path.getPointAtLength(length * travel);
  path.style.strokeDashoffset = String(length * (1 - travel));
  marker.setAttribute('transform', `translate(${point.x} ${point.y})`);
  const settle = easeOutCubic(segment(p, 0.74, 1));
  outcome.style.transform = `scale(${lerp(0.94, 1, settle)})`;
  outcome.style.opacity = String(settle);
}
```

Adapt the geometry and stages to the message. A process can draw its connections, hand off a marker, then resolve its outcome; a comparison can converge two states before highlighting the difference; a shared shape can change role between scenes. These are mechanisms, not mandatory effects. For a motion-led deck, include meaningful state changes in the primary diagram or compared objects; animated underlines alone do not meet that intent. Plain text should settle promptly and remain readable. Keep moving geometry clear of text at every sampled state, including final endpoints and any overshoot. A long auto-playing sequence must not gate navigation or force the speaker to wait.

Avoid applying a small translate/fade to every wrapper and calling that function-driven storytelling. Name what a moving element represents, what changes, and why that change helps the audience. Functions can control scale, rotation, clipping, paths, or spring-like settling when those fit the scene. Bound any overshoot on graphics; opacity and colors must remain in their valid ranges. Continuous sine/orbit motion is optional and should stop when its explanatory job is done.

## Own the clock and cancellation

Use one controlled clock for a scene. For native `requestAnimationFrame`, derive progress from its timestamp and a chosen duration. Keep a frame handle and a run generation; cancelling must both cancel the scheduled frame and invalidate stale callbacks. A callback must check that it still belongs to the active scene before writing. Do not use independent untracked timeouts for every label.

The controller should be able to:

- play or replay a scene from a known state;
- seek deterministically for inspection;
- cancel immediately on navigation, including rapid direction changes;
- finish by explicitly calling the final-state renderer, not merely cancelling the clock.

Do not register a new perpetual loop on every slide entry. Stop offscreen Canvas loops, particles, observers, and scene timelines. Stage dimensions and measured paths should be stable before playback; do not mix frame-by-frame layout reads and writes.

## Reduced motion and export

Reduced motion is a separate viewing mode, not a reason to weaken all normal playback. On entry and on preference change, stop the current clock and paint the stable scene state. Keep essential text, labels, and diagram meaning available without movement. An optional brief opacity change can replace large spatial motion.

For `window.renderSlide(index, {exportMode:true})`: stop clocks, invalidate callbacks, select the scene, render its stable state (normally `p = 1`), remove transient layers, then wait for a paint. Canvas must be explicitly redrawn; cancelling CSS/Web Animations does not finalize function-driven graphics. A function scene must not mutate again after the export hook resolves.

## Verify what the audience sees

For representative scene types, inspect `p = 0`, a middle value, and `p = 1`, then watch normal playback. Confirm the movement actually explains the scene, related parts have a deliberate order, and the settled layout is readable. Test interruption and reverse navigation, the live reduced-motion preference change, and export. Distinguish a working time function from a visually successful result. See [browser verification](browser-verification.md).

These mechanisms apply the independently written [motion design guidance and sources](motion-direction.md); they do not require GSAP, Motion, or a particular easing family.
