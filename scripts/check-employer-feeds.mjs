// Employer feed monitoring checker. Built-in Node.js APIs only — no dependencies.
// Reads monitoring/employer-feed-watch.json, fetches enabled Lever/Greenhouse
// JSON sources and enabled public iCIMS career-portal HTML sources, filters
// conservatively for Jacksonville student/early-talent postings, and (when
// UPDATE_ISSUE=true) creates or updates a single GitHub issue with the
// report. Never submits applications, never touches login/candidate/apply
// endpoints, and never collects applicant data — every request is a
// read-only GET against a public postings feed or public career-portal page.
// See docs/operations/employer-feed-monitoring.md.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, "..", "monitoring", "employer-feed-watch.json");
const ISSUE_TITLE = "Employer Feed Watch Report";
const REQUEST_TIMEOUT_MS = 10000;
const ALLOWED_PROVIDERS = ["lever", "greenhouse", "icims_public_portal"];
const STATE_MARKER_START = "<!-- employer-feed-watch:state";
const STATE_MARKER_END = "-->";

// icims_public_portal: a generic adapter for any public, unauthenticated
// iCIMS career-portal job-search results page (not specific to any one
// employer). See the "iCIMS public-portal adapter" section below.
const ICIMS_MAX_PAGES = 5;
const ICIMS_MAX_BLOCK_CHARS = 4000;
// Finite, streamed cap — not a truncation-immune read, but bounded and safe.
// Raised from 2MB; a real search-results page is normally tens-to-hundreds
// of KB, so this is headroom, not a fix for a specific observed truncation.
const ICIMS_MAX_HTML_BYTES = 5_000_000;

// Four possible outcomes of checking one iCIMS public-portal page, so that a
// parser/detection failure is never collapsed into the same "healthy" result
// as a genuinely empty search. See checkIcimsPublicPortalSource().
const ICIMS_PARSE_STATUS = {
  HEALTHY_WITH_RECORDS: "healthy_with_records",
  HEALTHY_EMPTY: "healthy_empty",
  PARSER_WARNING: "parser_warning",
  REQUEST_FAILURE: "request_failure",
};

const REQUIRED_SOURCE_FIELDS = [
  "sourceId",
  "employerId",
  "employerName",
  "provider",
  "status",
  "endpoint",
  "enabled",
  "locationKeywords",
  "studentKeywords",
  "lastManuallyVerifiedAt",
  "notes",
];

/* ════════════════════════════════════
   Registry loading and validation
═══════════════════════════════════ */

function loadRegistry() {
  let raw;
  try {
    raw = readFileSync(REGISTRY_PATH, "utf8");
  } catch (err) {
    throw new Error(`Unable to read registry at ${REGISTRY_PATH}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Registry is not valid JSON: ${err.message}`);
  }

  validateRegistry(parsed);
  return parsed;
}

function validateRegistry(registry) {
  if (!registry || typeof registry !== "object") {
    throw new Error("Registry root must be an object.");
  }
  if (!Array.isArray(registry.allowedStatusValues) || registry.allowedStatusValues.length === 0) {
    throw new Error("Registry must define a non-empty allowedStatusValues array.");
  }
  if (!Array.isArray(registry.sources) || registry.sources.length === 0) {
    throw new Error("Registry must define a non-empty sources array.");
  }

  const seenSourceIds = new Set();

  registry.sources.forEach((source, index) => {
    if (!source || typeof source !== "object") {
      throw new Error(`Registry source at index ${index} must be an object.`);
    }

    for (const field of REQUIRED_SOURCE_FIELDS) {
      if (!(field in source)) {
        throw new Error(`Registry source at index ${index} is missing required field "${field}".`);
      }
    }

    if (typeof source.sourceId !== "string" || source.sourceId.trim() === "") {
      throw new Error(`Registry source at index ${index} has an invalid sourceId.`);
    }
    if (seenSourceIds.has(source.sourceId)) {
      throw new Error(`Duplicate sourceId "${source.sourceId}" in registry.`);
    }
    seenSourceIds.add(source.sourceId);

    if (typeof source.employerId !== "number") {
      throw new Error(`Registry source "${source.sourceId}" has a non-numeric employerId.`);
    }
    if (typeof source.employerName !== "string" || source.employerName.trim() === "") {
      throw new Error(`Registry source "${source.sourceId}" has an invalid employerName.`);
    }
    if (!ALLOWED_PROVIDERS.includes(source.provider)) {
      throw new Error(`Registry source "${source.sourceId}" has unsupported provider "${source.provider}".`);
    }
    if (!registry.allowedStatusValues.includes(source.status)) {
      throw new Error(`Registry source "${source.sourceId}" has unsupported status "${source.status}".`);
    }
    if (typeof source.endpoint !== "string" || !/^https:\/\//.test(source.endpoint)) {
      throw new Error(`Registry source "${source.sourceId}" must have an https:// endpoint.`);
    }
    if (typeof source.enabled !== "boolean") {
      throw new Error(`Registry source "${source.sourceId}" has a non-boolean enabled field.`);
    }
    if (!Array.isArray(source.locationKeywords) || source.locationKeywords.length === 0) {
      throw new Error(`Registry source "${source.sourceId}" must have a non-empty locationKeywords array.`);
    }
    if (!Array.isArray(source.studentKeywords) || source.studentKeywords.length === 0) {
      throw new Error(`Registry source "${source.sourceId}" must have a non-empty studentKeywords array.`);
    }
    if (
      source.lastManuallyVerifiedAt !== null &&
      typeof source.lastManuallyVerifiedAt !== "string"
    ) {
      throw new Error(`Registry source "${source.sourceId}" has an invalid lastManuallyVerifiedAt.`);
    }
    if (typeof source.notes !== "string") {
      throw new Error(`Registry source "${source.sourceId}" has a non-string notes field.`);
    }
  });
}

