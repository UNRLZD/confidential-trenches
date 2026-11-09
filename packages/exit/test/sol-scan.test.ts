// Card exit-pool-notes: the exit tool's scan of the Solana pool (src/sol-scan.ts, src/sol-rpc.ts) from the 12 words
// alone. It replays a read of the devnet pool recorded on the release's lister and two RPCs (test/fixtures/devnet-sol.json,
// scripts/record-sol.ts), then plants a lister's and an RPC's lies in it. The words are the wallet's A.8 vector, public
// test words that hold nothing. The wallet's own tests hold the notes the listed read finds
// (packages/wallet/test/pool-solana.test.ts "listed restore").
//   node --test packages/exit/test/sol-scan.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SolanaRpc } from "@blindfill/kit";
import { EXIT_SOL_CLUSTERS, exitSolReads, ExitSolRefused, exitSolRpc } from "../src/sol-rpc.ts";
import { exitSolScan, solScanAtGap } from "../src/sol-scan.ts";
import { replaySolRpc, type SolFile } from "./sol-replay.ts";

const ROOT = new URL("../../../", import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(new URL(p, ROOT), "utf8"));
const F = json("packages/exit/test/fixtures/devnet-sol.json") as SolFile;
const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const GAP = 4;
const base64 = { decode: (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64")), encode: (b: Uint8Array): string => Buffer.from(b).toString("base64") };

type Edit = (method: string, params: readonly unknown[], answer: unknown) => unknown;
type Gma = { context: { slot: number }; value: ({ data: [string, string] } | null)[] };
type Gpa = { context: { slot: number }; value: { pubkey: string }[] };
const reads = (o: { lister?: Edit; rpc0?: Edit; rpc1?: Edit } = {}) => ({
  lister: replaySolRpc(F.lister, o.lister),
  rpcs: [replaySolRpc(F.rpcs[0], o.rpc0), replaySolRpc(F.rpcs[1], o.rpc1)] as [SolanaRpc, SolanaRpc],
});
const scan = (o: Parameters<typeof reads>[0] = {}) => solScanAtGap({ words: WORDS, cluster: "devnet", ...reads(o) }, GAP);
// the marks the recording lists, by size
const listed = (size: number): string[] => [...new Set(F.lister.answers.filter(([k]) => JSON.parse(k)[1][1].filters[0].dataSize === size).flatMap(([, a]) => (a as Gpa).value.map((x) => x.pubkey)))];
const gpaSize = (params: readonly unknown[]): number => (params[1] as { filters: [{ dataSize: number }] }).filters[0].dataSize;

test("each cluster's pool is its deploy record's, and its reads are the release's", () => {
  assert.equal(EXIT_SOL_CLUSTERS.mainnet.program, json("contracts/pool-solana/deployments/mainnet.json").program_id);
  assert.equal(EXIT_SOL_CLUSTERS.devnet.program, json("scripts/live-checks/pool-sol-deploy.devnet.json").program_id);
  assert.equal(F.program, EXIT_SOL_CLUSTERS.devnet.program);
  for (const c of ["mainnet", "devnet"] as const) {
    const r = exitSolReads(c);
    assert.deepEqual([r.rpcs[0].url, r.rpcs[1].url, r.lister.url], [...EXIT_SOL_CLUSTERS[c].rpcs, EXIT_SOL_CLUSTERS[c].lister]);
  }
});

test("the recorded devnet read: the lister only lists, both RPCs read every listed mark and the pages, and the words hold nothing", async () => {
  const log: string[][] = [[], [], []];
  const tap = (k: number): Edit => (m, p, a) => (log[k]!.push(`${m} ${JSON.stringify(p[0])}`), a);
  const r = await scan({ rpc0: tap(0), rpc1: tap(1), lister: tap(2) });
  assert.deepEqual([r.notes, r.spends, r.cluster, r.program, r.pool], [[], [], "devnet", F.program, json("scripts/live-checks/pool-sol-deploy.devnet.json").pool]);
  assert.ok(log[2]!.length > 0 && log[2]!.every((x) => x.startsWith(`getProgramAccounts "${F.program}"`)), "the lister lists");
  const marks = [...listed(13), ...listed(17)];
  assert.ok(listed(13).length > 0 && listed(17).length > 0, "the devnet pool has releases and deposits");
  for (const k of [0, 1]) {
    assert.ok(log[k]!.every((x) => x.startsWith("getMultipleAccounts ")), `rpc ${k} reads accounts by address only`);
    const asked = new Set(log[k]!.flatMap((x) => JSON.parse(x.slice("getMultipleAccounts ".length)) as string[]));
    for (const m of marks) assert.ok(asked.has(m), `rpc ${k} reads listed mark ${m}`);
  }
  // the public entry refuses a gap before any read
  await assert.rejects(exitSolScan({ words: WORDS, cluster: "devnet", gap: 1, ...reads() } as Parameters<typeof exitSolScan>[0]), ExitSolRefused);
});

test("a lister's lies stop the scan: a hidden mark, a made-up address, a moved spent mark, an empty list", async () => {
  const drop = (key: string): Edit => (m, _p, a) => (m === "getProgramAccounts" ? { ...(a as Gpa), value: (a as Gpa).value.filter((x) => x.pubkey !== key) } : a);
  // a hidden deposit or release: the pages on both RPCs count one more
  await assert.rejects(scan({ lister: drop(listed(17)[0]!) }), /the lister listed 10 deposits and 4 releases \(10 label and 14 state leaves\), but rpc 0's pages hold 15 state and 11 label leaves and rpc 1's hold 15 state and 11 label leaves$/);
  await assert.rejects(scan({ lister: drop(listed(13)[0]!) }), /the lister listed 11 deposits and 3 releases \(11 label and 14 state leaves\), but rpc 0's pages hold 15 state and 11 label leaves and rpc 1's hold 15 state and 11 label leaves$/);
  // a made-up address in a bucket, and a spent mark listed at another address in place of its own: neither RPC holds it
  const fake = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const add = (size: number, f: (v: { pubkey: string }[]) => { pubkey: string }[]): Edit => (m, p, a) => (m === "getProgramAccounts" && gpaSize(p) === size ? { ...(a as Gpa), value: f((a as Gpa).value) } : a);
  await assert.rejects(scan({ lister: add(17, (v) => [...v, { pubkey: fake }]) }), new RegExp(`rpc 0: listed mark ${fake} is not on it`));
  await assert.rejects(scan({ lister: add(13, (v) => v.map((x, i) => (i === 0 ? { pubkey: fake } : x))) }), /listed mark \S+ is not on it/);
  // a lister that answers every bucket empty while the pages count 11 deposits and 4 releases
  await assert.rejects(scan({ lister: add(13, () => []) }), /the lister listed 11 deposits and 0 releases \(11 label and 11 state leaves\), but rpc 0's pages hold 15 state and 11 label leaves and rpc 1's hold 15 state and 11 label leaves$/);
  await assert.rejects(scan({ lister: (m, _p, a) => (m === "getProgramAccounts" ? { ...(a as Gpa), value: [] } : a) }), /the lister listed 0 deposits and 0 releases \(0 label and 0 state leaves\), but rpc 0's pages hold 15 state and 11 label leaves and rpc 1's hold 15 state and 11 label leaves$/);
});

test("an RPC's lies stop the scan: a mark's other bytes on one, a short page on both", async () => {
  const mark = listed(13)[0]!;
  const flip: Edit = (m, p, a) => {
    if (m !== "getMultipleAccounts") return a;
    const g = a as Gma;
    (p[0] as string[]).forEach((x, i) => {
      if (x !== mark || !g.value[i]) return;
      const d = base64.decode(g.value[i]!.data[0]);
      d[0]! ^= 1;
      g.value[i]!.data[0] = base64.encode(d);
    });
    return g;
  };
  await assert.rejects(scan({ rpc1: flip }), new RegExp(`listed mark ${mark}: the two RPCs' bytes differ`));
  // the state page one entry short, on both RPCs
  const cut: Edit = (m, _p, a) => {
    if (m !== "getMultipleAccounts") return a;
    for (const acc of (a as Gma).value) {
      if (!acc) continue;
      const d = base64.decode(acc.data[0]);
      if (d.length > 16 + 72 && new TextDecoder().decode(d.subarray(0, 8)) === "bfpage01" && d[8] === 0) acc.data[0] = base64.encode(d.subarray(0, d.length - 72));
    }
    return a;
  };
  await assert.rejects(scan({ rpc0: cut, rpc1: cut }), /the lister listed 11 deposits and 4 releases \(11 label and 15 state leaves\), but rpc 0's pages hold 14 state and 11 label leaves and rpc 1's hold 14 state and 11 label leaves$/);
});

test("the lister's host and one RPC rolling the pool back by one release or deposit stop the scan: the other RPC's pages count it", async () => {
  const markBytes = (key: string): Uint8Array => {
    for (const [k, a] of F.rpcs[1].answers) {
      const [m, p] = JSON.parse(k) as [string, unknown[]];
      if (m !== "getMultipleAccounts") continue;
      const i = (p[0] as string[]).indexOf(key);
      const v = (a as Gma).value[i];
      if (i >= 0 && v) return base64.decode(v.data[0]);
    }
    throw new Error(`no bytes for ${key}`);
  };
  const spent = listed(13).map((k) => ({ k, n: new DataView(markBytes(k).buffer).getUint32(8, true) })).sort((x, y) => x.n - y.n);
  const pre = listed(17).map((k) => ({ k, n: Number(new DataView(markBytes(k).buffer).getBigUint64(8, true)) })).sort((x, y) => x.n - y.n);
  // rpc 0, the lister's own host on devnet, serves its pages one entry short in `trees`; the lister leaves out `key`
  const cut = (trees: number[]): Edit => (m, _p, a) => {
    if (m !== "getMultipleAccounts") return a;
    for (const acc of (a as Gma).value) {
      if (!acc) continue;
      const d = base64.decode(acc.data[0]);
      if (d.length > 16 && new TextDecoder().decode(d.subarray(0, 8)) === "bfpage01" && trees.includes(d[8]!)) acc.data[0] = base64.encode(d.subarray(0, d.length - 72));
    }
    return a;
  };
  const hide = (key: string): Edit => (m, _p, a) => (m === "getProgramAccounts" ? { ...(a as Gpa), value: (a as Gpa).value.filter((x) => x.pubkey !== key) } : a);
  for (const [name, key, trees] of [["the newest release", spent.at(-1)!.k, [0]], ["the newest deposit", pre.at(-1)!.k, [0, 1]], ["release number 0", spent[0]!.k, [0]], ["deposit nonce 4", pre[3]!.k, [0, 1]]] as const)
    await assert.rejects(scan({ lister: hide(key), rpc0: cut([...trees]) }), /restore: the lister listed .*but rpc 0's pages hold .* and rpc 1's hold 15 state and 11 label leaves|the listed (releases' numbers|deposits' nonces) are not/, name);
});

test("refused before any read: an unknown cluster, RPCs not the release's, a lister not on https; any https lister is taken", () => {
  assert.throws(() => exitSolReads("testnet"), ExitSolRefused);
  const r = reads();
  assert.throws(() => exitSolReads("devnet", { rpcs: [r.rpcs[1], r.rpcs[0]] }), /the two RPCs on devnet are/);
  assert.throws(() => exitSolReads("mainnet", { rpcs: r.rpcs }), /the two RPCs on mainnet are/);
  const main = exitSolReads("mainnet");
  assert.throws(() => exitSolReads("mainnet", { rpcs: main.rpcs, lister: Object.assign(async () => null, { url: "http://example.org/" }) }), /an https RPC URL/);
  // any https lister is taken, the second RPC's operator's included: each RPC's own pages judge what it lists
  for (const url of ["https://mainnet.example-rpc.org/", "https://solana-rpc.publicnode.com/?x=1"]) assert.equal(exitSolReads("mainnet", { rpcs: main.rpcs, lister: exitSolRpc(url) }).lister.url, url);
});
