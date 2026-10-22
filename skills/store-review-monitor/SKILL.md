---
name: store-review-monitor
description: "Use when checking, waiting on or monitoring the review of an iOS App Store / TestFlight or Google Play submission — 'where is the review', 'did it pass', 'was it rejected', 'monitor the store listing', 'external TestFlight review'. Read-only status of both stores through one snapshot script; never submits, resubmits, withdraws or releases."
---

# Store Review Monitor

Use this skill from the moment a build has been submitted for store review until it is approved or rejected. It is strictly read-only observation: submitting, resubmitting, rolling out and releasing belong to the packaging and release flow (see `mobile-app-build`), not here.

## What your project must provide

A one-shot, read-only snapshot script that queries the App Store Connect API and the Google Play Developer API (GET requests only; never create a Play edit, never call a mutating endpoint) and prints one table row per submission item with:

- the **phase** (table below), the raw store state next to it, and an identifier that lets you find the item in the store console (for example the numeric app id);
- exit code `0` when nothing needs action (items may still be queued), a distinct non-zero code when some row is `needs_action`, and another when a store could not be read.

Keep the store credentials in your own secret store and hand them to the script only for the lifetime of the process; do not paste a key into a command line or a chat. If a credential cannot be read, report which one is missing and stop. Do not invent a fallback carrier for it. The script, its phase mapping and a test for that mapping live in your project; this skill only fixes the method.

Phase model the script should print:

| Phase | Meaning | Next step |
| --- | --- | --- |
| `preparing` | metadata incomplete or not submitted yet | not under review; confirm it is meant to be this way |
| `queued` | submitted, waiting for a reviewer | wait |
| `in_review` | being reviewed | wait |
| `approved` | passed, waiting to be released or processed | the owner decides when to release |
| `live` | released or in testing | nothing |
| `needs_action` | rejected, unresolved issue, removed, or build processing failed | fetch the reason, report it (steps below) |
| `superseded` | replaced by a newer version or expired | ignore |
| `unknown` | a raw state the mapping does not know | never a green light (steps below) |

One submission fans out into several rows (the version, the review submission, every in-app purchase or subscription). Any single `needs_action` row can block the whole submission, so never read only the version row.

## Steps

1. **Snapshot once.** Run the script a single time (one store only if only one was asked about). Read the table by phase, not by store: `needs_action` and `unknown` first, then `queued` / `in_review`.
2. **Report the snapshot** in one short block: what is waiting, what changed since the last report, what needs the owner. A row in `preparing` is not under review, so do not describe it as waiting.
3. **Watch mode, only if the owner wants to be told when something moves** and at least one row is `queued` or `in_review`. Run the script's watch form as a tracked background task whose output lines wake the session; print only on a state change, and exit when nothing is queued or in review any more. Do not poll with a short repeated wake-up. A wait longer than 2 hours also follows the heartbeat rule in `agent-task-supervision`; the watch is only a delivery mechanism, it does not replace the heartbeat status line.
4. **On `needs_action`**, fetch the rejection reason read-only (browser section below), then hand the owner the verbatim reason, the clause or policy it cites, and a proposed fix, and stop. Resubmitting, removing from review, cancelling a submission, changing a declaration, rolling out and promoting are the owner's call every time. A decision the owner has already registered ("wait for the review result before changing X") is executed by its recorded trigger, not asked again.
5. **On `unknown`**, print the raw state, check it against the store's current API documentation, and add it to the script's mapping together with a test. Never treat `unknown` as approved.

## Read-only browser checks

The store APIs expose a state but not the reason. Use a browser only when a row is `needs_action`, when the owner asks what the console says, or when the API cannot show what is wanted (rejection text, policy status, reviewer messages).

- The store consoles are usually signed in only in the owner's own browser profile. Say why you need it in one line and get the owner's yes before the first page of a turn. Open your own tab; never reuse or navigate one of the owner's.
- Never type a password, sign in, or approve a two-factor prompt. If a page shows a login wall, stop and tell the owner which console needs signing in.
- Read the page text; take a screenshot only when the text is missing or ambiguous. Both consoles are slow single-page apps, so allow several seconds before reading.
- Click only links and tabs that change what is displayed. Every button that saves, submits, sends, removes or cancels is off limits.

Where to look:

- **App Store Connect**: the app's version page (review state and the Remove-from-Review button, which you must not press); the review submissions page, newest submission, for the Resolution Center messages with the guideline number and the reviewer's text; the in-app purchase and subscription pages, because a rejected one blocks the submission. The notification email carries the same text.
- **Google Play Console**: the publishing overview ("in review", "changes sent", "rejected" banners); the production track for release status and any rejection notice; the policy status page, which stays empty during review and only fills after a review finishes; the app content declarations (advertising ID, data safety, reviewer login credentials).

Quote the reviewer text or banner verbatim and say which page it came from.

## Stop conditions

- A store credential cannot be read: report the missing credential or policy; add no new role, carrier or static fallback.
- The script reports a read error twice in a row for the same store: report the store, the HTTP status and what was tried; do not loop.
- Anything that would change store state: stop and ask the owner.

## Verification

Run the project's own test file for the phase mapping, including a case for an unmapped raw state landing in `unknown`.
