# Dun & Bradstreet Lever Postings Proof of Concept

**Status:** `DEMO ONLY` — a working endpoint exists, but it is not wired into `index.html`, `app.js`, or `data.js`, and it does not appear anywhere in the user interface.
**Endpoint:** `api/dnb-lever-jobs.js`
**Related decision:** `docs/decisions/ADR-003-dnb-lever-job-poc.md`
**Related research:** `docs/integrations/api-evaluation.md` (Section 5.9, Section 11)

## Why Dun & Bradstreet

`docs/integrations/api-evaluation.md` identified the Lever Postings API as the opportunity source with the best field-level fit for WorkJax's target data model (`commitment`, `workplaceType`, `salaryRange`, `applyUrl`), but noted that no current WorkJax employer had been confirmed to use Lever. Dun & Bradstreet's public Lever site (`api.lever.co/v0/postings/dnb`) was identified as a real, live, unauthenticated Lever board suitable for a small read-only proof of concept, independent of whether D&B is added to WorkJax's employer list. This proof of concept validates the request/filter/normalize pattern only — it is not a decision to add Dun & Bradstreet to `data.js`.

## Fixed source

The endpoint always requests exactly one URL:

```
https://api.lever.co/v0/postings/dnb?mode=json
```

This is hard-coded in `api/dnb-lever-jobs.js`. The function does not accept a Lever site name, board token, or upstream URL from the caller in any form (query string, header, or body) — there is nothing in the request that changes which site or URL is fetched.

## Endpoint

`GET /api/dnb-lever-jobs`

No parameters. No authentication. No API key or environment variable is used — Dun & Bradstreet's Lever postings are public, unauthenticated GET data.

### Response shape

```json
{
  "source": "lever:dnb",
  "employer": "Dun & Bradstreet",
  "generatedAt": "2026-07-13T00:00:00.000Z",
  "count": 0,
  "jobs": []
}
```

On an upstream failure, the same shape is returned with `count: 0`, `jobs: []`, an added `error` string, and HTTP status `502`. No upstream response body, status text, or headers are passed through.

## Filtering scope

A Dun & Bradstreet posting is included only if it passes **all** of the following:

1. **Jacksonville, Florida match** — `categories.location` or any entry in `categories.allLocations` case-insensitively contains `"jacksonville"` together with `"florida"` or `"fl"`.
2. **Student/early-talent relevance** — at least one of:
   - `categories.commitment` equals `"Intern"` (case-insensitive), or
   - `categories.department` or `categories.team` contains `"internship"`, or
   - the title contains, as a whole word or phrase, `Internship`, `Intern`, `Early Talent`, `Co-op`/`Coop`, `Apprentice`/`Apprenticeship`, or `Graduate Program`. Word-boundary matching is used so `"international"` never matches on `"intern"`.

Ordinary full-time Dun & Bradstreet roles in Jacksonville that do not hit any of the above signals are excluded — they are not classified as student opportunities. The result set is capped at 20 records.

## Normalized job shape

Every returned posting is normalized into:

| Field | Source |
|---|---|
| `id` | `"lever:dnb:" + posting.id` |
| `sourceId` | Lever's own posting `id` |
| `sourceName` | `"Lever"` |
| `sourceEmployer` | `"Dun & Bradstreet"` |
| `title` | Lever `text` |
| `description` | Lever `content.description` (raw HTML, unmodified) |
| `descriptionPlain` | The same description with HTML tags mechanically stripped |
| `opportunityType` | `"Internship"`, `"Apprenticeship"`, or `"Early Talent"` — see Classification below |
| `studentLevel` | `"College"` or `"Unspecified"` — see Classification below |
| `employerName` | `"Dun & Bradstreet"` |
| `location` | Lever `categories.location` |
| `allLocations` | Lever `categories.allLocations` |
| `city` / `stateCode` | Parsed from `location` only when it cleanly matches `"City, ST"`; otherwise `null` |
| `countryCode` | Lever `country` |
| `workplaceType` | Lever `workplaceType` |
| `commitment` | Lever `categories.commitment` |
| `team` | Lever `categories.team` |
| `department` | Lever `categories.department` |
| `salaryRange` | Lever `salaryRange` object, or `null` if absent |
| `externalUrl` | Lever `hostedUrl` |
| `applicationUrl` | Lever `applyUrl` |
| `sourceLastSeenAt` / `lastVerifiedAt` | The server's request timestamp (ISO 8601), both set identically |
| `dateVerificationStatus` | `"verified"` — the live fetch is the verification |
| `status` | `"active"` |

## Classification limitations

- **opportunityType** is conservative: `"Internship"` requires a structural signal (`commitment`, `department`/`team`, or title) or an explicit title match; `"Apprenticeship"` requires an explicit structural or title match; everything else that passed the relevance filter falls back to `"Early Talent"`. Nothing is inferred beyond these fields.
- **studentLevel** is `"College"` only when the title or description text explicitly contains `college`, `university`, `undergraduate`, `graduate`, or `degree`. It is otherwise `"Unspecified"`. **High-school eligibility is never inferred** — this endpoint has no mechanism to determine or claim high-school eligibility.
- No compensation amount, application deadline, or age/eligibility requirement is invented. `salaryRange` is passed through only if Lever provides it; otherwise it is `null`.

## Error and cache behavior

- Upstream timeout (8 seconds), network failure, non-2xx status, or a non-JSON/non-array response body all return the controlled error JSON described above with HTTP `502`. No upstream error detail is exposed.
- Zero qualifying Jacksonville student postings is not an error — it returns HTTP `200` with `jobs: []`.
- Responses include `Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=60` — a conservative 5-minute CDN cache.
- Because nothing in `app.js` or `index.html` calls this endpoint, a failure here has no effect on any existing WorkJax page.

## Manual testing checklist

1. Deploy to a Vercel Preview and request `GET /api/dnb-lever-jobs`; confirm a `200` response with the documented top-level shape.
2. Confirm every returned job's `id` starts with `lever:dnb:` and has a non-empty `externalUrl` and `applicationUrl`.
3. Independently fetch `https://api.lever.co/v0/postings/dnb?mode=json` and manually cross-check 3–5 returned jobs' `location`/`allLocations` to confirm Jacksonville filtering has no false positives or negatives.
4. Identify at least one ordinary full-time Dun & Bradstreet Jacksonville posting in the raw feed and confirm it does **not** appear in the endpoint's output.
5. Confirm no job in the response has `studentLevel: "College"` unless its title or description text actually contains one of the listed college-reference words.
6. Confirm the response has no `error` field and the correct `Cache-Control` header on a normal run.
7. Load the existing WorkJax homepage and Opportunities page and confirm no console errors or behavior change — this endpoint is not called from anywhere in the current UI.

## What this proof of concept is not

- It is **not** a citywide job aggregator. It reflects only Dun & Bradstreet's own Lever board, one employer among many in Jacksonville.
- It does **not** add Dun & Bradstreet to WorkJax's live employer or opportunity listings. `data.js` remains the site's only live data source.
- It does **not** appear anywhere in the user interface. There is no link, button, or fetch call in `index.html` or `app.js` that reaches this endpoint.
- It does **not** process applications or store applicant information — every `applicationUrl` sends the user to Dun & Bradstreet's own official application page.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-07-13 | Documented the Dun & Bradstreet Lever Postings API endpoint-only proof of concept | Claude (implementation task) |
