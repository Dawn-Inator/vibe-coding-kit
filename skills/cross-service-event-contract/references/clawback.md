# Be cautious about "clawing back" an already-issued side effect

Before implementing an automatic reversal for an incorrectly-granted one-time benefit, check whether
your reversal mechanism can create *more* damage than the original bug. A reversal implemented as an
independent negative ledger entry (rather than a true deletion of the original grant, which is often
deliberately how these systems are built, to preserve an audit trail) combined with a "grant this
exactly once per actor" uniqueness constraint can mean: after a reversal, the actor's slot for that
one-time benefit is **permanently and irrecoverably consumed** — even a fully legitimate re-earn of
the same benefit later can never be granted again, with no administrative path to reissue it. Treat an
automatic clawback of an irreversible one-time grant as a product decision requiring its own explicit
sign-off, not a routine bugfix — and document the conditions under which it should be revisited (e.g.
if the benefit becomes redeemable for something of real value, or if abuse patterns are actually
observed), rather than silently deciding "never" forever.
