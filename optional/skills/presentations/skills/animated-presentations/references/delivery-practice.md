# Delivery Practice: composed motion example

Use this optional, Kit-authored custom direction for a speaker-led developer-team talk, explanatory workflow, handoff, or comparison where a strong claim and a large diagram can share the stage. It is a worked example, not the default for every deck, and not a replica of the upstream Bold Signal recipe. Inspect the [runnable HTML](../assets/examples/delivery-practice/index.html) and [full-deck preview](../assets/examples/delivery-practice/preview.png) together: the preview shows composition; playback and source show how meaning moves.

## Visual grammar

The example uses a 1280 × 720 fixed stage with roughly 76 px margins, a deep teal ground (`#142b30`), warm white (`#f4f3ea`), lime (`#d6e978`), and teal (`#087c72`). Clear, large claims often sit at left beside a larger focal panel. The cover's ring becomes a check; the four-step process is a clockwise 01–04 map with arrows and a travelling handoff; comparison pairs concrete implementation clues with observable behavior; a warm white document or lime panel carries the main content. Structure the focal objects and their relationships, rather than decorating otherwise empty space with hairlines. The palette alone does not reproduce the result. When adapting this example, retain its 1280 × 720 stage and matching scaling/export dimensions unless the new brief calls for a different canvas; the general architecture guide’s 1920 × 1080 default is for a new starter, not a replacement for this reference.

Each motion beat answers a content question: **meaning → scene geometry → progress mechanism**. The marker represents a handoff or inquiry, the paths show relationships, and the final state preserves the result for reading. Wrapper fades alone do not supply that explanation. Graphic motion is coordinated with readable text and quiet holds; these examples are starting points, not mandatory effects or durations.

## Scene map

Durations below describe the worked example's individual scene clocks, not universal timings or speaking times. At initial, middle and final states, preserve a legible structure and give the speaker time to explain; playback should never gate navigation.

| Scene key | Meaning → geometry → initial / middle / final |
| --- | --- |
| `cover` | Completion → title and ring/check → copy begins and arc is open / token traces ring / check resolves and holds. Example: 2.0 s. |
| `problem` | One request leaves questions → branching focal panel → probe starts at request / traces three branches in sequence / all questions remain highlighted. Example: 4.2 s. |
| `contract` | Intent becomes an inspectable agreement → white document with three slots → labels start outside / each enters its slot / readable document holds. Example: 4.6 s. |
| `process` | Each output becomes the next input → clockwise 01–04 map and arrows → marker starts at first station / travels through nodes / stations settle. Example: 4.8 s. |
| `roles` | Responsibility passes between people → three roles and links → roles start subdued / handoff moves across links / warning and full chain remain readable. Example: 4.6 s. |
| `comparison` | Code existence differs from behavior → three paired case objects → clues are visible / connections and behavior checks appear in order / all pairs hold. Example: 4.0 s. |
| `evidence` | Evidence is transferred to a delivery record → checklist, clear corridor and example rows → packets start at source / each follows its own guide / rows and example label remain readable. Example: 4.8 s. |
| `closing` | Next action is to define completion → ring and three empty checklist lines → ring begins / lines grow in sequence / action and unchecked items hold. Example: 3.6 s. |

Adjacent boundaries use radial, horizontal, vertical and split reveals. Incoming and outgoing slides remain opaque, the incoming scene begins during the boundary and continues without a blank frame or reset. The repeated ring connects opening and close; don't force it into unrelated scenes.

## Adapt to a different brief

1. Inspect the rendered preview **and** source and decide whether this direction fits. Outline the real content and focal meaning first; establish authorized scope before copying. Keep any explicit representative-page and user-confirmation milestones.
2. Select only scenes needed for that story. Replace all visible copy, labels, examples, numbering, accessibility labels and document metadata; do not let this example's domain imply facts about the new work. Preserve the composition grammar and meaningful renderers where they fit, rather than falling back to the unthemed starter or weakening the approved motion. Adapt or remove scenes that do not serve the story.
3. Rebuild geometry for the new content, measure longer CJK labels and check all intermediate positions, not only the settled page. The example uses system fonts; offline availability and glyph metrics vary by operating system. Its fixed-stage phone view remains small in portrait.

## Implementation contract

The runnable source identifies scenes with `section[data-scene]` keys `cover`, `problem`, `contract`, `process`, `roles`, `comparison`, `evidence`, and `closing`. Each named scene factory is scoped to its section and returns its own meaningful progress renderer. Present DOM order determines registration, count, durations and navigation clamps: remove unused sections or reorder them without maintaining a separate index remap. Do not initialize factories for absent sections. Inspect `coverScene`, `problemScene`, `contractScene`, `processScene`, `rolesScene`, `comparisonScene`, `evidenceScene`, and `closingScene` in the HTML for the corresponding mechanics.

The evidence scene measures actual source and target row centers and caches four normalized SVG paths and lengths outside the frame loop. Refresh geometry after fonts, content or row heights change, and preserve the clear corridor and endpoint spacing so paths and packets do not cross text. Call `proof.refreshGeometry()` after such changes; the example also refreshes on resize and after fonts are ready.

A single clock, cancellation and generation guard prevent stale callbacks from mutating the current scene. The proof interface supports `show(i)` (paused at zero), `seek(p)`, `play`, `pause`, `replay`, `goto` (actual navigation) and `getState()` (current, target, progress, duration, phase, total pages and scene key). `renderSlide(i, {exportMode:true})` explicitly paints the stable final state. Reduced motion, including a live preference change, stops the clock and paints that state; export cancels transient layers and remains stable. These are mechanisms to preserve when adapting, not a claim that a new deck has been verified.

## Check the adapted result

Watch actual playback and inspect `p = 0`, a middle value, and `p = 1` on every scene, including long labels and all pages. Check each boundary in both directions, rapid reversals, pause/seek/replay, live reduced-motion changes and export. Look for readability, clipping, text collisions, continuity and the intended meaning of each motion. A technical inspection or a read receipt is not an aesthetic certification; review the actual visual result with the user when their requested process calls for it. No frame-rate guarantee follows from this example.
