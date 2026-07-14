// Monthly ATS discovery checker. Built-in Node.js APIs only — no dependencies.
// Reads monitoring/ats-research-candidates.json, fetches each enabled employer's
// official careers URL (read-only GET, following normal redirects), and inspects
// the returned HTML for links/hostnames belonging to a recognized ATS platform.
// This process never fetches an ATS-hosted page, an application-submission
// endpoint, or a job listing — it only reads the employer's own careers page.
// It never adds anything to monitoring/employer-feed-watch.json or
// live-opportunity-sources.js. See docs/operations/monthly-ats-discovery.md.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, "..", "monitoring", "ats-research-candidates.json");
const ISSUE_TITLE = "Monthly ATS Source Research";
const REQUEST_TIMEOUT_MS = 10000;
const CONCURRENCY_LIMIT = 4;
const MAX_HTML_BYTES = 2_000_000; // cap page reads; this is discovery, not scraping
const STATE_MARKER_START = "<!-- monthly-ats-discovery:state";
const STATE_MARKER_END = "-->";

const REQUIRED_CANDIDATE_FIELDS = [
  "employerId",
  "employerName",
  "careersUrl",
  "expectedPlatform",
  "confidence",
  "researchStatus",
  "priority",
  "enabled",
  "canonicalEmployerKey",
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
  if (!Array.isArray(registry.allowedResearchStatusValues) || registry.allowedResearchStatusValues.length === 0) {
    throw new Error("Registry must define a non-empty allowedResearchStatusValues array.");
  }
  if (!Array.isArray(registry.allowedConfidenceValues) || registry.allowedConfidenceValues.length === 0) {
    throw new Error("Registry must define a non-empty allowedConfidenceValues array.");
  }
  if (!Array.isArray(registry.allowedPriorityValues) || registry.allowedPriorityValues.length === 0) {
    throw new Error("Registry must define a non-empty allowedPriorityValues array.");
  }
  if (!Array.isArray(registry.candidates) || registry.candidates.length === 0) {
    throw new Error("Registry must define a non-empty candidates array.");
  }

  const seenEmployerIds = new Set();

  registry.candidates.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Registry candidate at index ${index} must be an object.`);
    }

    for (const field of REQUIRED_CANDIDATE_FIELDS) {
      if (!(field in candidate)) {
        throw new Error(`Registry candidate at index ${index} is missing required field "${field}".`);
      }
    }

    if (typeof candidate.employerId !== "number") {
      throw new Error(`Registry candidate at index ${index} has a non-numeric employerId.`);
    }
    if (seenEmployerIds.has(candidate.employerId)) {
      throw new Error(`Duplicate employerId ${candidate.employerId} in registry.`);
    }
    seenEmployerIds.add(candidate.employerId);

    if (typeof candidate.employerName !== "string" || candidate.employerName.trim() === "") {
      throw new Error(`Registry candidate "${candidate.employerId}" has an invalid employerName.`);
    }
    if (typeof candidate.careersUrl !== "string" || !/^https:\/\//.test(candidate.careersUrl)) {
      throw new Error(`Registry candidate "${candidate.employerId}" must have an https:// careersUrl.`);
    }
    if (candidate.expectedPlatform !== null && typeof candidate.expectedPlatform !== "string") {
      throw new Error(`Registry candidate "${candidate.employerId}" has an invalid expectedPlatform.`);
    }
    if (!registry.allowedConfidenceValues.includes(candidate.confidence)) {
      throw new Error(`Registry candidate "${candidate.employerId}" has unsupported confidence "${candidate.confidence}".`);
    }
    if (!registry.allowedResearchStatusValues.includes(candidate.researchStatus)) {
      throw new Error(`Registry candidate "${candidate.employerId}" has unsupported researchStatus "${candidate.researchStatus}".`);
    }
    if (!registry.allowedPriorityValues.includes(candidate.priority)) {
      throw new Error(`Registry candidate "${candidate.employerId}" has unsupported priority "${candidate.priority}".`);
    }
    if (typeof candidate.enabled !== "boolean") {
      throw new Error(`Registry candidate "${candidate.employerId}" has a non-boolean enabled field.`);
    }
    if (typeof candidate.canonicalEmployerKey !== "string" || candidate.canonicalEmployerKey.trim() === "") {
      throw new Error(`Registry candidate "${candidate.employerId}" has an invalid canonicalEmployerKey.`);
    }
    if (typeof candidate.notes !== "string") {
      throw new Error(`Registry candidate "${candidate.employerId}" has a non-string notes field.`);
    }

    // researchStatus/expectedPlatform consistency: never invent a platform for
    // an unverified candidate, per the task's explicit rule.
    if (candidate.researchStatus === "investigate" && candidate.expectedPlatform !== null) {
      throw new Error(
        `Registry candidate "${candidate.employerId}" is "investigate" (NOT VERIFIED) but has a non-null expectedPlatform — a platform must never be guessed for an unverified employer.`
      );
    }
  });
}

