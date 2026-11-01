#!/usr/bin/env node
// Writes the README's performance table and docs/performance.md from the run records in perf/runs/*.json, so no
// number in either is typed by hand.
//   node scripts/perf-table.mjs                 write docs/performance.md and the README block between the markers
//   node scripts/perf-table.mjs --check         exit 1 when either file differs from what the records make
//   node scripts/perf-table.mjs --print-readme  print the README block only
// Every record is read as hostile input: an unknown field value, a bad transaction id or a bad number stops the run
// with the file and the reason. Explorer links are built here from the chain, the network and the id, never taken
// from a record.
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const BEGIN = "<!-- perf-table:begin (made by scripts/perf-table.mjs from perf/runs; do not edit by hand) -->";
export const END = "<!-- perf-table:end -->";

const CHAINS = { solana: "Solana", base: "Base", robinhood: "Robinhood", near: "NEAR" };
const NETWORKS = ["mainnet", "testnet", "devnet", "sandbox", "device"];
const SIGNERS = { phone: "phone browser", script: "test script", none: "-" };
// step: label, metric: what the value is, unit
const STEPS = {
  buy: { label: "Buy", metric: "tap to filled", unit: "ms" },
  sell: { label: "Sell", metric: "tap to filled", unit: "ms" },
  hop: { label: "Hop between chains (Relay)", metric: "request to arrival", unit: "ms" },
  "intents-in": { label: "Money in to NEAR Intents", metric: "request to visible", unit: "ms" },
  "intents-out": { label: "Money out to a fresh wallet (NEAR Intents)", metric: "request to visible", unit: "ms" },
  "proof-withdraw": { label: "Withdraw proof on a phone", metric: "proof time", unit: "ms" },
  "proof-commitment": { label: "Commitment proof on a phone", metric: "proof time", unit: "ms" },
  "vault-withdraw-gas": { label: "Vault withdraw, the vault's own gas", metric: "gas", unit: "Tgas" },
  "vault-deposit-gas": { label: "Vault deposit, tree work only", metric: "gas", unit: "Tgas" },
};
const FEE_UNITS = { lamports: [1e9, "SOL"], wei: [1e18, "ETH"], yocto: [1e24, "NEAR"], usd: [1, "USD"] };
const TX_FORMAT = {
  solana: /^[1-9A-HJ-NP-Za-km-z]{64,88}$/,
  base: /^0x[0-9a-f]{64}$/,
  robinhood: /^0x[0-9a-f]{64}$/,
  near: /^[1-9A-HJ-NP-Za-km-z]{43,44}$/,
};
const EXPLORER = {
  "solana/mainnet": (id) => `https://solscan.io/tx/${id}`,
  "base/mainnet": (id) => `https://basescan.org/tx/${id}`,
  "robinhood/mainnet": (id) => `https://robinhoodchain.blockscout.com/tx/${id}`,
  "near/mainnet": (id) => `https://nearblocks.io/txns/${id}`,
  // NearBlocks' testnet index stopped in late September 2026 (its newest tx then is from 2026-09-27, read 2026-10-31),
  // so a testnet tx is shown as its id, to read on a testnet archival RPC.
  "near/testnet": null,
};
const MAX_SAMPLES = 1000;
const MAX_TXS = 20;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE = /^[A-Za-z0-9._/-]{1,200}$/;

const fail = (file, why) => {
  throw new Error(`perf record ${file}: ${why}`);
};
const only = (file, where, obj, keys) => {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) fail(file, `${where} is not an object`);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) fail(file, `${where} has an unknown field "${k}"`);
};

