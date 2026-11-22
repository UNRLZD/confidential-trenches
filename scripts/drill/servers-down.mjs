#!/usr/bin/env node
// The unplug drill's check that every server of ours is off (card helper-unplug-off; markets.md H3.7 row M4.5, vault.md
// VT-R03), read from outside after apps/helper/deploy/unplug.sh off:
//   node scripts/drill/servers-down.mjs [--helper <host>] [--record <file>]     reads the hosts now
//   node scripts/drill/servers-down.mjs --dry <answers.json>                     judges a recorded read
// The helper's host (the API proxy, the market data, the relayers and the order sender, behind Caddy, which answers it
// directly: no proxy in front) is read three ways: a TCP connection to 443 and to 80, and GET https://<host>/v1/health.
// It is off only when none of the three is answered: a refused or timed-out connection, and no HTTP answer at all.
// This replaces the paper's "its DNS name removed" (markets.md l.1542): with nothing answering on the name, a removed
// name proves nothing more. APP_HOST and SIGN_HOST are static files on Cloudflare Pages, with no code of ours on a
// server: each is read (HEAD /) and reported, never judged, and the drill's net guard (net-guard.mjs) refuses them.
// --helper reads another host (the local proof's 127.0.0.1, with --http-port and --https-port). PASS exit 0, FAIL exit
// 1, error exit 2; one line per read and one per verdict. It prints hosts and outcomes, never an address it resolved.
import "../net-window.mjs";
import net from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const HELPER_HOST = "ct-api.unrealized.trade";
export const STATIC_HOSTS = Object.freeze(["ct-app.unrealized.trade", "confidential.unrealized.trade"]);
/** How long one read waits for an answer. [design: the live checks' connect window (net-window.mjs, 2 s) and a health
 *  answer's few hundred ms, doubled; a host that is off refuses at once or never answers, either is "no answer".] */
export const READ_MS = 5_000;

/** One TCP connection: "open" when the host took it, else "refused", "timeout" or the error's code. */
export function tcp(host, port, ms = READ_MS) {
  return new Promise((done) => {
    const s = net.connect({ host, port });
    const end = (v) => (s.destroy(), done(v));
    s.setTimeout(ms, () => end("timeout"));
    s.once("connect", () => end("open"));
    s.once("error", (e) => end(e.code === "ECONNREFUSED" ? "refused" : String(e.code ?? "error")));
  });
}

/** One HTTP read: its status, or the error's name when nothing answered. */
async function http(url, method, fetchFn = fetch, ms = READ_MS) {
  try {
    const r = await fetchFn(url, { method, redirect: "manual", signal: AbortSignal.timeout(ms) });
    await r.body?.cancel().catch(() => undefined);
    return { status: r.status };
  } catch (e) {
    return { status: null, error: String(e?.cause?.code ?? e?.name ?? "error") };
  }
}

/** Reads every host of ours now. */
export async function read({ helper = HELPER_HOST, httpPort = 80, httpsPort = 443, scheme = "https", fetchFn = fetch } = {}) {
  const health = `${scheme}://${helper}${scheme === "https" && httpsPort === 443 ? "" : `:${scheme === "https" ? httpsPort : httpPort}`}/v1/health`;
  const [t443, t80, h] = await Promise.all([tcp(helper, httpsPort), tcp(helper, httpPort), http(health, "GET", fetchFn)]);
  const statics = await Promise.all(STATIC_HOSTS.map(async (host) => ({ host, ...(await http(`https://${host}/`, "HEAD", fetchFn)) })));
  return { at: new Date().toISOString(), helper: { host: helper, tcp: { [httpsPort]: t443, [httpPort]: t80 }, health: h }, statics };
}

/** PASS or FAIL with one line per read: the helper's host off on every read, the static hosts reported only. */
export function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok" : "BAD"} ${text}`);
  const hp = r?.helper;
  if (hp === null || typeof hp !== "object" || typeof hp.tcp !== "object" || hp.tcp === null || typeof hp.health !== "object" || hp.health === null) {
    return { pass: false, lines: ["BAD nothing to judge: no helper read"] };
  }
  const ports = Object.entries(hp.tcp);
  if (ports.length < 2) say(false, `the helper's host read on ${ports.length} port(s), want 80 and 443`);
  for (const [port, v] of ports) say(v !== "open", `${hp.host}:${port} ${v === "open" ? "took a connection" : `answered nothing (${v})`}`);
  const h = hp.health;
  say(h.status === null || h.status === undefined, `${hp.host}/v1/health ${h.status == null ? `answered nothing (${h.error ?? "no answer"})` : `answered ${h.status}`}`);
  for (const s of Array.isArray(r.statics) ? r.statics : []) lines.push(`-- ${s.host} ${s.status == null ? `answered nothing (${s.error ?? "no answer"})` : `answered ${s.status}`} (static files on Cloudflare Pages, reported only)`);
  return { pass: !lines.some((l) => l.startsWith("BAD")), lines };
}

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv[i + 1];
  };
  try {
    let r;
    const dry = arg("--dry");
    if (dry !== undefined) r = JSON.parse(readFileSync(dry, "utf8"));
    else {
      const helper = arg("--helper") ?? HELPER_HOST;
      const httpPort = Number(arg("--http-port") ?? 80);
      const httpsPort = Number(arg("--https-port") ?? 443);
      if (!/^[a-z0-9.-]{1,253}$/i.test(helper) || ![httpPort, httpsPort].every((p) => Number.isInteger(p) && p > 0 && p < 65536)) throw new Error("a bad --helper or port");
      r = await read({ helper, httpPort, httpsPort, scheme: helper === HELPER_HOST ? "https" : "http" });
      const rec = arg("--record");
      if (rec !== undefined) writeFileSync(rec, `${JSON.stringify(r, null, 2)}\n`);
    }
    const v = judge(r);
    for (const l of v.lines) console.log(l);
    console.log(`servers-down: ${v.pass ? "PASS" : "FAIL"} (${r?.helper?.host ?? "no host"})`);
    return v.pass ? 0 : 1;
  } catch (e) {
    console.log(`servers-down: ERROR ${e.message}`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
