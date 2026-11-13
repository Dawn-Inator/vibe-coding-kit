# Motion direction and implementation

Read when designing or debugging an animated web deck. These are options, not a requirement to use every effect.

## Design the beats

Make a small per-boundary motion map before implementing: outgoing/incoming scene, visual idea, moving shared element (if any), and the first content reveal. Use motion to explain continuity, comparison, sequence, or focus. For example, a ring can lead into a timer, a line can assemble into a workflow, and opposing panels can introduce a comparison. A requested set of seven or eight distinct transitions needs visibly distinct motion, not eight names for the same crossfade. Keep a coherent palette and quiet moments so effects do not overwhelm the talk.

A transition may combine an outgoing state, a temporary graphic layer, the incoming layout, and staged content. Use a single coordinated timeline where sequencing is complex; overlap the beats deliberately. Let the presenter control meaningful content reveals independently of page transitions. In diagrams, connect the highlight, label, and progress marker to the same step state. On backwards navigation restore the correct previous state and support replay.

Possible techniques include directional reveal, diagonal ribbon, radial expansion, staggered panels, line drawing, shared-element movement (measure first and last positions), a small particle burst, or an orbit. Pick mechanisms appropriate to the material and device. Avoid full-screen flashing, persistent sparkle, or excessive motion unless specifically requested. Keep text readable once motion settles.

## Implementation choices

- CSS animations and transitions are enough for simple reveals. Use Web Animations or a timeline library such as GSAP for coordinated, interruptible sequences. Choose based on the existing stack and delivery requirements, not novelty.
- Give the incoming and outgoing slide explicit visibility and stacking states. Hide inactive slides from keyboard focus and the accessibility tree (`inert` and appropriate ARIA where supported); keep the active slide interactive.
- When navigation interrupts a transition, finish or cancel the old sequence deterministically, remove temporary nodes, restore inline styles, then start the next state. Test rapid next/previous, not only slow forward playback. Avoid duplicating IDs when cloning shared elements.
- Keep overlay layers `pointer-events: none`, bounded to the stage and removed when done. Avoid animating layout properties each frame; prefer `transform` and `opacity`. Measure geometry before animation, and only promote layers for the duration of a transition. Profile if the result appears janky; do not promise 60 fps without measurement.
- Use SVG stroke-dashoffset for line drawing, CSS/SVG or an animation library for icons, and Lottie only when a suitable asset and player are available. For scroll-driven stories, use a scroll timeline appropriate to the framework and clean up listeners. Avoid turning a slide deck into scroll-jacking unless the user wants it.
- Honor `prefers-reduced-motion: reduce`: remove large translations, rotation, zoom and particle bursts; use a brief crossfade or immediate change and preserve all content, controls and progress. Do not hide essential content behind an animation.
- If external libraries, fonts or generated media are included, respect their licenses and make dependencies explicit. Self-contained/offline delivery means the dependencies really are bundled, not merely loaded from a CDN. Avoid copying whole upstream skills into the deliverable.

Inspiration: [Frontend Slides](https://github.com/zarazhangrui/frontend-slides) and [web-animation-skills](https://github.com/iart-ai/web-animation-skills). This reference is a focused integration, not a bundled copy of either upstream package.