// One record, checked field by field. Returns it unchanged when it passes.
export function checkRecord(r, file = "record") {
  only(file, "the record", r, ["schema", "id", "chain", "network", "signer", "date", "source", "note", "series"]);
  if (r.schema !== "perf-run/1") fail(file, `schema must be "perf-run/1"`);
  if (typeof r.id !== "string" || !ID.test(r.id)) fail(file, "id must be lower-case letters, digits and dashes");
  if (!(r.chain in CHAINS)) fail(file, `chain "${r.chain}" is not one of ${Object.keys(CHAINS).join(", ")}`);
  if (!NETWORKS.includes(r.network)) fail(file, `network "${r.network}" is not one of ${NETWORKS.join(", ")}`);
  if (!(r.signer in SIGNERS)) fail(file, `signer "${r.signer}" is not one of ${Object.keys(SIGNERS).join(", ")}`);
  if (typeof r.date !== "string" || !DATE.test(r.date) || Number.isNaN(Date.parse(r.date))) fail(file, "date must be YYYY-MM-DD");
  if (typeof r.source !== "string" || !SOURCE.test(r.source) || r.source.includes("..")) fail(file, "source must be a plain relative path");
  if (r.note !== undefined && (typeof r.note !== "string" || r.note.length > 300 || /[<>\n]/.test(r.note))) fail(file, "note must be one plain line of at most 300 characters");
  if (!Array.isArray(r.series) || r.series.length === 0 || r.series.length > 10) fail(file, "series must hold 1-10 entries");
  for (const [i, s] of r.series.entries()) {
    const at = `series[${i}]`;
    only(file, at, s, ["step", "samples"]);
    if (!(s.step in STEPS)) fail(file, `${at}.step "${s.step}" is not a known step`);
    if (!Array.isArray(s.samples) || s.samples.length === 0 || s.samples.length > MAX_SAMPLES) fail(file, `${at}.samples must hold 1-${MAX_SAMPLES} entries`);
    for (const [j, x] of s.samples.entries()) {
      const sat = `${at}.samples[${j}]`;
      only(file, sat, x, ["ok", "value", "txs", "fee"]);
      if (typeof x.ok !== "boolean") fail(file, `${sat}.ok must be true or false`);
      if (x.ok && !(typeof x.value === "number" && Number.isFinite(x.value) && x.value >= 0 && x.value < 1e7)) fail(file, `${sat}.value must be a finite number from 0 up to 1e7 when ok`);
      if (!x.ok && x.value !== null) fail(file, `${sat}.value must be null when the sample failed`);
      if (!Array.isArray(x.txs) || x.txs.length > MAX_TXS) fail(file, `${sat}.txs must be a list of at most ${MAX_TXS}`);
      for (const [k, t] of x.txs.entries()) {
        only(file, `${sat}.txs[${k}]`, t, ["chain", "network", "id"]);
        if (!(t.chain in TX_FORMAT)) fail(file, `${sat}.txs[${k}].chain "${t.chain}" is not known`);
        if (!NETWORKS.includes(t.network)) fail(file, `${sat}.txs[${k}].network "${t.network}" is not known`);
        if (typeof t.id !== "string" || !TX_FORMAT[t.chain].test(t.id)) fail(file, `${sat}.txs[${k}].id is not a ${t.chain} transaction id`);
        if (!(`${t.chain}/${t.network}` in EXPLORER)) fail(file, `${sat}.txs[${k}] is on ${t.chain} ${t.network}, which has no public reader here`);
      }
      if (x.fee !== undefined) {
        only(file, `${sat}.fee`, x.fee, ["amount", "unit"]);
        if (!(x.fee.unit in FEE_UNITS)) fail(file, `${sat}.fee.unit "${x.fee.unit}" is not known`);
        if (typeof x.fee.amount !== "string" || !/^\d{1,40}(\.\d{1,12})?$/.test(x.fee.amount)) fail(file, `${sat}.fee.amount must be a decimal string`);
      }
    }
  }
  return r;
}

export function loadRuns(dir) {
  if (!existsSync(dir)) throw new Error(`no folder ${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`no run records in ${dir}`);
  const ids = new Set();
  return files.map((f) => {
    let r;
    try {
      r = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch (e) {
      fail(f, `not JSON (${e.message})`);
    }
    checkRecord(r, f);
    if (ids.has(r.id)) fail(f, `id ${r.id} is used twice`);
    ids.add(r.id);
    return r;
  });
}

// Nearest rank: sort ascending, take rank ceil(p/100 x n). A failed sample counts as infinitely slow.
export function nearestRank(values, p) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(1, Math.ceil((p / 100) * s.length)) - 1];
}

export function stats(series) {
  const v = series.samples.map((x) => (x.ok ? x.value : Infinity));
  return { n: v.length, ok: series.samples.filter((x) => x.ok).length, p50: nearestRank(v, 50), p95: nearestRank(v, 95), max: Math.max(...v) };
}

// Seconds for the README: a p50 to the nearest 0.1 s, a p95 or a max always up, never down.
const sec = (ms, up) => (ms === Infinity ? "failed" : `${((up ? Math.ceil(ms / 100 - 1e-9) : Math.round(ms / 100)) / 10).toFixed(1)} s`);
const fmt = (v, unit) => (v === Infinity ? "failed" : unit === "Tgas" ? `${v.toFixed(3)} Tgas` : `${Math.round(v).toLocaleString("en-US")} ms`);
const cell = (st, unit) => (st.n === 1 ? fmt(st.p50, unit) : `${fmt(st.p50, unit)} / ${fmt(st.p95, unit)}`);

function feeText(series) {
  const fees = series.samples.filter((x) => x.fee);
  if (fees.length === 0) return "-";
  const units = new Set(fees.map((x) => x.fee.unit));
  if (units.size !== 1) return "mixed units";
  const [div, name] = FEE_UNITS[fees[0].fee.unit];
  const vals = fees.map((x) => Number(x.fee.amount) / div);
  const p50 = nearestRank(vals, 50);
  const shown = name === "USD" ? p50.toFixed(4) : p50 === 0 ? "0" : p50.toPrecision(3);
  return `${shown} ${name} median (n=${fees.length})`;
}

const order = (r) => [Object.keys(CHAINS).indexOf(r.chain), NETWORKS.indexOf(r.network), r.signer === "phone" ? 0 : 1, r.date];
const byOrder = (a, b) => {
  const x = order(a), y = order(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};

export function renderReadme(runs) {
  const rows = [];
  // per chain: the steps in STEPS order, then a phone run before a script run
  const items = runs.flatMap((r) => r.series.map((s) => ({ r, s })));
  const key = ({ r, s }) => [Object.keys(CHAINS).indexOf(r.chain), Object.keys(STEPS).indexOf(s.step), r.signer === "phone" ? 0 : 1, r.date];
  items.sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; });
  for (const { r, s } of items) {
    {
      const st = stats(s);
      const step = STEPS[s.step];
      const time = step.unit === "Tgas" ? `up to ${fmt(st.max, "Tgas")}` : st.n === 1 ? sec(st.p50, true) : `${sec(st.p50, false)} / ${sec(st.p95, true)}`;
      rows.push(`| ${CHAINS[r.chain]} | ${step.label} | ${time} | ${st.ok} of ${st.n} | ${r.network}, ${SIGNERS[r.signer]} | [${r.id}](docs/performance.md#${r.id}) |`);
    }
  }
  return [
    BEGIN,
    "| Chain | What | Median / p95 | Filled | Where, signed by | Every transaction |",
    "|---|---|---|---|---|---|",
    ...rows,
    END,
  ].join("\n");
}