/* ════════════════════════════════════
   Recognized ATS hostname/link patterns
═══════════════════════════════════ */

const RECOGNIZED_PLATFORMS = [
  { name: "Lever", matchesHostname: (h) => h === "lever.co" || h.endsWith(".lever.co") },
  { name: "Greenhouse", matchesHostname: (h) => h === "greenhouse.io" || h.endsWith(".greenhouse.io") },
  { name: "SmartRecruiters", matchesHostname: (h) => h.endsWith("smartrecruiters.com") },
  { name: "Workday", matchesHostname: (h) => h.endsWith("myworkdayjobs.com") || h.endsWith("myworkdaysite.com") },
  { name: "iCIMS", matchesHostname: (h) => h.endsWith(".icims.com") },
  { name: "Taleo", matchesHostname: (h) => h.endsWith(".taleo.net") },
  {
    name: "Oracle Fusion Cloud Recruiting",
    matchesHostname: (h) => h.endsWith(".oraclecloud.com"),
    // Oracle Cloud hosts many unrelated products — also require the recruiting path.
    matchesUrl: (u) => u.hostname.endsWith(".oraclecloud.com") && u.pathname.includes("/hcmUI/CandidateExperience/"),
  },
  { name: "TeamWork Online", matchesHostname: (h) => h.endsWith("teamworkonline.com") },
  { name: "SilkRoad", matchesHostname: (h) => h.endsWith("silkroad.com") },
  { name: "NEOGOV / GovernmentJobs", matchesHostname: (h) => h.endsWith("governmentjobs.com") || h.endsWith("neogov.com") },
];

function detectPlatformForUrl(url) {
  for (const platform of RECOGNIZED_PLATFORMS) {
    if (platform.matchesUrl) {
      if (platform.matchesUrl(url)) return platform.name;
      continue;
    }
    if (platform.matchesHostname(url.hostname.toLowerCase())) return platform.name;
  }
  return null;
}

// Matches href="..." / href='...' attribute values (anchor or link tags).
const HREF_ATTR_PATTERN = /href\s*=\s*["']([^"']+)["']/gi;

function extractHrefUrls(html, baseUrl) {
  const urls = [];
  let match;
  HREF_ATTR_PATTERN.lastIndex = 0;
  while ((match = HREF_ATTR_PATTERN.exec(html)) !== null) {
    try {
      urls.push(new URL(match[1], baseUrl));
    } catch {
      // ignore unparsable hrefs (mailto:, javascript:, malformed, etc.)
    }
  }
  return urls;
}

