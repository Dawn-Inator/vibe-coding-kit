# Tracker write boundary: rationale

### Owner-level decision: AI must not add rows or mark them verified

A real incident that generalizes: an AI session found several new issues while comparing the
running app against a design spec, and created new tracker rows for them directly via the
underlying API client, growing the table. The developer required all of them deleted and the
frozen baseline restored, with zero residue. The reasoning: that table is the reporter's/tester's
**input**, and an AI adding entries to it pollutes someone else's data source; the terminal
"verified" status is specifically an acceptance judgment, and an AI self-certifying its own fix
would make re-testing meaningless. New problems an AI notices belong in the commit message, PR
description, or a handoff document — never in the tracker directly. To surface them to a human,
list them plainly in the final reply and let the developer decide whether to record them.
