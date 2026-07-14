# Employer Live-Opportunity Feed Registry

**Status:** `LIVE`, one entry enabled (Dun & Bradstreet). The registry mechanism itself is generic; adding a second employer requires its own separately validated, documented, and tested registry entry — see "Adding a future source" below.
**Registry file:** `live-opportunity-sources.js`
**Consumer:** `app.js` (`getLiveOpportunitySource`, `fetchLiveOpportunities`, `renderLiveOpportunitySection`, and the `liveOpportunity*HTML` rendering functions)
**Related:** `docs/integrations/dnb-lever-poc.md`, `docs/decisions/ADR-003-dnb-lever-job-poc.md`, `docs/features/opportunities.md`

## Purpose

Earlier, the Dun & Bradstreet live Lever feed was wired directly into `app.js` with D&B-specific constants and function names (`DNB_EMPLOYER_NAME`, `dnbLeverSectionHTML()`, etc.). That worked for one employer but did not generalize: adding a second live-feed employer would have meant copy-pasting the entire D&B code path and renaming it.

`live-opportunity-sources.js` extracts the *configuration* for a live feed — which employer, which provider, which endpoint, what label to show — into a small, browser-visible, frozen registry. `app.js` now contains generic functions that read a registry entry and render a live-feed section for whichever employer that entry describes. Dun & Bradstreet's behavior is unchanged; it is simply the registry's one enabled entry today.

This registry is a **frontend matching and configuration list only**. It does not create, validate, deploy, or secure an API endpoint — see "What a registry entry is not" below.

## Registry fields

Each entry in `window.LIVE_OPPORTUNITY_SOURCES` is a frozen object with:

| Field | Type | Meaning |
|---|---|---|
| `employerId` | number | The stable `id` of the matching record in the `employers` array in `data.js`. This is the only field used for matching — never the employer's display name. |
| `employerName` | string | Human-readable label, used only for documentation/debugging clarity in the registry itself. Rendering code reads the employer's live `name` from `data.js`, not this field. |
| `provider` | string | The upstream ATS/job-board type this endpoint talks to (e.g. `"lever"`). Informational today; not branched on by `app.js`, since the endpoint already returns a normalized shape. |
| `endpoint` | string | The WorkJax API path to call for this employer's live feed (e.g. `/api/dnb-lever-jobs`). Always a same-origin path under `/api/`, never an external URL supplied at runtime. |
| `sourceLabel` | string | The badge text shown on each live result card (e.g. `"Live from employer"`). |
| `enabled` | boolean | Whether this entry may currently be used. A disabled or missing entry means no live feed renders and no request is made for that employer. |

The registry array and every entry object are wrapped in `Object.freeze()` so the configuration cannot be mutated at runtime by other script code.

## Stable employer-ID matching

`getLiveOpportunitySource(employer)` in `app.js` matches by comparing `entry.employerId === employer.id`. Employer display names can change (rebranding, typo fixes) without breaking the feed association, and two employers can never accidentally collide on name text. Matching by name was explicitly avoided.

## Provider and endpoint configuration

`provider` documents which kind of upstream feed the endpoint wraps. `endpoint` is the only value actually used to make a request — it is passed straight to `fetch()` and must always be a same-origin WorkJax API path implemented as its own Vercel Function (see `api/dnb-lever-jobs.js` for the current example). The registry never carries a raw third-party URL, API key, or upstream site token — those stay server-side inside the endpoint's own implementation.

## Browser-session caching

`app.js` keeps a single `Map`, `liveOpportunityCache`, keyed by `source.endpoint`. A successful response (`{ source, employer, generatedAt, count, jobs }`) is stored the first time it is fetched. Reopening the same employer's detail page later in the same browser tab reads from this Map instead of calling the endpoint again. The Map is an in-memory JavaScript variable — it is never written to `localStorage` or any other persistent storage, so it resets on a full page reload. This matches the caching behavior the original D&B-only implementation already had.

## Concurrent-request deduplication