/* ════════════════════════════════════
   Shared filtering helpers
   (Conservative rules mirrored from api/dnb-lever-jobs.js — never treat an
   ordinary full-time role as a student opportunity, never infer high-school
   eligibility.)
═══════════════════════════════════ */

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripHtml(html) {
  if (typeof html !== "string" || html.length === 0) return "";
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function isLocationQualifying(text, locationKeywords) {
  if (typeof text !== "string" || text.length === 0) return false;
  const normalized = text.toLowerCase();
  const [cityKeyword, ...stateKeywords] = locationKeywords;
  if (!cityKeyword || !normalized.includes(cityKeyword.toLowerCase())) return false;
  if (stateKeywords.length === 0) return true;

  const stateMatch = stateKeywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
  const hasFloridaKeyword = stateKeywords.some((keyword) => keyword.toLowerCase() === "florida");
  return stateMatch || (hasFloridaKeyword && /\bfl\b/.test(normalized));
}

function buildStudentKeywordPattern(studentKeywords) {
  const alternation = studentKeywords.map((keyword) => escapeRegExp(keyword)).join("|");
  return new RegExp(`\\b(${alternation})\\b`, "i");
}

function isStudentQualifying(text, studentPattern) {
  if (typeof text !== "string" || text.length === 0) return false;
  return studentPattern.test(text);
}

function evaluateQualification(candidate, source, studentPattern) {
  const locationText = [candidate.location, ...(candidate.allLocations || [])].filter(Boolean).join(" | ");
  const locationOk = isLocationQualifying(locationText, source.locationKeywords);

  const studentText = [candidate.title, candidate.department, candidate.descriptionPlain]
    .filter(Boolean)
    .join(" — ");
  const studentOk = isStudentQualifying(studentText, studentPattern);

  const reasons = [];
  if (locationOk) reasons.push(`Location match: "${candidate.location || locationText}"`);
  if (studentOk) {
    const match = studentText.match(studentPattern);
    reasons.push(`Student-keyword match: "${match ? match[0] : "keyword"}"`);
  }

  return { qualifies: locationOk && studentOk, reasons };
}

/* ════════════════════════════════════
   Provider adapters
═══════════════════════════════════ */

async function fetchJsonWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`Upstream returned HTTP ${response.status}`);
      error.category = "http";
      throw error;
    }
    let body;
    try {
      body = await response.json();
    } catch (err) {
      const error = new Error("Upstream response was not valid JSON.");
      error.category = "malformed";
      throw error;
    }
    return body;
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutError = new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms.`);
      timeoutError.category = "timeout";
      throw timeoutError;
    }
    if (!err.category) err.category = "network";
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeLeverPostings(body) {
  if (!Array.isArray(body)) {
    const error = new Error("Expected a JSON array of Lever postings.");
    error.category = "malformed";
    throw error;
  }
  return body
    .filter((posting) => posting && typeof posting === "object")
    .map((posting) => {
      const categories = posting.categories || {};
      const content = posting.content || {};
      const descriptionPlain = stripHtml(typeof content.description === "string" ? content.description : "");
      return {
        jobId: String(posting.id ?? ""),
        title: typeof posting.text === "string" ? posting.text : "",
        location: typeof categories.location === "string" ? categories.location : null,
        allLocations: Array.isArray(categories.allLocations) ? categories.allLocations : [],
        department: typeof categories.department === "string" ? categories.department : null,
        descriptionPlain,
        applicationUrl: typeof posting.applyUrl === "string" ? posting.applyUrl : null,
      };
    })
    .filter((candidate) => candidate.jobId !== "");
}

function normalizeGreenhousePostings(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.jobs)) {
    const error = new Error("Expected an object with a jobs array from Greenhouse.");
    error.category = "malformed";
    throw error;
  }
  return body.jobs
    .filter((job) => job && typeof job === "object")
    .map((job) => {
      const departments = Array.isArray(job.departments)
        ? job.departments.map((d) => (d && typeof d.name === "string" ? d.name : "")).filter(Boolean)
        : [];
      return {
        jobId: String(job.id ?? ""),
        title: typeof job.title === "string" ? job.title : "",
        location: job.location && typeof job.location.name === "string" ? job.location.name : null,
        allLocations: [],
        department: departments.join(", ") || null,
        descriptionPlain: stripHtml(typeof job.content === "string" ? job.content : ""),
        applicationUrl: typeof job.absolute_url === "string" ? job.absolute_url : null,
      };
    })
    .filter((candidate) => candidate.jobId !== "");
}

/* ════════════════════════════════════
   iCIMS public-portal adapter
   Generic — driven entirely by source.endpoint/source.locationKeywords, not
   specific to any one employer. Reads only the configured public job-search
   results page (and, when present, its same-hostname "next page" link) —
   never a login, candidate-profile, application-submission, or authenticated
   iCIMS API endpoint, and never submits a form or collects applicant data.
═══════════════════════════════════ */

function isAllowedIcimsHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return normalized === "icims.com" || normalized.endsWith(".icims.com");
}

// Recognizable job-search-results structure: iCIMS_Job*-prefixed class
// names, data-job-id/data-jobid attributes (both used by iCIMS across its
// portal skins to tag job rows for client-side scripting), or an "N of M
// jobs/results" count phrase. Used to tell "this is a results page but
// nothing could be parsed" (parser_warning) apart from a page that isn't a
// results page at all, and from a genuinely empty result.
const ICIMS_RESULTS_MARKER_PATTERN = /iCIMS_Job|data-job-?id\s*=|class=["'][^"']*\bjobs?[-_]?(table|list|row|result)/i;
const ICIMS_RESULT_COUNT_PATTERN = /\b\d+\s*(?:-\s*\d+\s*)?of\s*\d+\s*(jobs?|results?|positions?)\b/i;

// Explicit "no results" phrasing only — absence of parsed records alone is
// never enough to call a source healthy_empty (that was the reported bug).
const ICIMS_ZERO_RESULTS_PATTERN =
  /\b(no|0)\s+(jobs?|positions?|openings?|results?)\s*(were\s+)?(found|match(ed)?|available|returned)\b|your search did not match any jobs/i;

// Bot-challenge/interstitial phrasing — treated as a request failure, not a
// portal page to parse.
const ICIMS_CHALLENGE_PATTERN = /checking your browser|attention required|cf-browser-verification|access denied|are you a human|captcha/i;

async function readIcimsBodyCapped(response) {
  if (!response.body) {
    const text = await response.text();
    return { text, bytesRead: Buffer.byteLength(text, "utf8"), capReached: false };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  let capReached = false;
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (received >= ICIMS_MAX_HTML_BYTES) {
        capReached = true;
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  return { text, bytesRead: received, capReached };
}

async function fetchIcimsHtmlWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "workjax-employer-feed-watch (+read-only public iCIMS job-search page check)" },
    });
    const finalUrl = new URL(response.url || url);
    if (!response.ok) {
      const error = new Error(`Upstream returned HTTP ${response.status} at final URL ${finalUrl.href}`);
      error.category = "http";
      throw error;
    }
    const { text: html, bytesRead, capReached } = await readIcimsBodyCapped(response);
    return { finalUrl, html, bytesRead, capReached };
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutError = new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms.`);
      timeoutError.category = "timeout";
      throw timeoutError;
    }
    if (!err.category) err.category = "network";
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// A stable iCIMS convention: public job-detail URLs end in <numeric-id>/<slug>/job,
// e.g. /jobs/12345/electrician/job. A search-results page already living at
// /jobs/search plausibly emits *relative* anchors (e.g. "12345/electrician/job",
// no repeated "/jobs/" prefix) that resolve correctly once combined with the
// page's own URL but never contain the literal substring "/jobs/" — so this
// pattern matches the <id>/<slug>/job shape regardless of what (if anything)
// precedes it, rather than requiring a "/jobs/" prefix in the raw href text.
const ICIMS_JOB_LINK_PATTERN =
  /<a\b[^>]*\bhref\s*=\s*["']([^"'?#]*?(\d{3,})\/[^"'/?#]+\/job)(?:[?#][^"']*)?["'][^>]*>([\s\S]*?)<\/a>/gi;

const ICIMS_FIELD_LABELS = [
  "Category",
  "Position Type",
  "Location Type",
  "Job Location",
  "Location",
  "Posted Date",
  "Date Posted",
  "Company",
];

function extractIcimsLabeledField(blockText, label) {
  const labelAlternation = ICIMS_FIELD_LABELS.map(escapeRegExp).join("|");
  const pattern = new RegExp(
    `\\b${escapeRegExp(label)}\\s*[:\\-]?\\s*([^\\n]{1,80}?)(?=\\s+(?:${labelAlternation})\\b\\s*[:\\-]|$)`,
    "i"
  );
  const match = blockText.match(pattern);
  if (!match) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

// Best-effort, conservative parse of a search-results page into per-job
// records. Never follows anything but the job-detail link pattern above;
// never reads/derives applicant data. Fields other than jobId/title/
// jobDetailUrl default to null when not confidently found — qualification
// below always falls back to scanning the whole stripped block text, so it
// stays robust to portal template drift.
function parseIcimsJobBlocks(html, pageUrl) {
  const pattern = new RegExp(ICIMS_JOB_LINK_PATTERN.source, "gi");
  const matches = [];
  let match;
  while ((match = pattern.exec(html)) !== null) {
    matches.push({ index: match.index, endIndex: pattern.lastIndex, href: match[1], jobId: match[2], titleHtml: match[3] });
  }

  return matches
    .map((m, i) => {
      const blockStart = i === 0 ? Math.max(0, m.index - 200) : matches[i - 1].endIndex;
      const blockEnd =
        i + 1 < matches.length
          ? Math.min(matches[i + 1].index, m.endIndex + ICIMS_MAX_BLOCK_CHARS)
          : Math.min(html.length, m.endIndex + ICIMS_MAX_BLOCK_CHARS);
      const blockText = stripHtml(html.slice(blockStart, blockEnd));

      let jobDetailUrl = null;
      try {
        jobDetailUrl = new URL(m.href, pageUrl).href;
      } catch {
        jobDetailUrl = null;
      }

      return {
        jobId: m.jobId,
        title: stripHtml(m.titleHtml),
        jobDetailUrl,
        company: extractIcimsLabeledField(blockText, "Company"),
        category: extractIcimsLabeledField(blockText, "Category"),
        positionType: extractIcimsLabeledField(blockText, "Position Type"),
        locationType: extractIcimsLabeledField(blockText, "Location Type"),
        jobLocation: extractIcimsLabeledField(blockText, "Job Location") || extractIcimsLabeledField(blockText, "Location"),
        postedDate: extractIcimsLabeledField(blockText, "Posted Date") || extractIcimsLabeledField(blockText, "Date Posted"),
        blockText,
      };
    })
    .filter((candidate) => candidate.jobId && candidate.title);
}

// Generic, template-agnostic "next page" heuristic — followed only when it
// resolves to the same allowed iCIMS hostname (checked by the caller).
function findNextIcimsPageUrl(html, currentUrl) {
  const linkPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const text = stripHtml(match[2]).trim();
    if (/^(next|next\s*page|›|»)$/i.test(text)) {
      try {
        return new URL(match[1], currentUrl);
      } catch {
        continue;
      }
    }
  }
  return null;
}

function normalizeIcimsUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname}${u.search}`;
  } catch {
    return rawUrl;
  }
}

// Generic employer-identity match, derived from the registry's own
// employerName rather than hardcoded to any one employer — this is what lets
// the same adapter be reused for a future, separately-validated iCIMS source
// (e.g. Haskell) without editing adapter code. Common corporate suffixes are
// stripped so "Miller Electric Company" matches "Miller Electric" wherever it
// appears, and never a generic EMCOR mention or an unrelated EMCOR subsidiary.
function buildEmployerIdentityPattern(employerName) {
  const stripped = String(employerName || "")
    .replace(/\b(company|co\.?|inc\.?|llc|corp\.?|corporation|ltd\.?)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const base = stripped.length > 0 ? stripped : employerName;
  return new RegExp(escapeRegExp(base), "i");
}

function isEmployerRecord(candidate, employerPattern) {
  if (candidate.company && employerPattern.test(candidate.company)) return true;
  return employerPattern.test(candidate.blockText) || employerPattern.test(candidate.title);
}

function isIcimsLocationQualifying(candidate, locationKeywords) {
  const text = `${candidate.jobLocation || ""} ${candidate.locationType || ""} ${candidate.blockText}`.toLowerCase();
  return locationKeywords.some((keyword) => text.includes(String(keyword).toLowerCase()));
}

// Deliberately narrower than the generic Lever/Greenhouse studentKeywords
// match: an ordinary full-time or "entry-level" listing must never qualify
// on its own, and high-school eligibility is never inferred. A record only
// qualifies on an explicit, strong signal.
function hasStrongStudentSignal(candidate) {
  if (candidate.positionType && /\bintern\b/i.test(candidate.positionType)) return true;
  if (candidate.category && /\binternship\b/i.test(candidate.category)) return true;
  if (candidate.title && /\b(intern|internship|co-op|coop|apprentice|apprenticeship)\b/i.test(candidate.title)) return true;
  if (/(currently enrolled|college student|university student|early[- ]career program)/i.test(candidate.blockText)) return true;
  return false;
}

function describeStrongStudentSignal(candidate) {
  if (candidate.positionType && /\bintern\b/i.test(candidate.positionType)) return `position type "${candidate.positionType}"`;
  if (candidate.category && /\binternship\b/i.test(candidate.category)) return `category "${candidate.category}"`;
  if (candidate.title && /\b(intern|internship|co-op|coop|apprentice|apprenticeship)\b/i.test(candidate.title)) {
    return `title "${candidate.title}"`;
  }
  return "explicit enrolled-student/early-career program text in the listing";
}

function evaluateIcimsQualification(candidate, source) {
  const locationOk = isIcimsLocationQualifying(candidate, source.locationKeywords);
  const studentOk = hasStrongStudentSignal(candidate);
  const reasons = [];
  if (locationOk) {
    reasons.push(`Location match: "${candidate.jobLocation || candidate.locationType || "Jacksonville evidence in listing"}"`);
  }
  if (studentOk) reasons.push(`Strong student signal: ${describeStrongStudentSignal(candidate)}`);
  return { qualifies: locationOk && studentOk, reasons };
}

async function checkIcimsPublicPortalSource(source, generatedAt) {
  const base = {
    sourceId: source.sourceId,
    employerId: source.employerId,
    employerName: source.employerName,
    provider: source.provider,
    status: source.status,
    endpoint: source.endpoint,
    lastCheckedAt: generatedAt,
  };
  const employerPattern = buildEmployerIdentityPattern(source.employerName);

  const requestFailure = (error, extra = {}) => ({
    ...base,
    healthy: false,
    error,
    parseStatus: ICIMS_PARSE_STATUS.REQUEST_FAILURE,
    totalFetched: 0,
    qualifying: [],
    pagesChecked: extra.pagesChecked || 0,
    recordsExamined: 0,
    employerRecordsFound: 0,
    jacksonvilleEmployerRecordsFound: 0,
    diagnostics: {
      responseBytesRead: extra.responseBytesRead || 0,
      responseSizeCapReached: extra.responseSizeCapReached || false,
      finalUrl: extra.finalUrl || null,
      finalHostname: extra.finalHostname || null,
      resultsPageMarkerFound: false,
      zeroResultsMarkerFound: false,
      potentialJobLinksFound: 0,
    },
  });

  try {
    const visitedUrls = new Set();
    const seenJobIds = new Set();
    const allCandidates = [];
    let pagesChecked = 0;
    let currentUrl = source.endpoint;
    let responseBytesRead = 0;
    let responseSizeCapReached = false;
    let resultsPageMarkerFound = false;
    let zeroResultsMarkerFound = false;
    let potentialJobLinksFound = 0;
    let lastFinalUrl = null;
    let hardFailure = null;

    for (let page = 0; page < ICIMS_MAX_PAGES; page += 1) {
      let finalUrl;
      let html;
      let bytesRead;
      let capReached;
      try {
        // eslint-disable-next-line no-await-in-loop
        ({ finalUrl, html, bytesRead, capReached } = await fetchIcimsHtmlWithTimeout(currentUrl));
      } catch (err) {
        if (pagesChecked === 0) hardFailure = err.message;
        break;
      }

      lastFinalUrl = finalUrl;
      responseBytesRead += bytesRead;
      if (capReached) responseSizeCapReached = true;

      if (!isAllowedIcimsHostname(finalUrl.hostname)) {
        if (pagesChecked === 0) {
          hardFailure = `Final URL hostname "${finalUrl.hostname}" is not an allowed iCIMS career-portal hostname.`;
        }
        break;
      }

      if (ICIMS_CHALLENGE_PATTERN.test(html)) {
        if (pagesChecked === 0) {
          hardFailure = "Response appears to be a bot-challenge/verification page, not the iCIMS career portal.";
        }
        break;
      }

      pagesChecked += 1;
      visitedUrls.add(normalizeIcimsUrl(finalUrl.href));

      if (ICIMS_RESULTS_MARKER_PATTERN.test(html) || ICIMS_RESULT_COUNT_PATTERN.test(html)) {
        resultsPageMarkerFound = true;
      }
      if (ICIMS_ZERO_RESULTS_PATTERN.test(html)) zeroResultsMarkerFound = true;

      const pageCandidates = parseIcimsJobBlocks(html, finalUrl.href);
      potentialJobLinksFound += pageCandidates.length;
      for (const candidate of pageCandidates) {
        if (seenJobIds.has(candidate.jobId)) continue;
        seenJobIds.add(candidate.jobId);
        allCandidates.push(candidate);
      }

      if (pagesChecked >= ICIMS_MAX_PAGES) break;

      const nextUrl = findNextIcimsPageUrl(html, finalUrl.href);
      if (!nextUrl || !isAllowedIcimsHostname(nextUrl.hostname)) break;
      const normalizedNext = normalizeIcimsUrl(nextUrl.href);
      if (visitedUrls.has(normalizedNext)) break;
      currentUrl = nextUrl.href;
    }

    if (pagesChecked === 0) {
      return requestFailure(hardFailure || "Unable to check the iCIMS public portal.", {
        responseBytesRead,
        responseSizeCapReached,
        finalUrl: lastFinalUrl ? lastFinalUrl.href : null,
        finalHostname: lastFinalUrl ? lastFinalUrl.hostname : null,
      });
    }

    const recordsParsed = allCandidates.length;
    const employerCandidates = allCandidates.filter((c) => isEmployerRecord(c, employerPattern));
    const employerRecordsFound = employerCandidates.length;
    const jacksonvilleEmployerRecordsFound = employerCandidates.filter((c) =>
      isIcimsLocationQualifying(c, source.locationKeywords)
    ).length;

    const qualifying = employerCandidates
      .map((candidate) => {
        const { qualifies, reasons } = evaluateIcimsQualification(candidate, source);
        return {
          jobId: candidate.jobId,
          title: candidate.title,
          location: candidate.jobLocation || candidate.locationType || null,
          allLocations: [candidate.jobLocation, candidate.locationType].filter(Boolean),
          department: candidate.category || null,
          descriptionPlain: candidate.blockText.slice(0, 300),
          applicationUrl: candidate.jobDetailUrl,
          qualifies,
          reasons,
        };
      })
      .filter((candidate) => candidate.qualifies);

    let parseStatus;
    let healthy;
    let error;
    if (recordsParsed > 0) {
      parseStatus = ICIMS_PARSE_STATUS.HEALTHY_WITH_RECORDS;
      healthy = true;
      error = null;
    } else if (zeroResultsMarkerFound) {
      parseStatus = ICIMS_PARSE_STATUS.HEALTHY_EMPTY;
      healthy = true;
      error = null;
    } else {
      parseStatus = ICIMS_PARSE_STATUS.PARSER_WARNING;
      healthy = false;
      error = resultsPageMarkerFound
        ? "Page appears to be an iCIMS job-results page (result markers detected) but zero records could be parsed — flagged for manual review, not treated as zero jobs."
        : "Portal HTML did not match any recognized iCIMS job-results structure — flagged for manual review, not treated as zero jobs.";
    }

    return {
      ...base,
      healthy,
      error,
      parseStatus,
      totalFetched: recordsParsed,
      qualifying,
      pagesChecked,
      recordsExamined: recordsParsed,
      employerRecordsFound,
      jacksonvilleEmployerRecordsFound,
      diagnostics: {
        responseBytesRead,
        responseSizeCapReached,
        finalUrl: lastFinalUrl ? lastFinalUrl.href : null,
        finalHostname: lastFinalUrl ? lastFinalUrl.hostname : null,
        resultsPageMarkerFound,
        zeroResultsMarkerFound,
        potentialJobLinksFound,
      },
    };
  } catch (err) {
    return requestFailure(err && err.message ? err.message : "Unexpected error while checking the iCIMS public portal.");
  }
}

/* ════════════════════════════════════
   Per-source check
═══════════════════════════════════ */

async function checkSource(source, generatedAt) {
  if (source.provider === "icims_public_portal") {
    return checkIcimsPublicPortalSource(source, generatedAt);
  }

  const base = {
    sourceId: source.sourceId,
    employerId: source.employerId,
    employerName: source.employerName,
    provider: source.provider,
    status: source.status,
    endpoint: source.endpoint,
    lastCheckedAt: generatedAt,
  };

  let body;
  try {
    body = await fetchJsonWithTimeout(source.endpoint);
  } catch (err) {
    return { ...base, healthy: false, error: err.message, totalFetched: 0, qualifying: [] };
  }

  let candidates;
  try {
    candidates = source.provider === "lever" ? normalizeLeverPostings(body) : normalizeGreenhousePostings(body);
  } catch (err) {
    return { ...base, healthy: false, error: err.message, totalFetched: 0, qualifying: [] };
  }

  const studentPattern = buildStudentKeywordPattern(source.studentKeywords);
  const qualifying = candidates
    .map((candidate) => {
      const { qualifies, reasons } = evaluateQualification(candidate, source, studentPattern);
      return { ...candidate, qualifies, reasons };
    })
    .filter((candidate) => candidate.qualifies);

  return {
    ...base,
    healthy: true,
    error: null,
    totalFetched: candidates.length,
    qualifying,
  };
}

/* ════════════════════════════════════
   Duplicate detection across boards
═══════════════════════════════════ */

function applyDuplicateDetection(sourceResults) {
  const seen = new Map(); // key -> { sourceId, jobId }
  for (const result of sourceResults) {
    if (!result.healthy) continue;
    for (const candidate of result.qualifying) {
      const key = [
        result.employerId,
        (candidate.title || "").trim().toLowerCase(),
        (candidate.location || "").trim().toLowerCase(),
      ].join("::");
      const existing = seen.get(key);
      if (existing) {
        candidate.duplicateOf = existing;
      } else {
        seen.set(key, { sourceId: result.sourceId, jobId: candidate.jobId });
      }
    }
  }
}

/* ════════════════════════════════════
   Previous-state comparison (from the hidden issue marker)
═══════════════════════════════════ */

function extractPreviousState(issueBody) {
  if (typeof issueBody !== "string") return null;
  const startIndex = issueBody.indexOf(STATE_MARKER_START);
  if (startIndex === -1) return null;
  const endIndex = issueBody.indexOf(STATE_MARKER_END, startIndex);
  if (endIndex === -1) return null;
  const jsonText = issueBody.slice(startIndex + STATE_MARKER_START.length, endIndex).trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function computeAggregated(sourceResults, previousState) {
  const previousSources = (previousState && previousState.sources) || {};
  const newlyFound = [];
  const noLongerPresent = [];
  const healthTransitions = [];

  for (const result of sourceResults) {
    const previous = previousSources[result.sourceId];
    const currentJobIds = new Set(result.qualifying.map((c) => c.jobId));

    if (previous) {
      const previousJobIds = new Set(previous.qualifyingJobIds || []);
      for (const candidate of result.qualifying) {
        if (!previousJobIds.has(candidate.jobId)) {
          newlyFound.push({
            sourceId: result.sourceId,
            employerName: result.employerName,
            jobId: candidate.jobId,
            title: candidate.title,
            applicationUrl: candidate.applicationUrl,
          });
        }
      }
      for (const jobId of previousJobIds) {
        if (!currentJobIds.has(jobId)) {
          noLongerPresent.push({ sourceId: result.sourceId, employerName: result.employerName, jobId });
        }
      }
      if (typeof previous.healthy === "boolean" && previous.healthy !== result.healthy) {
        healthTransitions.push({
          sourceId: result.sourceId,
          from: previous.healthy ? "healthy" : "failing",
          to: result.healthy ? "healthy" : "failing",
        });
      }
    }
  }

  const hasMeaningfulChange =
    newlyFound.length > 0 || noLongerPresent.length > 0 || healthTransitions.length > 0;

  return { newlyFound, noLongerPresent, healthTransitions, hasMeaningfulChange };
}

function buildStateSnapshot(generatedAt, sourceResults) {
  const sources = {};
  for (const result of sourceResults) {
    sources[result.sourceId] = {
      healthy: result.healthy,
      qualifyingJobIds: result.qualifying.map((c) => c.jobId),
    };
  }
  return { generatedAt, sources };
}

/* ════════════════════════════════════
   Report rendering
═══════════════════════════════════ */

function groupQualifyingByEmployer(sourceResults) {
  const byEmployer = new Map();
  for (const result of sourceResults) {
    if (!result.healthy) continue;
    for (const candidate of result.qualifying) {
      if (candidate.duplicateOf) continue; // show canonical occurrence only
      if (!byEmployer.has(result.employerName)) byEmployer.set(result.employerName, []);
      byEmployer.get(result.employerName).push({ ...candidate, sourceId: result.sourceId, provider: result.provider });
    }
  }
  return byEmployer;
}

function renderReportMarkdown(report) {
  const lines = [];
  lines.push(`# Employer Feed Watch Report`);
  lines.push("");
  lines.push(`**Last checked:** ${report.generatedAt}`);
  lines.push("");

  lines.push(`## Source health summary`);
  for (const result of report.sources) {
    const statusText = result.healthy ? "healthy" : `FAILED — ${result.error}`;
    const statusTag = result.parseStatus ? ` [${result.parseStatus}]` : "";
    lines.push(`- \`${result.sourceId}\` (${result.provider}, ${result.employerName})${statusTag}: ${statusText}`);
    if (typeof result.pagesChecked === "number") {
      lines.push(
        `  - Pages checked: ${result.pagesChecked}; records examined: ${result.recordsExamined ?? 0}; employer records found: ${result.employerRecordsFound ?? 0}; Jacksonville employer records found: ${result.jacksonvilleEmployerRecordsFound ?? 0}; qualifying student records: ${result.qualifying.length}`
      );
    }
    if (result.diagnostics) {
      const d = result.diagnostics;
      lines.push(
        `  - Diagnostics: response bytes read ${d.responseBytesRead}${d.responseSizeCapReached ? " (size cap reached)" : ""}; final hostname \`${d.finalHostname || "n/a"}\`; results-page marker ${d.resultsPageMarkerFound ? "found" : "not found"}; zero-results marker ${d.zeroResultsMarkerFound ? "found" : "not found"}; potential job links ${d.potentialJobLinksFound}`
      );
    }
  }
  if (report.skipped.length > 0) {
    for (const skipped of report.skipped) {
      lines.push(`- \`${skipped.sourceId}\` (${skipped.provider}, ${skipped.employerName}): skipped (disabled)`);
    }
  }
  lines.push("");

  const byEmployer = groupQualifyingByEmployer(report.sources);
  lines.push(`## Qualifying opportunities by employer`);
  if (byEmployer.size === 0) {
    lines.push(`No qualifying Jacksonville student/early-talent postings were found on any monitored source.`);
  } else {
    for (const [employerName, candidates] of byEmployer) {
      lines.push(`### ${employerName}`);
      for (const candidate of candidates) {
        lines.push(
          `- **${candidate.title}** — ${candidate.location || "location not specified"} (${candidate.provider}, job ID \`${candidate.jobId}\`) — ${candidate.reasons.join("; ")} — [Official application](${candidate.applicationUrl || "n/a"})`
        );
      }
    }
  }
  lines.push("");

  lines.push(`## Newly found postings`);
  if (report.aggregated.newlyFound.length === 0) {
    lines.push(`None since the previous report.`);
  } else {
    for (const item of report.aggregated.newlyFound) {
      lines.push(`- ${item.employerName}: **${item.title}** (\`${item.sourceId}\` / \`${item.jobId}\`) — [Apply](${item.applicationUrl || "n/a"})`);
    }
  }
  lines.push("");

  lines.push(`## Postings no longer present`);
  if (report.aggregated.noLongerPresent.length === 0) {
    lines.push(`None since the previous report.`);
  } else {
    for (const item of report.aggregated.noLongerPresent) {
      lines.push(`- ${item.employerName}: job ID \`${item.jobId}\` (\`${item.sourceId}\`)`);
    }
  }
  lines.push("");

  lines.push(`## Sources with no qualifying postings`);
  const emptyHealthySources = report.sources.filter((r) => r.healthy && r.qualifying.length === 0);
  if (emptyHealthySources.length === 0) {
    lines.push(`None — every healthy source currently has at least one qualifying posting.`);
  } else {
    for (const result of emptyHealthySources) {
      lines.push(`- \`${result.sourceId}\` (${result.employerName}) — checked ${result.totalFetched} posting(s), zero qualified.`);
    }
  }
  lines.push("");

  lines.push(`## Sources that failed`);
  const failedSources = report.sources.filter((r) => !r.healthy);
  if (failedSources.length === 0) {
    lines.push(`None — every enabled source responded successfully.`);
  } else {
    for (const result of failedSources) {
      const statusTag = result.parseStatus ? ` [${result.parseStatus}]` : "";
      lines.push(`- \`${result.sourceId}\` (${result.employerName})${statusTag}: ${result.error}`);
    }
  }
  lines.push("");

  lines.push(`## Recommended follow-up actions`);
  const followUps = [];
  if (report.aggregated.newlyFound.length > 0) {
    followUps.push(`Review the newly found posting(s) above and, if genuinely qualifying, consider a documented proof-of-concept before any UI change — do not connect a new feed to the WorkJax UI as part of this monitoring process.`);
  }
  if (failedSources.length > 0) {
    followUps.push(`Investigate the failing source(s) above — confirm the endpoint URL and board token are still correct.`);
  }
  if (followUps.length === 0) {
    followUps.push(`No action needed this run.`);
  }
  for (const followUp of followUps) lines.push(`- ${followUp}`);

  return lines.join("\n");
}