// Detects platform evidence in the fetched page. Two tiers, per the task's rules:
//   "observed" — the final redirect target itself, or a clean <a>/<link> href, is
//                 hosted on a recognized ATS domain. This is the only tier allowed
//                 to count as "the official page directly exposes the ATS URL."
//   "possible"  — the platform's domain string appears elsewhere in the raw HTML
//                 (script tag, JSON blob, unlinked text) but not as a clean href.
//                 Never promoted to "observed," per the rule against trusting page
//                 appearance or JS variable names.
function detectAtsEvidence({ finalUrl, html }) {
  const evidence = [];
  const seen = new Set();

  function record(platform, tier, detail) {
    const key = `${platform}::${tier}::${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    evidence.push({ platform, tier, detail });
  }

  const finalPlatform = detectPlatformForUrl(finalUrl);
  if (finalPlatform) {
    record(finalPlatform, "observed", `Careers URL redirected directly to ${finalUrl.hostname}`);
  }

  const hrefUrls = extractHrefUrls(html, finalUrl);
  const hrefHostnames = new Set();
  for (const hrefUrl of hrefUrls) {
    if (hrefUrl.protocol !== "https:" && hrefUrl.protocol !== "http:") continue;
    const platform = detectPlatformForUrl(hrefUrl);
    if (platform) {
      hrefHostnames.add(hrefUrl.hostname.toLowerCase());
      record(platform, "observed", `Official page links directly to ${hrefUrl.hostname}`);
    }
  }

  // Weak tier: a recognized platform's domain string appears in the raw HTML
  // (e.g. inside a <script> block or JSON blob) but was not found as a clean
  // href above. This is explicitly never treated as confirmed.
  for (const platform of RECOGNIZED_PLATFORMS) {
    const probeHost = platformProbeHostname(platform.name);
    if (!probeHost) continue;
    if (hrefHostnames.has(probeHost)) continue; // already counted as observed
    if (html.toLowerCase().includes(probeHost)) {
      record(platform.name, "possible", `Domain string "${probeHost}" appears on the page outside a direct link — manual review required`);
    }
  }

  return evidence;
}

// A representative hostname fragment per platform, used only for the weak
// "does this string appear anywhere on the page" scan above.
function platformProbeHostname(platformName) {
  const map = {
    Lever: "lever.co",
    Greenhouse: "greenhouse.io",
    SmartRecruiters: "smartrecruiters.com",
    Workday: "myworkdayjobs.com",
    iCIMS: "icims.com",
    Taleo: "taleo.net",
    "Oracle Fusion Cloud Recruiting": "oraclecloud.com",
    "TeamWork Online": "teamworkonline.com",
    SilkRoad: "silkroad.com",
    "NEOGOV / GovernmentJobs": "governmentjobs.com",
  };
  return map[platformName] || null;
}

/* ════════════════════════════════════
   Fetching (capped, timed-out, redirect-following)
═══════════════════════════════════ */

async function readBodyCapped(response, maxBytes) {
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (received >= maxBytes) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  return text;
}

async function fetchCareersPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "workjax-monthly-ats-discovery (+read-only careers-page check)" },
    });
    const finalUrl = new URL(response.url || url);
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} at final URL ${finalUrl.href}`);
      error.category = "http";
      error.status = response.status;
      error.finalUrl = finalUrl;
      throw error;
    }
    const html = await readBodyCapped(response, MAX_HTML_BYTES);
    return { status: response.status, finalUrl, html };
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

/* ════════════════════════════════════
   Grouping (dedupe by canonicalEmployerKey and/or normalized careers URL)
═══════════════════════════════════ */

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    let normalized = `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname}`;
    if (normalized.endsWith("/") && normalized.length > `${u.protocol}//${u.hostname}`.length + 1) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

function buildFetchGroups(candidates) {
  // First pass: group by canonicalEmployerKey.
  const byKey = new Map();
  for (const candidate of candidates) {
    if (!byKey.has(candidate.canonicalEmployerKey)) byKey.set(candidate.canonicalEmployerKey, []);
    byKey.get(candidate.canonicalEmployerKey).push(candidate);
  }

  // Second pass: also merge any distinct keys that happen to share a
  // normalized careers URL, per "dedupe by canonicalEmployerKey or normalized
  // careers URL."
  const groups = [];
  const keyToGroupIndex = new Map();
  const urlToGroupIndex = new Map();

  for (const [key, members] of byKey) {
    const normalizedUrl = normalizeUrl(members[0].careersUrl);
    const existingByUrl = urlToGroupIndex.get(normalizedUrl);
    if (existingByUrl !== undefined) {
      groups[existingByUrl].members.push(...members);
      keyToGroupIndex.set(key, existingByUrl);
      continue;
    }
    const groupIndex = groups.length;
    groups.push({ canonicalEmployerKey: key, careersUrl: members[0].careersUrl, normalizedUrl, members: [...members] });
    keyToGroupIndex.set(key, groupIndex);
    urlToGroupIndex.set(normalizedUrl, groupIndex);
  }

  return groups;
}

