// Card pool-review-3: the gate on Slither's report for the EVM pool (CI job slither, not a required check). It reads
// Slither's --json report and contracts/pool-evm/slither/triage.json and fails on:
//  - a High or Medium hit the triage file does not list (each printed as the entry to add, with Slither's own words);
//  - a triage entry that matches no hit in the report (the file lists what Slither reports, nothing gone);
//  - a triage entry with no reason, or an impact that is not the hit's;
//  - a report that is not a finished run (success false, or no results).
// A hit is keyed by its detector, the file of its first element and that element's name (with its function for a node),
// so a line moving does not unlist it and a new hit in the same function under another detector is new.
//   node scripts/ci/slither-gate.mjs <slither.json> [triage.json]      (exit 1 and one line per refusal)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GATED = new Set(["High", "Medium"]);

/** The key of one hit: detector, file and element, as a triage entry names them. */
export function hitKey(d) {
  const e = d.elements?.[0] ?? {};
  const parent = e.type === "node" ? e.type_specific_fields?.parent?.name : undefined;
  return {
    check: d.check,
    file: e.source_mapping?.filename_relative ?? "",
    element: parent ? `${parent}: ${e.name}` : (e.name ?? ""),
  };
}

const same = (a, b) => a.check === b.check && a.file === b.file && a.element === b.element;

/** Slither's report against the triage: { refusals, hits } */
export function gate(report, triage) {
  const out = [];
  if (report?.success !== true || !report.results || typeof report.results !== "object") {
    return { refusals: [`the report is not a finished Slither run (success ${report?.success}, error ${JSON.stringify(report?.error ?? null)})`], hits: [] };
  }
  const hits = (report.results.detectors ?? []).map((d) => ({ ...hitKey(d), impact: d.impact, confidence: d.confidence, description: (d.description ?? "").trim() }));
  const entries = triage?.findings;
  if (!Array.isArray(entries)) return { refusals: ["the triage file has no findings list"], hits };
  for (const t of entries) {
    if (typeof t.reason !== "string" || t.reason.trim().length < 10) out.push(`triage entry ${JSON.stringify(t)} has no reason`);
    const h = hits.find((x) => same(x, t));
    if (!h) out.push(`triage entry ${t.check} ${t.file} ${t.element} matches no hit in the report: remove it`);
    else if (t.impact !== h.impact) out.push(`triage entry ${t.check} ${t.file} ${t.element} says ${t.impact}, Slither says ${h.impact}`);
  }
  for (const h of hits) {
    if (!GATED.has(h.impact) || entries.some((t) => same(h, t))) continue;
    const entry = { check: h.check, impact: h.impact, file: h.file, element: h.element, reason: "<why it is accepted, or the fix>" };
    out.push(`untriaged ${h.impact} hit (${h.confidence} confidence): ${h.description.split("\n")[0]}\n  add to triage.json once read: ${JSON.stringify(entry)}`);
  }
  return { refusals: out, hits };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [reportPath, triagePath = "contracts/pool-evm/slither/triage.json"] = process.argv.slice(2);
  if (!reportPath) {
    console.error("usage: node scripts/ci/slither-gate.mjs <slither.json> [triage.json]");
    process.exit(2);
  }
  const { refusals, hits } = gate(JSON.parse(readFileSync(reportPath, "utf8")), JSON.parse(readFileSync(triagePath, "utf8")));
  const by = {};
  for (const h of hits) by[h.impact] = (by[h.impact] ?? 0) + 1;
  console.log(`slither-gate: ${hits.length} hits (${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(", ") || "none"})`);
  for (const h of hits) console.log(`  ${h.impact}/${h.confidence} ${h.check} ${h.file} ${h.element}`);
  for (const r of refusals) console.error(`slither-gate: REFUSED: ${r}`);
  if (refusals.length) process.exit(1);
  console.log("slither-gate: every High and Medium hit is triaged, and every triage entry is a hit");
}
