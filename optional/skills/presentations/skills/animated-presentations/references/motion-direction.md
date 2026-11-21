# Motion direction and implementation

Read when designing or debugging an animated web deck. These are options, not a requirement to use every effect.

## Design the beats

Make a small per-boundary motion map before implementing: outgoing/incoming scene, visual idea, moving shared element (if any), and the first content reveal. Use motion to explain continuity, comparison, sequence, or focus. For example, a ring can lead into a timer, a line can assemble into a workflow, and opposing panels can introduce a comparison. A requested set of seven or eight distinct transitions needs visibly distinct motion, not eight names for the same crossfade. Keep a coherent palette and quiet moments so effects do not overwhelm the talk.

When animated page transitions are requested, implement an actual outgoing/incoming sequence or shared-graphic continuity across the boundary; a hard cut followed only by an internal underline is not that transition.

A transition may combine an outgoing state, a temporary graphic layer, the incoming layout, and staged content. Use a single coordinated timeline where sequencing is complex; overlap the beats deliberately. Let the presenter control meaningful content reveals independently of page transitions. For new live talks, default to →/Space for a semantic step, ← for the previous stable step, and Page Down/Page Up for direct page changes. In diagrams, connect the highlight, label, and progress marker to the same step state. On backwards navigation restore the correct previous state and support replay. Preserve an existing deck's operating model unless a change is requested.

Possible techniques include directional reveal, diagonal ribbon, radial expansion, staggered panels, line drawing, shared-element movement (measure first and last positions), a small particle burst, or an orbit. Pick mechanisms appropriate to the material and device. Avoid full-screen flashing, persistent sparkle, or excessive motion unless specifically requested. Keep text readable once motion settles.

## Shape the rhythm

Keep a small shared vocabulary of motion, with a clear focal element per beat. Reserve more expressive movement for a meaningful opening, explanation, change of state, or close; give the audience quiet time to read. Do not replace choreography with many unrelated loops, or with the same entrance on every card. Visual continuity can come from a repeated shape or line that changes role, not just a shared palette.

Compose rhythm across pages as well as within one page. A chapter can retain a title anchor or shared stage while replacing the body with a subject-specific object, an explanatory process, or a large real image. Reserve stronger camera travel and scale changes for meaningful boundaries; calm the environment around material people need to inspect. Review a continuous 3–5-page passage when scope permits, rather than judging the whole talk from three unrelated screenshots. The optional [Deep Space Theatre](deep-space-theatre.md) demonstrates this approach with a reusable celestial theme; the same method also serves other themes.

Choose easing for the action: an entrance can decelerate into place, an exit can accelerate away, and a visible object changing state needs continuity. Use stagger to express reading order or a causal handoff; overlap related movements enough to feel composed rather than like a queue. Durations depend on distance, scale, hierarchy, and presenter pacing. Small spatial or opacity changes must still be perceptible at the final displayed size. Full-motion and reduced-motion modes should be authored separately.

For time-function scenes, read [function animation](function-animation.md). Use progress to coordinate the graphic, labels, and emphasis, not just to animate the opacity of a wrapper. A scene with a different meaning may need different geometry and timing, even while it shares the deck's easing and visual language. For a motion-led brief, design motion of the main explanatory graphic or relationship, not only decorative rules, borders, or underlines. Distinct scene meanings should have distinct visual beats: changing structure, grouping, handoff, convergence, emphasis, or resolution as appropriate. A custom renderer that merely stretches the same line on several pages is not sufficient evidence of choreography. There is no required effect count and no universal bounce or fixed delay for every slide.

## Implementation choices

- CSS animations and transitions are enough for simple reveals. Use Web Animations or a timeline library such as GSAP for coordinated, interruptible sequences. Choose based on the existing stack and delivery requirements, not novelty.
- Give the incoming and outgoing slide explicit visibility and stacking states. Hide inactive slides from keyboard focus and the accessibility tree (`inert` and appropriate ARIA where supported); keep the active slide interactive.
- When navigation interrupts a transition, finish or cancel the old sequence deterministically, remove temporary nodes, restore inline styles, then start the next state. Test rapid next/previous, not only slow forward playback. Avoid duplicating IDs when cloning shared elements.
- Keep semantic state, finite beats, and ambient movement distinct, with one owner for pause, cancellation and export. Returning to a step paints its stable result; a new forward trigger can replay the next beat. A theme renderer consumes time and scene parameters without owning navigation or starting a second untracked clock.
- Keep overlay layers `pointer-events: none`, bounded to the stage and removed when done. Avoid animating layout properties each frame; prefer `transform` and `opacity`. Measure geometry before animation, and only promote layers for the duration of a transition. Profile if the result appears janky; do not promise 60 fps without measurement.
- Use SVG stroke-dashoffset for line drawing, CSS/SVG or an animation library for icons, and Lottie only when a suitable asset and player are available. For scroll-driven stories, use a scroll timeline appropriate to the framework and clean up listeners. Avoid turning a slide deck into scroll-jacking unless the user wants it.
- Honor `prefers-reduced-motion: reduce`: remove large translations, rotation, zoom and particle bursts; use a brief crossfade or immediate change and preserve all content, controls and progress. Do not hide essential content behind an animation.
- If external libraries, fonts or generated media are included, respect their licenses and make dependencies explicit. Self-contained/offline delivery means the dependencies really are bundled, not merely loaded from a CDN. Avoid copying whole upstream skills into the deliverable.

Keep the final layout as the source of truth. If motion uses a text mask, transport copy, or transformed image layer, measure the authored layout and remove only the temporary layer at completion. Check the last animated frame against the first cleaned-up frame so cleanup does not alter kerning, line breaks or geometry. For WebGL scenes, provide a compositionally useful stable fallback and inspect it rather than assuming a blank canvas is acceptable.

Inspiration: [Frontend Slides](https://github.com/zarazhangrui/frontend-slides) and [web-animation-skills](https://github.com/iart-ai/web-animation-skills). This reference is a focused integration, not a bundled copy of either upstream package.


## Primary-source design references

Consulted 2026-11-20; these are inspiration and API references, not dependencies or universal slide specifications. The presentation-specific applications above are Kit guidance.

- [Carbon motion](https://www.carbondesignsystem.com/building-blocks/foundations/motion/overview): separates functional and expressive moments, distinguishes easing by action, and relates timing to movement distance and scale.
- [GSAP easing](https://gsap.com/docs/v3/Eases/): a visual reference for how easing changes the character of movement. Use its concepts without importing GSAP when native code fits the deliverable.
- [Motion timeline sequences](https://motion.dev/docs/timeline-sequences): shows coordinated segments, overlap, and a controllable timeline. The same orchestration can be implemented in native JavaScript.
- [Material motion](https://m3.material.io/styles/motion): distinguishes expressive and standard physics schemes and spatial/effect behavior. A spring is an option for suitable graphic motion, not a rule that every slide or text label should bounce.
