// The exit tool's live read of the deployed Solana pools (card exit-pool-notes), run by
// scripts/live-checks/exit-pool-notes.mjs as its own process: a live check outside packages/ may import only the kit's
// public entry, so it runs the tool as a user does. For each cluster's pool (src/sol-rpc.ts EXIT_SOL_CLUSTERS), the
// tool's own scan (src/sol-scan.ts exitSolScan) with the wallet's A.8 test words (public, holding nothing) on the
// release's lister and two RPCs. One line per finding ("ok   ..." or "FAIL ..."), then PASS or FAIL.
//   node packages/exit/scripts/sol-live.ts [--record <file>] [--replay <answers.json> [--bad <json>]]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every RPC answer read to <file>; --replay answers every call from a recorded file instead of the
// network (getMultipleAccounts from every account it holds, any other call by its exact params), and --bad plants one
// lie in it (flip: a mark's other bytes on one RPC; hide: a mark the lister leaves out; drop: a listed mark one RPC
// lacks; fake: an address the lister makes up; refuse: a lister that refuses getProgramAccounts), for the live
// check's test.
import { readFileSync, writeFileSync } from "node:fs";
import { EXIT_SOL_CLUSTERS, type ExitSolCluster } from "../src/sol-rpc.ts";
import { exitSolScan, solScanAtGap } from "../src/sol-scan.ts";

/** The wallet's A.8 vector (packages/wallet/test/vectors/a8.json): public test words. */
const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const CLUSTERS: ExitSolCluster[] = ["devnet", "mainnet"];
/** A replay walks 4 indices past each lane's last note, as test/sol-scan.test.ts does: the release's RESTORE_GAP walk
 * takes about 40 s of CPU a cluster, the same on any answers, and the live run keeps it. */
const REPLAY_GAP = 4;

type Answer = { url: string; method: string; params: any[]; status: number; json: any };
type Bad = { kind: "flip" | "hide" | "drop" | "fake" | "refuse"; url: string; address: string | null };

/**
 * A fetch answering from `answers`: getMultipleAccounts from every account the host's answers hold (null for one they
 * never gave), at its highest recorded slot or the minContextSlot asked; any other call by its exact params. `bad`
 * plants one lie.
 */
function replay(answers: Answer[], bad?: Bad): typeof fetch {
  const accounts = new Map<string, Map<string, any>>(); // url -> address -> account
  const slots = new Map<string, number>();
  for (const a of answers) {
    if (a.method !== "getMultipleAccounts" || !a.json?.result) continue;
    const m = accounts.get(a.url) ?? new Map();
    accounts.set(a.url, m);
    slots.set(a.url, Math.max(slots.get(a.url) ?? 0, a.json.result.context.slot));
    a.params[0].forEach((x: string, i: number) => a.json.result.value[i] && m.set(x, a.json.result.value[i]));
  }
  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = new URL(String(url)).href;
    const { id, method, params } = JSON.parse(String(init?.body));
    const reply = (body: object): Response => new Response(JSON.stringify({ jsonrpc: "2.0", id, ...body }), { status: 200 });
    if (method === "getMultipleAccounts") {
      const m = accounts.get(href) ?? new Map();
      const value = params[0].map((x: string) => {
        if (bad?.url === href && bad.address === x && bad.kind === "drop") return null;
        const acc = structuredClone(m.get(x) ?? null);
        if (acc && bad?.url === href && bad.address === x && bad.kind === "flip") {
          const d = Buffer.from(acc.data[0], "base64");
          d[0] ^= 1;
          acc.data[0] = d.toString("base64");
        }
        return acc;
      });
      return reply({ result: { context: { slot: Math.max(slots.get(href) ?? 0, params[1]?.minContextSlot ?? 0) }, value } });
    }
    const a = answers.find((x) => x.url === href && x.method === method && JSON.stringify(x.params) === JSON.stringify(params));
    if (!a) return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -1, message: `no recorded answer for ${method} on ${href}` } }), { status: 200 });
    if (method === "getProgramAccounts" && bad?.url === href) {
      if (bad.kind === "refuse") return reply({ error: { code: -32602, message: "Indexed requests require a personal token" } });
      const r = structuredClone(a.json.result);
      const size = params[1].filters[0].dataSize;
      if (bad.kind === "hide") r.value = r.value.filter((x: { pubkey: string }) => x.pubkey !== bad.address);
      if (bad.kind === "fake" && size === 17 && r.value.length > 0) r.value.push({ pubkey: bad.address, account: r.value[0].account });
      return reply({ result: r });
    }
    return reply({ result: a.json.result });
  }) as typeof fetch;
}

