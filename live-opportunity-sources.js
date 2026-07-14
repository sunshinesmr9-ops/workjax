/* ════════════════════════════════════
   LIVE OPPORTUNITY SOURCE REGISTRY
   Defines which employers may show a live, employer-sourced opportunity
   feed on their existing detail page, and where that feed comes from.
   Matching is always by stable employerId — never by employer display name.
   See docs/integrations/employer-feed-registry.md.
═══════════════════════════════════ */
window.LIVE_OPPORTUNITY_SOURCES = Object.freeze([
  Object.freeze({
    employerId: 41,
    employerName: "Dun & Bradstreet",
    provider: "lever",
    endpoint: "/api/dnb-lever-jobs",
    sourceLabel: "Live from employer",
    enabled: true
  })
]);
