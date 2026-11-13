// pool-found.ts (card buy-spends-several-pieces): a restored device finds the Ws a buy of several pieces left holding
// SOL from its notes alone: the own W of every UNSPENT and HELD note, read in batches on the helper's seat only, else
// one W a request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { entropyToWords, freshWallet, wordsToSeed64 } from "@blindfill/wallet/derive";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { FOUND_BATCH, heldWs, ownWs, type FoundW } from "../src/pool-found.ts";

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const SCOPE = 11n;

const note = (id: string, state: NoteRecord["state"], label: bigint, j?: number, scope = SCOPE): NoteRecord => ({
  id,
  ref: j === undefined ? { kind: "deposit", s: 0n, i: 0 } : { kind: "change", l: label - 1n, j },
  scope,
  precommitment: 1n,
  state,
  leaf: { value: 1n, label, commitment: 2n, leafIndex: 0n },
});

test("ownWs: the own W of each UNSPENT and HELD note of the scope, its l and j; never a spent, reserved, landing or other pool's note, nor one already owed", () => {
  const notes = [
    note("a", "UNSPENT", 3n),
    note("b", "HELD", 4n, 2),
    note("c", "SPENT", 5n),
    note("d", "RESERVED", 6n),
    note("e", "UNSPENT", 7n, undefined, 99n),
    { ...note("f", "UNSPENT", 8n), leaf: undefined },
    note("g", "INCOMING" as NoteRecord["state"], 9n),
  ];
  const want = (l: bigint, n: NoteRecord): FoundW => ({ address: freshWallet(SEED64, "sol", l, jOf(n.ref)).address, l, j: jOf(n.ref) });
  const ws = ownWs(SEED64, notes, SCOPE);
  assert.deepEqual(ws, [want(3n, notes[0]!), want(4n, notes[1]!)]);
  assert.notEqual(ws[0]!.address, ws[1]!.address);
  assert.deepEqual(ownWs(SEED64, notes, SCOPE, new Set([ws[0]!.address])), [ws[1]]);
});

const ws = (n: number): FoundW[] => Array.from({ length: n }, (_, k) => ({ address: `W${k}`, l: BigInt(k), j: 0 }));
const lamports = (address: string): number => (Number(address.slice(1)) % 7 === 3 ? 2_039_280 : 0);

test("heldWs on the helper's seat: one getMultipleAccounts per FOUND_BATCH Ws, none on the other RPC; the Ws that hold SOL", async () => {
  const calls: (readonly string[])[] = [];
  const batch = (async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getMultipleAccounts");
    const list = params[0] as string[];
    calls.push(list);
    // a W never made reads null; one that holds lamports reads them
    return { context: { slot: 1 }, value: list.map((a) => (lamports(a) > 0 ? { lamports: lamports(a), owner: "11111111111111111111111111111111", data: ["", "base64"] } : null)) };
  }) as SolanaRpc;
  const one = (async () => assert.fail("the public RPC names no W while a seat batches")) as unknown as SolanaRpc;
  const all = ws(FOUND_BATCH * 2 + 5);
  const found = await heldWs(all, batch, one);
  assert.deepEqual(calls.map((c) => c.length), [FOUND_BATCH, FOUND_BATCH, 5]);
  assert.deepEqual(found, all.filter((w) => lamports(w.address) > 0));
  assert.equal(FOUND_BATCH, 100);
});

test("heldWs with no seat (the testnet build): one getAccountInfo a W, never two Ws in one request", async () => {
  const asked: unknown[] = [];
  const one = (async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getAccountInfo");
    assert.equal(typeof params[0], "string");
    asked.push(params[0]);
    const l = lamports(params[0] as string);
    return { context: { slot: 1 }, value: l > 0 ? { lamports: l } : null };
  }) as SolanaRpc;
  const all = ws(12);
  assert.deepEqual(await heldWs(all, null, one), all.filter((w) => lamports(w.address) > 0));
  assert.deepEqual(asked, all.map((w) => w.address));
});

test("heldWs: an answer out of shape throws, so nothing is found on it", async () => {
  const bad: [string, unknown][] = [
    ["one answer short", { value: [null] }],
    ["no value", {}],
    ["lamports a string", { value: [{ lamports: "5" }, null] }],
    ["lamports negative", { value: [{ lamports: -1 }, null] }],
    ["lamports past 2^53", { value: [{ lamports: 2 ** 60 }, null] }],
  ];
  for (const [name, answer] of bad) {
    const batch = (async () => answer) as unknown as SolanaRpc;
    await assert.rejects(heldWs(ws(2), batch, batch), Error, name);
  }
  await assert.rejects(heldWs(ws(1), null, (async () => null) as unknown as SolanaRpc), /no value/);
  await assert.rejects(heldWs(ws(1), null, (async () => ({ value: { lamports: 1.5 } })) as unknown as SolanaRpc), /not a count/);
});

// The found W's rule sweeps only a W whose owed record says `found: true` (pool-sell.ts rentBackRun's `bare`): one writer
// of that key, pool-testnet.ts's findHeldWs, after both RPCs read W holding SOL and its own note UNSPENT or HELD. A second
// writer anywhere in the page or the wallet would make a W the rule never read the same way.
const FOUND_WRITE = /\bfound\s*:\s*(?:true|!0)\b/g;
/** Each `found: true` written in `files` ({ path: source }), as "path:line". */
function foundWriters(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [path, src] of Object.entries(files))
    src.split("\n").forEach((l, i) => {
      if (FOUND_WRITE.test(l)) out.push(`${path}:${i + 1}`);
      FOUND_WRITE.lastIndex = 0;
    });
  return out;
}
const sources = (dir: URL): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir, { recursive: true }) as string[]) if (f.endsWith(".ts")) out[`${dir.pathname.split("/packages/")[1]}${f}`] = readFileSync(new URL(f, dir), "utf8");
  return out;
};
test("an owed rent back is written found: true in one place only, pool-testnet.ts's findHeldWs", () => {
  const files = { ...sources(new URL("../src/", import.meta.url)), ...sources(new URL("../../wallet/src/", import.meta.url)) };
  const got = foundWriters(files);
  assert.equal(got.length, 1, got.join(", "));
  assert.match(got[0]!, /^signpage\/src\/pool-testnet\.ts:\d+$/);
  const line = files["signpage/src/pool-testnet.ts"]!.split("\n")[Number(got[0]!.split(":")[1]) - 1]!;
  assert.match(line, /for \(const w of await heldWs\(ws, batch, rpcs\("pass"\)\[0\]\)\) await o\.put\(\{ address: w\.address, l: w\.l\.toString\(\), j: w\.j, mints: \[\], passes: 0, found: true \}\);/);
  // planted: a second writer, as written or as minified, is named
  assert.deepEqual(foundWriters({ ...files, "x.ts": "await o.put({ ...r, found: true });\nconst y = { found: !0 };" }).length, 3);
});