/* ════════════════════════════════════
   Concurrency pool
═══════════════════════════════════ */

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(runners);
  return results;
}

/* ════════════════════════════════════
   Per-group check
═══════════════════════════════════ */

async function checkGroup(group, generatedAt) {
  const base = {
    canonicalEmployerKey: group.canonicalEmployerKey,
    originalUrl: group.careersUrl,
    employerIds: group.members.map((m) => m.employerId),
    employerNames: group.members.map((m) => m.employerName),
    checkedAt: generatedAt,
  };

  try {
    const { status, finalUrl, html } = await fetchCareersPage(group.careersUrl);
    const evidence = detectAtsEvidence({ finalUrl, html });
    const redirected = normalizeUrl(finalUrl.href) !== normalizeUrl(group.careersUrl);
    return {
      ...base,
      healthy: true,
      error: null,
      status,
      finalUrl: finalUrl.href,
      finalHostname: finalUrl.hostname,
      redirected,
      evidence,
    };
  } catch (err) {
    return {
      ...base,
      healthy: false,
      error: err.message,
      status: err.status || null,
      finalUrl: err.finalUrl ? err.finalUrl.href : null,
      finalHostname: err.finalUrl ? err.finalUrl.hostname : null,
      redirected: false,
      evidence: [],
    };
  }
}

/* ════════════════════════════════════
   Previous-state comparison (hidden issue marker)
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

function buildStateSnapshot(generatedAt, groupResults) {
  const groups = {};
  for (const result of groupResults) {
    groups[result.canonicalEmployerKey] = {
      healthy: result.healthy,
      finalHostname: result.finalHostname,
      observedPlatforms: result.evidence.filter((e) => e.tier === "observed").map((e) => e.platform),
    };
  }
  return { generatedAt, groups };
}

function findFindings(groupResults, candidatesByKey, previousState) {
  const previousGroups = (previousState && previousState.groups) || {};
  const findings = {
    startedFailing: [],
    redirectChanged: [],
    newAtsEvidence: [],
    platformChanged: [],
    notVerifiedNowExposesAts: [],
    leverGreenhouseCandidates: [],
  };

  for (const result of groupResults) {
    const previous = previousGroups[result.canonicalEmployerKey];
    const candidates = candidatesByKey.get(result.canonicalEmployerKey) || [];
    const observedPlatforms = result.evidence.filter((e) => e.tier === "observed").map((e) => e.platform);

    if (previous) {
      if (previous.healthy === true && result.healthy === false) {
        findings.startedFailing.push(result);
      }
      if (
        previous.finalHostname &&
        result.finalHostname &&
        previous.finalHostname !== result.finalHostname
      ) {
        findings.redirectChanged.push({ result, previousHostname: previous.finalHostname });
      }
      const previousPlatforms = new Set(previous.observedPlatforms || []);
      for (const platform of observedPlatforms) {
        if (!previousPlatforms.has(platform)) {
          findings.newAtsEvidence.push({ result, platform });
        }
      }
      const currentPlatforms = new Set(observedPlatforms);
      for (const platform of previous.observedPlatforms || []) {
        if (!currentPlatforms.has(platform)) {
          findings.platformChanged.push({ result, previousPlatform: platform, changeType: "no longer observed" });
        }
      }
    }

    for (const candidate of candidates) {
      if (candidate.researchStatus === "investigate" && observedPlatforms.length > 0) {
        findings.notVerifiedNowExposesAts.push({ result, candidate, platforms: observedPlatforms });
      }
      if (
        candidate.expectedPlatform &&
        observedPlatforms.length > 0 &&
        !observedPlatforms.includes(candidate.expectedPlatform)
      ) {
        findings.platformChanged.push({
          result,
          previousPlatform: candidate.expectedPlatform,
          changeType: "differs from expectedPlatform",
          observedPlatforms,
        });
      }
    }

    for (const platform of observedPlatforms) {
      if (platform === "Lever" || platform === "Greenhouse") {
        const alreadyHandled = candidates.some((c) => c.researchStatus === "live" || c.researchStatus === "monitored");
        if (!alreadyHandled) {
          findings.leverGreenhouseCandidates.push({ result, platform });
        }
      }
    }
  }

  const hasMeaningfulChange =
    findings.newAtsEvidence.length > 0 ||
    findings.platformChanged.length > 0 ||
    findings.redirectChanged.length > 0 ||
    (findings.startedFailing.length > 0 ||
      groupResults.some((r) => {
        const previous = previousGroups[r.canonicalEmployerKey];
        return previous && previous.healthy === false && r.healthy === true;
      })) ||
    findings.leverGreenhouseCandidates.length > 0;

  return { findings, hasMeaningfulChange };
}

/* ════════════════════════════════════
   Report rendering
═══════════════════════════════════ */