function renderIssueBody(report) {
  const markdown = renderReportMarkdown(report);
  const snapshot = buildStateSnapshot(report.generatedAt, report.sources);
  return `${markdown}\n\n${STATE_MARKER_START}\n${JSON.stringify(snapshot)}\n${STATE_MARKER_END}\n`;
}

function renderChangeComment(report) {
  const lines = [`Employer feed watch update — ${report.generatedAt}`, ""];
  for (const item of report.aggregated.newlyFound) {
    lines.push(`- New qualifying posting: ${item.employerName} — **${item.title}** (\`${item.sourceId}\`) — [Apply](${item.applicationUrl || "n/a"})`);
  }
  for (const item of report.aggregated.noLongerPresent) {
    lines.push(`- Posting no longer present: ${item.employerName} — job ID \`${item.jobId}\` (\`${item.sourceId}\`)`);
  }
  for (const item of report.aggregated.healthTransitions) {
    lines.push(`- Source \`${item.sourceId}\` changed from ${item.from} to ${item.to}.`);
  }
  return lines.join("\n");
}

/* ════════════════════════════════════
   GitHub issue API (built-in fetch only)
═══════════════════════════════════ */

function githubApiBase() {
  return process.env.GITHUB_API_URL || "https://api.github.com";
}

async function githubRequest(method, urlPath, body) {
  const response = await fetch(`${githubApiBase()}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "workjax-employer-feed-watch",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub API ${method} ${urlPath} failed: HTTP ${response.status} ${text}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function findExistingIssue(owner, repo) {
  const issues = await githubRequest("GET", `/repos/${owner}/${repo}/issues?state=open&per_page=100`);
  return issues.find((issue) => !issue.pull_request && issue.title === ISSUE_TITLE) || null;
}

async function createIssue(owner, repo, body) {
  return githubRequest("POST", `/repos/${owner}/${repo}/issues`, { title: ISSUE_TITLE, body });
}

async function updateIssueBody(owner, repo, number, body) {
  return githubRequest("PATCH", `/repos/${owner}/${repo}/issues/${number}`, { body });
}

async function addIssueComment(owner, repo, number, body) {
  return githubRequest("POST", `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
}

/* ════════════════════════════════════
   Entry point
═══════════════════════════════════ */

async function runChecks(registry, previousState) {
  const generatedAt = new Date().toISOString();
  const enabledSources = registry.sources.filter((s) => s.enabled);
  const skippedSources = registry.sources.filter((s) => !s.enabled);

  const sourceResults = [];
  for (const source of enabledSources) {
    // Sequential, not Promise.all: one slow/failing source must never affect
    // whether the others are attempted or how long they wait.
    // eslint-disable-next-line no-await-in-loop
    const result = await checkSource(source, generatedAt);
    sourceResults.push(result);
  }

  applyDuplicateDetection(sourceResults);
  const aggregated = computeAggregated(sourceResults, previousState);

  return {
    generatedAt,
    sources: sourceResults,
    skipped: skippedSources.map((s) => ({
      sourceId: s.sourceId,
      employerName: s.employerName,
      provider: s.provider,
    })),
    aggregated,
  };
}

async function main() {
  let registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    console.error(`Registry invalid — refusing to run: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const updateIssue = process.env.UPDATE_ISSUE === "true";
  let owner;
  let repo;
  let existingIssue = null;
  let previousState = null;

  if (updateIssue) {
    if (!process.env.GITHUB_TOKEN) {
      console.error("UPDATE_ISSUE=true but GITHUB_TOKEN is not set.");
      process.exitCode = 1;
      return;
    }
    const repoSlug = process.env.GITHUB_REPOSITORY || "";
    [owner, repo] = repoSlug.split("/");
    if (!owner || !repo) {
      console.error("UPDATE_ISSUE=true but GITHUB_REPOSITORY is not set correctly.");
      process.exitCode = 1;
      return;
    }
    try {
      existingIssue = await findExistingIssue(owner, repo);
      if (existingIssue) previousState = extractPreviousState(existingIssue.body);
    } catch (err) {
      console.error(`Unable to look up the existing issue: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  const report = await runChecks(registry, previousState);
  console.log(renderReportMarkdown(report));

  if (updateIssue) {
    const body = renderIssueBody(report);
    try {
      if (!existingIssue) {
        const created = await createIssue(owner, repo, body);
        console.log(`Created issue #${created.number}.`);
      } else {
        await updateIssueBody(owner, repo, existingIssue.number, body);
        console.log(`Updated issue #${existingIssue.number}.`);
        if (report.aggregated.hasMeaningfulChange) {
          await addIssueComment(owner, repo, existingIssue.number, renderChangeComment(report));
          console.log("Posted a change comment.");
        } else {
          console.log("No meaningful change — issue body updated silently, no comment posted.");
        }
      }
    } catch (err) {
      console.error(`Unable to create/update the issue: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  const enabledCount = registry.sources.filter((s) => s.enabled).length;
  const anyHealthy = report.sources.some((r) => r.healthy);
  if (enabledCount > 0 && !anyHealthy) {
    console.error("Every enabled automated source failed this run.");
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
}

main().catch((err) => {
  console.error("Unexpected failure while checking employer feeds:", err);
  process.exitCode = 1;
});
