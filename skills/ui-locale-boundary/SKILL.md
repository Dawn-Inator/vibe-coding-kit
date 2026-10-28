---
name: ui-locale-boundary
description: Use before changing UI locale, translations, message catalogs, system-language mapping, language pickers, or error-message i18n in a product that also has a separate notion of "what language is this piece of content in." Enforces the UI-locale-versus-content-language axis split, one source of truth per independently-deployed runtime, and the type-level guardrails that keep them from drifting.
---

# UI Locale Boundary

Use this skill before planning or implementing any language-related change in a product that has (or
might grow) **two different kinds of "language"** in the same codebase. This is a worked, complete
pattern — adapt the concrete field/type names to your own project, but keep the structural rules,
which generalize past any specific product.

## Classify the axis first — this is the single most common mistake

Many products have **two semantically different language concepts that look alike but are not the
same axis**:

| | **UI locale axis** | **Content language axis** |
| --- | --- | --- |
| Meaning | what language the interface itself is displayed in | what language a piece of user-generated or catalog content actually is in |
| Who decides | the viewer (settings, system language, region fallback) | the author, at creation time |
| Typical defaults | tied to the viewer's own locale/region | independent — can even be the *opposite* of the UI locale by design (e.g. a language-learning product where the interface is in your native language but the content you consume is in the language you're learning) |

Confusing the two is the single most damaging category of mistake in this area: "add a UI language"
silently implemented against the content-language axis quietly becomes "add a content language" —
a completely different, much larger product decision (it usually implies needing a content corpus,
translation/ASR pipeline, and moderation capacity for that language, none of which "add a menu
language" requires). Before touching any code, explicitly say out loud which axis a request is on. If
a request seems to touch both, stop and split it into two separate pieces of work — a content-language
change is a product decision, not a refactor of the UI-locale code.

If your product's two axes have **non-obvious, even inverted default relationships** (as in the
language-learning example above), that inversion is very likely *correct*, not a bug — resist the
urge to "align" them just because two numbers looking different feels wrong. Confirm which axis you're
looking at before "fixing" anything that looks inconsistent across the two.

## One source of truth per independently-deployed runtime, not one per repository

If your product ships more than one independently built/deployed runtime (e.g. a mobile app, a web
app, and a backend service, each with their own build and deploy pipeline), **"single source of
truth" means one locale list per runtime, not one shared list for the whole repository.** Each
runtime keeps its own authoritative, hand-written list of supported UI locales; everything else in
that runtime derives from it (message-catalog file discovery, a system-language-to-locale mapping,
picker UI, etc.).

This is not a contradiction of "avoid duplication" — the duplication being eliminated is **multiple
competing representations of the same concept inside one runtime** (a real historical failure mode:
one project ended up with four independent, non-derived representations of its own UI-locale set
inside a single mobile app, none of which stayed in sync with the others). The three (or however many)
runtimes are *deliberately* independent, not accidentally duplicated — they build and deploy
separately and share no running process, so keeping their locale lists textually identical is a
**cross-runtime consistency requirement you must actively maintain** (a checklist, not automatic),
not something to solve by trying to import one runtime's locale list into another.

## A derived array is not a guardrail; a keyed record type is

This is the sharpest, most reusable lesson in this pattern. Given a hand-written source list (e.g.
`const LOCALES = ['en', 'zh'] as const`), a naive downstream consumer often does something like:

```ts
const OPTIONS = LOCALES.map(toPickerOption); // looks derived, looks safe
```

