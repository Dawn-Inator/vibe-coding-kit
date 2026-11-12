---
name: static-frontend-delivery
description: Use when designing, reviewing, or migrating static frontend publication through object storage and a CDN, including immutable assets, mutable entrypoints, rollback, cache policy, or provider retirement.
---

# Static frontend delivery

Apply the portable delivery contracts in [the kit guidance](../../guidance/static-frontend-delivery.md) when a project publishes static frontend artifacts.

- Classify each project, environment, surface, revision, purpose, and artifact lifecycle before defining keys or cache rules.
- Keep immutable public assets, revalidated public documents, private backend templates, private archives, and stable private live pointers distinct. Declare keys as slash-terminated directory prefixes or exact object keys, and distinguish viewer access from origin access.
- Require safe versioned object keys, disjoint artifact prefixes, explicit access and caching, declared retention and rollback windows, and one complete publication exclusion strategy: fenced ownership on every mutation or a durable non-expiring mutex held through host flip, pointer update, and garbage collection.
- Keep declared configuration separate from provider/runtime observation and owner acceptance. A validator or IaC plan is not runtime proof.
- Keep provider identifiers, credentials, regions, concrete domain/DNS values, and approval state in project-owned adapters and operational records.

The kit's `validateStaticFrontendDelivery` helper checks only the portable declaration contract. It does not publish, inspect cloud state, validate DNS, or prove that concurrency controls work in production.
