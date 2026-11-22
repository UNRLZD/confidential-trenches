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
  const all = ws(FOUND_BATCH * 2 + 5);
  const found = await heldWs(all, batch);
  assert.deepEqual(calls.map((c) => c.length), [FOUND_BATCH, FOUND_BATCH, 5]);
  assert.deepEqual(found, all.filter((w) => lamports(w.address) > 0));
  assert.equal(FOUND_BATCH, 100);
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
    await assert.rejects(heldWs(ws(2), batch), Error, name);
  }
  await assert.rejects(heldWs(ws(1), (async () => ({ value: [{ lamports: 1.5 }] })) as unknown as SolanaRpc), /not a count/);
});

// The found W's rule sweeps only a W whose owed record says `found: true` (pool-sell.ts rentBackRun's `bare`): two writers
// of that key. pool-testnet.ts's findHeldWs, after both RPCs read W holding SOL and its own note UNSPENT or HELD; and
// pool-sell.ts's strandOwed (review of dec80ea5b, H1), called only as the page's `strand` of resumePieces, when a buy of
// pieces can no longer land and a piece of it paid W (W holds SOL its buy never spent, as findHeldWs would find it on a
// restore). A third writer, or another caller of strandOwed, anywhere in the page or the wallet would make a W the rule
// never read the same way.
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
test("an owed rent back is written found: true in two places only, pool-testnet.ts's findHeldWs and pool-sell.ts's strandOwed, the strand of resumePieces its one caller", () => {
  const files = { ...sources(new URL("../src/", import.meta.url)), ...sources(new URL("../../wallet/src/", import.meta.url)) };
  const got = foundWriters(files);
  assert.equal(got.length, 2, got.join(", "));
  const at = (f: string, n: string) => files[f]!.split("\n")[Number(n) - 1]!;
  const [sell, net] = [got.find((g) => g.startsWith("signpage/src/pool-sell.ts:")), got.find((g) => g.startsWith("signpage/src/pool-testnet.ts:"))];
  assert.ok(sell && net, got.join(", "));
  assert.match(at("signpage/src/pool-sell.ts", sell.split(":")[1]!), /^  await owed\.put\(\{ \.\.\.\(had \?\? \{ passes: 0 \}\), address: r\.address, l: r\.l, j: r\.j, mints: had\?\.mints \?\? \[\], found: true \}\);$/);
  assert.ok(at("signpage/src/pool-sell.ts", String(Number(sell.split(":")[1]) - 3)).startsWith("export async function strandOwed("), "the pool-sell.ts writer is strandOwed's");
  const callers = (fs: Record<string, string>) => Object.entries(fs).flatMap(([f, src]) => src.split("\n").flatMap((l, i) => (/\bstrandOwed\(/.test(l) && !l.startsWith("export async function strandOwed(") ? [`${f}:${i + 1}`] : [])));
  const calls = callers(files);
  assert.equal(calls.length, 1, calls.join(", "));
  // planted: another caller of strandOwed is named
  assert.equal(callers({ ...files, "x.ts": "await strandOwed(o, r);" }).length, 2);
  assert.match(at(calls[0]!.split(":")[0]!, calls[0]!.split(":")[1]!), /^      strand: \(r\) => strandOwed\(owedNoted\(page\.store\), r\),$/);
  const line = at("signpage/src/pool-testnet.ts", net.split(":")[1]!);
  assert.match(line, /for \(const w of await heldWs\(ws, rpcs\("pass"\)\[1\]\)\) await o\.put\(\{ address: w\.address, l: w\.l\.toString\(\), j: w\.j, mints: \[\], passes: 0, found: true \}\);/);
  // planted: a second writer, as written or as minified, is named
  assert.deepEqual(foundWriters({ ...files, "x.ts": "await o.put({ ...r, found: true });\nconst y = { found: !0 };" }).length, 4);
});