**This "derivation" provides zero compile-time protection when a new item is added to `LOCALES`.**
The map just runs over one more element at runtime; nothing about adding a locale forces a human to
visit every place that needs a per-locale decision (what does this locale's option look like in the
picker? what does this locale's fallback error message say? which system-language codes map to it?).
The new locale can silently vanish from a picker, or silently render `undefined`, with zero type
errors and zero test failures — a **false sense of safety that is worse than no derivation at all**,
because a plain hardcoded list would at least be obviously incomplete.

The actual guardrail is a **fully-keyed record type**:

```ts
type LocaleMeta = { nativeName: string; /* ... */ };
const LOCALE_META: Record<Locale, LocaleMeta> = {
  en: { nativeName: 'English' },
  zh: { nativeName: '简体中文' },
  // adding a new Locale member here makes this object literal fail to typecheck
  // until you add its entry — that's the point
};
```

Adding a member to the source union/list makes every `Record<Locale, X>` in the codebase fail to
compile until a human supplies that new member's entry — this is what actually forces every "does
this new locale need a decision here" question to surface at compile time instead of at runtime, in
production, for one specific user.

**Never weaken one of these records to `Partial<Record<Locale, X>>`** or add an index signature to
"fix" a compile error from an incomplete map — that silently disables the exact guardrail the type
exists to provide. If you're tempted to do this, the real fix is almost always "go fill in the missing
entry," not "make the type stop complaining."

One more concrete pattern worth keeping: when a `Record<Locale, X[]>` maps *from* your locale *to* a
set of external identifiers (e.g. which raw system-language tags should be treated as this locale),
keep the direction that way round, not inverted (`Record<string, Locale>` mapping external tag →
locale). Only the `Record<Locale, X[]>` direction gets a compile error when you add a locale; the
inverted direction lets a new locale slip in with zero external-tag mappings and no error at all.

## Cross-package mirrors need an explicit compile-time assertion, not just discipline

If two packages each need their own copy of the same locale union (common when a dependency
direction prevents one from importing the other — e.g. a shared types package that the app depends on,
but that can't depend back on the app), don't rely on "remember to update both" as the sync
mechanism. Add a compile-time mutual-assignability assertion between the two types:

```ts
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type LocaleUnionsStayInSync = Assert<MutuallyAssignable<LocaleA, LocaleB>>;
```

This kind of type-only declaration compiles away to nothing (zero runtime/bundle cost) — don't delete
it because it "does nothing at runtime." Its entire job is to turn "someone added a locale to one
package's union and forgot the other" into an immediate compile error instead of a runtime `undefined`
discovered by an actual user of the newly-added locale.

## Locale does not belong in a URL that is also an external contract

If locale-aware routing is implemented via a URL-path locale segment (a common SSR i18n framework
default), check first whether any of your URLs are **externally referenced contracts** — deep links,
email-embedded links, OAuth/SSO callback URLs already registered in a third-party console's allowlist.
If so, adding a locale segment to those URLs is not a cosmetic routing choice — it silently breaks
every already-issued link and every already-registered callback allowlist entry. Keep locale
resolution out of the URL for any surface with pre-existing external references (resolve it from a
cookie, an `Accept-Language` header, or a build-time regional default instead), and add a static
test asserting the routing layer doesn't grow a locale path segment, so this can't regress silently
when someone later adopts a framework's "just enable the i18n routing middleware" default.

Also don't forget the page-level locale declaration itself (`<html lang>` or equivalent) — it isn't
only cosmetic metadata for search crawlers. Screen readers choose pronunciation from it, and browsers
use it to choose line-breaking rules and CJK font fallback. A hardcoded literal there quietly means
every build serves one language's reading rules to every locale.

## Database-column width is not the same contract as the column's CHECK constraint

If UI-locale or content-language codes are persisted, check the actual `CHECK` constraint on that
column, not just its declared width. A column declared wide enough for a full BCP-47 tag (e.g.
`VARCHAR(35)`, sized for something like `zh-Hans-CN`) can still carry a narrow regex constraint (e.g.
`^[a-z]{2}$`) that silently rejects anything longer than a bare two-letter code. The column width
advertises one intention; the constraint enforces a different, stricter one — trust the constraint,
and verify it explicitly before assuming a richer locale tag format will fit.

## Error-message localization needs an explicit safety boundary, not one universal fallback chain

If your product classifies API/error responses into a small set of message keys, split them
deliberately into two families instead of one universal `curated translation ?? raw backend message`
fallback chain:

- **A small set of well-known, hand-curated keys** with an explicit per-locale translation table.
  These never fall through to a raw upstream/backend message string.
- **A larger set of narrower keys** (typically routine validation/permission errors) that can
  reasonably fall back to a raw backend message when no curated translation exists yet.

The reason this must be a deliberate two-way split, not one fallback chain that "just tries the
curated table, then falls back": a single chain conflates two different failure reasons — "this
locale isn't registered" and "this specific error code has no curated translation yet" — into the
same fallback branch, so a locale-normalization bug can silently start leaking a raw internal/upstream
error message (which can contain a third-party provider's own internal wording) directly to an
end user, in whatever language the backend happened to respond in. Require curated translations for
your highest-severity error class (typically 5xx / internal-failure codes) specifically, since those
are the ones most likely to carry provider-internal detail, and enforce that requirement with a test
that fails when a new severe error code ships without one.

## Gate the parity, and gate against re-introducing a language bifurcation

At minimum, keep an automated check that a runtime's locale list and its message-catalog files stay
in exact bidirectional parity (every locale has a catalog file; no catalog file exists for a locale
that isn't in the list) — and pin the *expected* locale set as a literal snapshot in that test, not
derived from the same source it's checking. A parity assertion that derives both sides from the same
source is a tautology (self-comparison, always green, carries zero information); the value of the
snapshot is that a human must consciously update it, which is the forcing function that makes them
also complete the rest of the "add a locale" checklist.

If your codebase has ever had an ad hoc `isCurrentLocaleZh ? optionA : optionB`-style boolean
bifurcation on the UI-locale axis, add (and keep) a static check that forbids reintroducing that
pattern — it's the single easiest way for someone under time pressure to bypass the catalog/`t()`
mechanism "just this once," and every instance silently reopens the same class of bug the catalog
mechanism exists to prevent.

## Gate the message keys too, in both directions

Locale parity (above) covers the locale set, not the catalog contents. Also gate: referenced-but-missing
keys (fail), present-but-unreferenced keys (fail or advisory with a planned-key registry), per-locale
key-set parity, and dynamic key concatenation (static map or registered prefix). Details, scanner
caveats, and React (i18next / next-intl) vs uniapp (vue-i18n) notes:
[references/i18n-key-governance.md](references/i18n-key-governance.md).

## Record irreversible or judgment-call product decisions once, in the doc, not per-conversation

See [references/product-decisions.md](references/product-decisions.md).