function renderReportMarkdown(report) {
  const { generatedAt, groupResults, candidatesByKey, findings, registry } = report;
  const lines = [];

  lines.push(`# Monthly ATS Source Research`);
  lines.push("");
  lines.push(
    `This report distinguishes four separate stages, and finding evidence at one stage never implies the next: **observed ATS evidence** (this checker found a link/hostname match) → **technically validated source** (a human manually confirmed the endpoint returns real, current, relevant data) → **weekly monitored feed** (added to \`monitoring/employer-feed-watch.json\`) → **live WorkJax feed** (a human-reviewed entry in \`live-opportunity-sources.js\`). This process does not publish anything and does not add or modify any monitored or live feed.`
  );
  lines.push("");
  lines.push(`**Last checked:** ${generatedAt}`);

  const totalEmployers = registry.candidates.length;
  const enabledCandidates = registry.candidates.filter((c) => c.enabled);
  const healthyGroups = groupResults.filter((r) => r.healthy);
  const failedGroups = groupResults.filter((r) => !r.healthy);
  const redirectedGroups = groupResults.filter((r) => r.redirected);

  lines.push(`**Total employers reviewed:** ${totalEmployers} (${enabledCandidates.length} enabled, ${totalEmployers - enabledCandidates.length} disabled/manual-only)`);
  lines.push(`**Careers pages checked (deduplicated):** ${groupResults.length}`);
  lines.push("");

  lines.push(`## Healthy official careers pages`);
  if (healthyGroups.length === 0) {
    lines.push(`None — every checked careers page failed this run.`);
  } else {
    for (const r of healthyGroups) {
      lines.push(`- ${r.employerNames.join(" / ")} (employer id ${r.employerIds.join(", ")}) — HTTP ${r.status} at \`${r.finalHostname}\``);
    }
  }
  lines.push("");

  lines.push(`## Careers URLs that failed`);
  if (failedGroups.length === 0) {
    lines.push(`None — every checked careers page responded successfully. A failure is treated as a warning, not proof an employer has no ATS.`);
  } else {
    for (const r of failedGroups) {
      lines.push(`- ${r.employerNames.join(" / ")} (employer id ${r.employerIds.join(", ")}) — \`${r.originalUrl}\`: ${r.error}`);
    }
  }
  lines.push("");

  lines.push(`## Careers URLs that redirected`);
  if (redirectedGroups.length === 0) {
    lines.push(`None — every checked careers page loaded without an unexpected redirect.`);
  } else {
    for (const r of redirectedGroups) {
      lines.push(`- ${r.employerNames.join(" / ")} (employer id ${r.employerIds.join(", ")}) — \`${r.originalUrl}\` → \`${r.finalUrl}\``);
    }
  }
  lines.push("");

  lines.push(`## Existing platform observations`);
  const observedGroups = groupResults.filter((r) => r.evidence.some((e) => e.tier === "observed"));
  if (observedGroups.length === 0) {
    lines.push(`No group's official page directly exposed a recognized ATS link this run.`);
  } else {
    for (const r of observedGroups) {
      const observed = r.evidence.filter((e) => e.tier === "observed");
      for (const e of observed) {
        lines.push(`- ${r.employerNames.join(" / ")} (employer id ${r.employerIds.join(", ")}) — **observed** ${e.platform}: ${e.detail}`);
      }
      const possible = r.evidence.filter((e) => e.tier === "possible");
      for (const e of possible) {
        lines.push(`- ${r.employerNames.join(" / ")} (employer id ${r.employerIds.join(", ")}) — **possible / manual review required** ${e.platform}: ${e.detail}`);
      }
    }
  }
  lines.push("");

  lines.push(`## Newly detected ATS evidence`);
  if (findings.newAtsEvidence.length === 0) {
    lines.push(`None since the previous report.`);
  } else {
    for (const item of findings.newAtsEvidence) {
      lines.push(`- ${item.result.employerNames.join(" / ")} (employer id ${item.result.employerIds.join(", ")}) — newly observed **${item.platform}**`);
    }
  }
  lines.push("");

  lines.push(`## Employers whose observed platform changed`);
  if (findings.platformChanged.length === 0) {
    lines.push(`None since the previous report.`);
  } else {
    for (const item of findings.platformChanged) {
      if (item.changeType === "differs from expectedPlatform") {
        lines.push(
          `- ${item.result.employerNames.join(" / ")} (employer id ${item.result.employerIds.join(", ")}) — observed [${item.observedPlatforms.join(", ")}], expected \`${item.previousPlatform}\` — **platform mismatch, needs review**`
        );
      } else {
        lines.push(`- ${item.result.employerNames.join(" / ")} (employer id ${item.result.employerIds.join(", ")}) — \`${item.previousPlatform}\` is ${item.changeType} vs. the previous report`);
      }
    }
  }
  lines.push("");

  lines.push(`## Lever or Greenhouse candidates requiring validation`);
  if (findings.leverGreenhouseCandidates.length === 0) {
    lines.push(`None this run.`);
  } else {
    for (const item of findings.leverGreenhouseCandidates) {
      lines.push(
        `- ${item.result.employerNames.join(" / ")} (employer id ${item.result.employerIds.join(", ")}) — observed **${item.platform}**, not yet technically validated or connected to any feed. Follow the promotion steps in docs/operations/monthly-ats-discovery.md before any implementation.`
      );
    }
  }
  lines.push("");

  lines.push(`## NOT VERIFIED employers requiring manual research`);
  const investigateCandidates = registry.candidates.filter((c) => c.researchStatus === "investigate");
  if (investigateCandidates.length === 0) {
    lines.push(`None.`);
  } else {
    for (const c of investigateCandidates) {
      const result = groupResults.find((r) => r.canonicalEmployerKey === c.canonicalEmployerKey);
      const observed = result ? result.evidence.filter((e) => e.tier === "observed").map((e) => e.platform) : [];
      const statusNote = observed.length > 0 ? ` — **now shows evidence of ${observed.join(", ")}, see above**` : "";
      lines.push(`- ${c.employerName} (employer id ${c.employerId}) — \`${c.careersUrl}\`${statusNote}`);
    }
  }
  lines.push("");

  lines.push(`## Manual-only employers`);
  const manualOnlyCandidates = registry.candidates.filter((c) => c.researchStatus === "manual_only");
  if (manualOnlyCandidates.length === 0) {
    lines.push(`None.`);
  } else {
    for (const c of manualOnlyCandidates) {
      lines.push(`- ${c.employerName} (employer id ${c.employerId}) — confirmed no ATS / manual application process. ${c.enabled ? "" : "Not checked this run (disabled)."}`);
    }
  }
  lines.push("");

  lines.push(`## Recommended next actions`);
  const followUps = [];
  if (findings.notVerifiedNowExposesAts.length > 0) {
    for (const item of findings.notVerifiedNowExposesAts) {
      followUps.push(
        `${item.result.employerNames.join(" / ")} (employer id ${item.result.employerIds.join(", ")}) is currently \`investigate\` (NOT VERIFIED) but now shows **observed** evidence of ${item.platforms.join(", ")} — a human should review \`monitoring/ats-research-candidates.json\` and update its \`researchStatus\`/\`expectedPlatform\` if confirmed.`
      );
    }
  }
  if (findings.leverGreenhouseCandidates.length > 0) {
    followUps.push(`Review the Lever/Greenhouse candidate(s) above for technical validation, following docs/integrations/dnb-lever-poc.md's rigor — do not add a feed or endpoint automatically.`);
  }
  if (failedGroups.length > 0) {
    followUps.push(`Investigate the failing careers URL(s) above — confirm whether the page moved, or is only temporarily unreachable.`);
  }
  if (findings.platformChanged.some((i) => i.changeType === "differs from expectedPlatform")) {
    followUps.push(`Reconcile the platform mismatch(es) above with \`expectedPlatform\` in the registry.`);
  }
  if (followUps.length === 0) {
    followUps.push(`No action needed this run.`);
  }
  for (const followUp of followUps) lines.push(`- ${followUp}`);

  return lines.join("\n");
}