export function renderDoc(runs) {
  const out = [
    "# Performance",
    "",
    "This page lists every run we have recorded, with each sample and a link to each of its transactions.",
    "`scripts/perf-table.mjs` rebuilds it and the README table from `perf/runs/*.json`, so a number here changes only",
    "when a new run record lands. Do not edit it by hand.",
    "",
    "p50 and p95 are nearest rank: sort the samples, take the one at rank ceil(p/100 x n). A failed sample counts as",
    "infinitely slow, so it is in n and never improves a percentile.",
    "",
  ];
  for (const r of [...runs].sort(byOrder)) {
    out.push(`## ${r.id}`, "");
    out.push(`${CHAINS[r.chain]}, ${r.network}, ${r.date}, signed by: ${SIGNERS[r.signer]}. Record: \`${r.source}\`.`);
    if (r.note) out.push("", r.note);
    out.push("", "| What | Measures | n | ok | p50 / p95 | max | Fee per sample |", "|---|---|---|---|---|---|---|");
    for (const s of r.series) {
      const st = stats(s);
      const step = STEPS[s.step];
      out.push(`| ${step.label} | ${step.metric} | ${st.n} | ${st.ok} | ${cell(st, step.unit)} | ${fmt(st.max, step.unit)} | ${feeText(s)} |`);
    }
    out.push("");
    for (const s of r.series) {
      const withTx = s.samples.filter((x) => x.txs.length);
      if (withTx.length === 0) continue;
      out.push(`${STEPS[s.step].label}, every sample:`, "");
      for (const [i, x] of s.samples.entries()) {
        const links = x.txs.map((t) => { const url = EXPLORER[`${t.chain}/${t.network}`]; return url ? `[${t.id.slice(0, 10)}…](${url(t.id)})` : `\`${t.id}\` (${t.chain} ${t.network}, no explorer index)`; }).join(", ");
        out.push(`${i + 1}. ${x.ok ? fmt(x.value, STEPS[s.step].unit) : "failed"}${links ? `: ${links}` : ""}`);
      }
      out.push("");
    }
  }
  return out.join("\n");
}

export function replaceBlock(readme, block) {
  const a = readme.indexOf(BEGIN), b = readme.indexOf(END);
  if (a < 0 || b < 0 || b < a) throw new Error("README.md has no perf-table block: put the begin and end marker lines where the table goes");
  if (readme.indexOf(BEGIN, a + 1) >= 0) throw new Error("README.md has two perf-table blocks");
  return readme.slice(0, a) + block + readme.slice(b + END.length);
}

function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const runs = loadRuns(join(root, "perf/runs"));
  const block = renderReadme(runs);
  if (argv.includes("--print-readme")) return void console.log(block);
  const docPath = join(root, "docs/performance.md");
  const readmePath = join(root, "README.md");
  const doc = renderDoc(runs);
  const readme = replaceBlock(readFileSync(readmePath, "utf8"), block);
  if (argv.includes("--check")) {
    const stale = [];
    if (!existsSync(docPath) || readFileSync(docPath, "utf8") !== doc) stale.push("docs/performance.md");
    if (readFileSync(readmePath, "utf8") !== readme) stale.push("README.md");
    if (stale.length) {
      console.error(`perf-table: ${stale.join(" and ")} differ from perf/runs; run node scripts/perf-table.mjs`);
      process.exit(1);
    }
    return void console.log(`perf-table: README.md and docs/performance.md match ${runs.length} run records`);
  }
  writeFileSync(docPath, doc);
  writeFileSync(readmePath, readme);
  console.log(`perf-table: wrote README.md and docs/performance.md from ${runs.length} run records`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
