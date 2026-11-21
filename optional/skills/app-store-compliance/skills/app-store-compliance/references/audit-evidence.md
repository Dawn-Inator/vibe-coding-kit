# Review areas and evidence

Select areas by app behavior and the requested review. These are inspection routes, not a frozen policy database. Open the relevant official page and check its current wording and applicability before classifying an issue.

## Apple sources

- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/): use the current numbered section for the specific feature or rejection.
- [Submitting for review](https://developer.apple.com/app-store/submitting/): submission preparation and reviewer access.
- [App privacy details](https://developer.apple.com/app-store/app-privacy-details/): declarations, including third-party SDK behavior.
- [Privacy manifest files](https://developer.apple.com/documentation/bundleresources/privacy_manifest_files) and [third-party SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/): inspect the built app and SDK versions as well as source configuration.
- [Offering account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/): trace the complete deletion path when account creation is available.
- [Upcoming requirements](https://developer.apple.com/news/upcoming-requirements/): verify dates against the actual submission date.

## Google Play sources

- [Developer Policy Center](https://play.google.com/about/developer-content-policy/): locate the current policy for the app's feature and distribution region.
- [Prepare your app for review](https://support.google.com/googleplay/android-developer/answer/9859455): app access, content declarations, audience, and other console requirements.
- [Data safety](https://support.google.com/googleplay/android-developer/answer/10787469): compare declarations with the app and all SDK data flows.
- [Account deletion](https://support.google.com/googleplay/android-developer/answer/13327111): inspect both app and web paths where applicable.
- [Target API requirements](https://support.google.com/googleplay/android-developer/answer/11926878): verify current dates, app type, and submission conditions.

## Evidence to collect

- **Reviewer access and completeness:** release backend, working reviewer path, necessary account access, functional screens, and submitted build identity. Source code cannot confirm a live account or backend throughout review; record what was actually checked.
- **Privacy and SDKs:** enumerate data collected, recipient, purpose, retention, consent, and deletion. Compare runtime behavior with privacy policy and store declarations. Investigate personal data transfer to third parties, including AI providers, using the applicable policy. An AI feature or a public-text translation request alone does not establish a personal data transfer or a required disclosure format.
- **Permissions and manifests:** compare requested permissions and purpose strings with actual feature use; inspect release manifests, required-reason API usage, SDK inventory, and packaged privacy resources. Missing generated native folders or build artifacts limit coverage. Do not run prebuild or generate native projects solely for an audit without authorization for that change.
- **Accounts and deletion:** trace discoverability, reauthentication, backend deletion, associated data, third-party identity handling, and any retained records. A deletion button or sign-out alone is insufficient evidence that the flow completes.
- **Payments and subscriptions:** follow the purchased entitlement and payment path, restore behavior, disclosures, and cancellation information. Check storefront, app category, entitlement, and current regional rules before asserting that an external link or payment method is disallowed.
- **Listing and review materials:** compare each relevant locale's screenshots, descriptions, pricing, URLs, review notes, and declared features with the actual build. Separate local metadata from the live console version. Do not infer a false listing solely from a keyword.
- **Audience and content:** assess applicable age ratings, children, user-generated content, moderation, health, financial, or other category-specific rules. Explain why a category applies before adding obligations.
- **Account and regional readiness:** use existing authorized console access or user-provided evidence for agreements, verification, testing eligibility, export answers, and distribution settings. Unknown console state stays unknown. Verify jurisdiction-specific legal questions with current primary sources and keep them separate from confirmed store-policy violations.

## Evidence limits

A source-only audit does not establish runtime compliance, a working deletion endpoint, the accuracy of live console forms, or approval probability. A successful upload is also distinct from review approval. Give a useful fix plan from the evidence available and state the remaining verification precisely.