function renderIssueBody(report) {
  const markdown = renderReportMarkdown(report);
  const snapshot = buildStateSnapshot(report.generatedAt, report.groupResults);
  return `${markdown}\n\n${STATE_MARKER_START}\n${JSON.stringify(snapshot)}\n${STATE_MARKER_END}\n`;
}

function renderChangeComment(report) {
  const { findings, generatedAt } = report;
  const lines = [`Monthly ATS discovery update — ${generatedAt}`, ""];
  for (const item of findings.newAtsEvidence) {
    lines.push(`- New ATS evidence: ${item.result.employerNames.join(" / ")} — observed **${item.platform}**`);
  }
  for (const item of findings.platformChanged) {
    if (item.changeType === "differs from expectedPlatform") {
      lines.push(`- Platform mismatch: ${item.result.employerNames.join(" / ")} — observed [${item.observedPlatforms.join(", ")}], expected \`${item.previousPlatform}\``);
    } else {
      lines.push(`- Platform change: ${item.result.employerNames.join(" / ")} — \`${item.previousPlatform}\` is ${item.changeType}`);
    }
  }
  for (const item of findings.redirectChanged) {
    lines.push(`- Careers URL redirect changed: ${item.result.employerNames.join(" / ")} — now redirects to \`${item.result.finalHostname}\` (was \`${item.previousHostname}\`)`);
  }
  for (const item of findings.leverGreenhouseCandidates) {
    lines.push(`- New Lever/Greenhouse candidate: ${item.result.employerNames.join(" / ")} — observed **${item.platform}**`);
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
      "User-Agent": "workjax-monthly-ats-discovery",
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

async function runChecks(registry) {
  const generatedAt = new Date().toISOString();
  const enabledCandidates = registry.candidates.filter((c) => c.enabled);
  const groups = buildFetchGroups(enabledCandidates);

  const groupResults = await runWithConcurrency(groups, CONCURRENCY_LIMIT, (group) => checkGroup(group, generatedAt));

  const candidatesByKey = new Map();
  for (const candidate of registry.candidates) {
    if (!candidatesByKey.has(candidate.canonicalEmployerKey)) candidatesByKey.set(candidate.canonicalEmployerKey, []);
    candidatesByKey.get(candidate.canonicalEmployerKey).push(candidate);
  }

  return { generatedAt, groupResults, candidatesByKey };
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

  let generatedAt;
  let groupResults;
  let candidatesByKey;
  try {
    ({ generatedAt, groupResults, candidatesByKey } = await runChecks(registry));
  } catch (err) {
    console.error(`Unexpected failure while running checks: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const { findings, hasMeaningfulChange } = findFindings(groupResults, candidatesByKey, previousState);
  const report = { generatedAt, groupResults, candidatesByKey, findings, registry };

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
        if (hasMeaningfulChange) {
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

  const enabledCount = registry.candidates.filter((c) => c.enabled).length;
  const anyHealthy = groupResults.some((r) => r.healthy);
  if (enabledCount > 0 && !anyHealthy) {
    console.error("Every enabled candidate failed this run.");
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
}

main().catch((err) => {
  console.error("Unexpected failure while checking ATS sources:", err);
  process.exitCode = 1;
});
