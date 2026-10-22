---
name: domain-boundary
description: Use when adding or changing this project's domains, subdomains, URLs, OAuth callbacks, Supabase (or equivalent) redirect URLs, deep links, universal links, email sender domains, CDN/DNS settings, hosting-provider aliases, reverse-proxy public domains, CSP connect-src, app-local custom schemes, or any hardcoded product/company domain literal. Enforces product-vs-company domain ownership.
---

# Domain Boundary

Use this skill before changing user-facing domains, callbacks, deep links, DNS/CDN records, email
sender domains, or CSP allowlists. Keep the full domain table and historical exceptions in your own
domain-boundary Doc (a reasonable name is `doc/domain-boundary.md`) — this Skill only owns the rule and
the decision tree below.

This skill assumes your project owns (or plans to own) two separate domains: one for the product itself
and one for the company/organization behind it. If your project only has a single domain for everything,
most of this still applies — just collapse "product domain" and "company domain" into the same value and
keep the "don't use raw provider URLs as product entries" rule, which matters regardless of how many
domains you have.

## Hard Rule

- Use the **product domain** (e.g. `*.<product>.example.com`) for every user-facing product asset: API
  endpoints, frontend domains, mobile preview builds, CDN, product email, OAuth callbacks, auth-provider
  redirect URLs (Supabase, Auth0, Firebase Auth, ...), deep links, universal links, smoke-check URLs, and
  any other public service link a user, app, or third party actually reaches.
- Use the **company domain** (e.g. `*@<company>.example.com`) only for company identity and
  internal/company email — employee addresses, external correspondence, contracts.
- Do not use the company domain, raw hosting-provider deployment URLs (e.g. a Vercel/Netlify-assigned
  preview hostname), raw cloud-database/object-storage endpoints (e.g. an RDS/OSS/S3 default endpoint),
  or any other temporary/generated host as a product callback or user-facing product entry.
- Repository names, GitHub/GitLab org names, hosting-platform team names, and identity strings (commit
  authors, DB/service passwords, CI account names, ...) that happen to contain the company or product
  name **do not change the domain rule**. These are separate, unrelated concerns (permissions, secret
  rotation, org renaming) — don't let a name match in one of them talk you into putting something on the
  wrong domain, and don't let "but the repo/org is already named `<company>`" become a justification for
  routing a user-facing asset to the company domain.

## Decision

- If a URL is visited by users, mobile clients, OAuth providers, an auth backend (Supabase Auth or
  equivalent), product email recipients, app links, public smoke checks, or CDN consumers — keep it in
  the product domain family.
- If a URL or address is only for company email/contact identity, use the company domain.
- If the change only touches native shell colors, local build aliases, dev indicators, route internals,
  or record-only migration metadata, do not create or rename domains as part of that change. These are
  the recurring false positives: a file that legitimately needs editing for an unrelated reason (a dev
  server cache flag, a splash-screen color, a package-resolution alias) happens to sit in a file that
  *also* carries domain configuration elsewhere, and it's tempting to "clean up" the domain literal while
  you're in there. Don't — touch only what the actual change requires, and if a domain-ownership gate
  flags the file anyway because it can't tell the two apart from a diff alone, resolve that by confirming
  and recording that the change was domain-inert, not by loosening the gate.

## Required Checks

- For OAuth, auth-provider redirect URLs, universal links, and app links: update the actual
  allowlist/IaC or runtime config source, not just a comment or doc note.
- For web/admin/mobile CSP changes: only add sources that already satisfy this boundary, or are approved
  third-party service origins (e.g. your cloud provider's service domains, a payment provider's webhook
  origin) — never add a source just because it's convenient to unblock a build.
- For deploy-workflow smoke URLs: distinguish "the raw deployment is alive" from "the product domain
  itself passed acceptance." A 200 on a provider's raw preview URL is not the same claim as a 200 on
  `app.<product>.example.com`, and CI green on the former must not be reported as the latter.
- For DNS/CDN operations: use your project's secret-management access path; never write AK/SK, API keys,
  or other credential values into docs or skills — not even redacted-looking fragments.

## Verification

Before editing, search the codebase for every hardcoded domain literal and confirm each hit sits on the
correct side of the product/company boundary (adapt the pattern to your actual domains and the
callback/redirect/deep-link keywords your project uses):

```bash
rg -n "<company-domain>|<product-domain>|<hosting-provider>\.app|callback|redirect|deeplink|universal|assetlinks|apple-app-site-association" <changed-area>
```

If your project has a docs-impact check or a CI gate for domain/deployment-config files, wire this rule
into it too — a rule that only lives in a skill file is easy to bypass by accident in a large diff.

## Related Sources

Point these at your own project's docs once you've written them, e.g.:

- `doc/domain-boundary.md` — full domain table, per-environment subdomain ownership, and historical
  exceptions/false-positive registry.
- `doc/deployment-architecture.md` — how each domain maps to infrastructure (load balancer, reverse
  proxy, hosting provider).
- `doc/env-mapping.md` — which domain set belongs to which deploy environment (dev/staging/prod).