/** Runs the scan on each cluster through `fetchFn`; returns { ok, lines }. */
async function check(fetchFn: typeof fetch, gap?: number): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const say = (pass: boolean, text: string): void => {
    ok &&= pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${text}`);
  };
  for (const cluster of CLUSTERS) {
    const net = EXIT_SOL_CLUSTERS[cluster];
    const hosts = new Set([net.lister, ...net.rpcs].map((u: string) => new URL(u).href));
    const calls: { href: string; method: string; params: unknown[] }[] = [];
    const tap = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = new URL(String(url)).href;
      const { method, params } = JSON.parse(String(init?.body));
      calls.push({ href, method, params });
      return fetchFn(url, init);
    };
    try {
      const args = { words: WORDS, cluster, fetchFn: tap as typeof fetch };
      const r = gap === undefined ? await exitSolScan(args) : await solScanAtGap(args, gap);
      const listed = calls.filter((c) => c.href === net.lister && c.method === "getProgramAccounts");
      say(listed.length > 0, `${cluster}: the lister ${net.lister} listed the marks of ${net.program} in ${listed.length} bucket calls`);
      const gpa = calls.filter((c) => c.method === "getProgramAccounts");
      say(gpa.every((c) => c.href === net.lister), `${cluster}: getProgramAccounts went to the lister alone`);
      // the lister may be one of the two RPCs (it is on both clusters): its listing calls are the ones above
      for (const u of net.rpcs) {
        const reads = calls.filter((c) => c.href === u && c.method !== "getProgramAccounts");
        say(reads.length > 0 && reads.every((c) => c.method === "getMultipleAccounts"), `${cluster}: ${u} read every mark and page by address only (${reads.length} getMultipleAccounts)`);
      }
      say(calls.every((c) => hosts.has(c.href)), `${cluster}: no request left the cluster's lister and two RPCs`);
      say(true, `${cluster}: every listed mark on both RPCs with the same bytes, and the pages count every deposit and release (pool ${r.pool}; the test words hold ${r.notes.length} notes)`);
    } catch (e) {
      say(false, `${cluster}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok, lines };
}


const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const record = arg("--record");
const replayFile = arg("--replay");
const badArg = arg("--bad");
const answers: Answer[] = [];
const recording = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const res = await fetch(url, init);
  const text = await res.text();
  const { method, params } = JSON.parse(String(init?.body));
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  answers.push({ url: new URL(String(url)).href, method, params, status: res.status, json });
  return new Response(text, { status: res.status, headers: res.headers });
}) as typeof fetch;
try {
  const fetchFn = replayFile ? replay((JSON.parse(readFileSync(replayFile, "utf8")) as { good: Answer[] }).good, badArg ? (JSON.parse(badArg) as Bad) : undefined) : recording;
  const r = await check(fetchFn, replayFile ? REPLAY_GAP : undefined);
  for (const l of r.lines) console.log(l);
  if (record) writeFileSync(record, `${JSON.stringify({ recordedAt: new Date().toISOString(), answers })}\n`);
  console.log(r.ok ? "PASS" : "FAIL");
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.stack : e}`);
  process.exit(2);
}