A second `Map`, `liveOpportunityRequests`, keyed the same way by `source.endpoint`, holds the in-flight `fetch` promise while a request is outstanding. If the same employer's detail page is somehow opened twice in quick succession (or a render is triggered twice) before the first request resolves, the second call reuses the same pending promise instead of issuing a second network request. The entry is removed from `liveOpportunityRequests` once the request settles, regardless of success or failure.

Only a **successful** response is written to `liveOpportunityCache`. A failed request is never cached, so the next time that employer's detail page opens, the fetch is retried.

## Loading, empty, and error behavior

- **Loading:** `liveOpportunityLoadingHTML(employer, source)` renders immediately when the detail page opens, before the fetch resolves.
- **Empty (`count: 0` or no qualifying jobs):** `liveOpportunityEmptyHTML(employer, source)` explains that no current matching opportunities were found and points back to the employer's own careers link. The curated employer detail content (hero, requirements, programs, sidebar) is unaffected and stays visible.
- **Error** (network failure, non-OK response, malformed JSON): `liveOpportunityErrorHTML(employer, source)` replaces only the live-feed section with a short "temporarily unavailable" message. It never replaces or hides the curated employer detail content around it.

`renderLiveOpportunitySection(employer, source)` also checks that the DOM container `live-opportunities-<employerId>` still exists before writing into it, in case the visitor has navigated to a different page while the request was still in flight.

## Only Dun & Bradstreet is currently enabled

`window.LIVE_OPPORTUNITY_SOURCES` today contains exactly one entry:

```js
{
  employerId: 41,
  employerName: "Dun & Bradstreet",
  provider: "lever",
  endpoint: "/api/dnb-lever-jobs",
  sourceLabel: "Live from employer",
  enabled: true
}
```

No other employer record in `data.js` has a matching, enabled registry entry, so `getLiveOpportunitySource()` returns `null` for every other employer and no other employer's detail page makes a live-feed request or shows a live-feed section.

## Adding a future source (e.g. a second Lever employer, or a Greenhouse employer)

Adding a new entry to the registry is a small, mechanical step — but it is **not**, by itself, sufficient to bring a new employer's live feed online safely. A future addition must include, at minimum:

1. **A new, dedicated API endpoint** implemented as its own Vercel Function (following the pattern in `api/dnb-lever-jobs.js`): a fixed upstream URL, response normalization into the same job shape (`postingKind`, `opportunityType`, `studentLevel`, etc.), a request timeout, and a controlled error response. A registry entry alone does not create this endpoint.
2. **A new registry entry** with the new employer's stable `employerId` (matching an existing `data.js` record), the correct `provider`, the new `endpoint` path, an appropriate `sourceLabel`, and `enabled: true` only once the endpoint has been validated.
3. **Separate validation** of the new endpoint's filtering and normalization logic against that employer's real feed data (Jacksonville/Northeast Florida relevance, student/early-talent relevance, talent-network vs. open-opportunity classification), following the same rigor as `docs/integrations/dnb-lever-poc.md`'s manual testing checklist.
4. **Separate documentation** describing the new source's filtering rules, field mapping, and known classification limitations, following the shape of `docs/integrations/dnb-lever-poc.md`.
5. **Separate testing** — desktop and mobile manual verification of loading/empty/error states, caching, and non-interference with other employers, plus confirmation that no other part of the UI (directory, search, homepage, map) triggers the new endpoint.

## What a registry entry does not do

- It does not create an API endpoint. `endpoint` is only a reference to a path that must already exist as its own implemented, tested Vercel Function.
- It does not validate that the referenced endpoint works, is reachable, or returns the expected shape.
- It does not add a new employer to `data.js`. `employerId` must reference an employer record that already exists there.
- It does not grant the employer a duplicate card anywhere in the UI — it only controls whether the employer's existing detail page shows an additional live-feed section.
- It does not add authentication, a database, a scheduled job, or any new dependency.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-07-14 | Introduced `live-opportunity-sources.js` and the generic `liveOpportunity*` frontend functions in `app.js`, replacing the Dun & Bradstreet-specific implementation with a registry-driven one. Dun & Bradstreet's behavior, endpoint, caching, and rendering are unchanged; it is now the registry's one enabled entry. | Claude (implementation task) |
