// node --test apps/helper/src/data/solana/first-buyers.test.ts: snipers and bundlers from a token's first trades (card
// token-page-data-complete-and-fast; the main product's definitions, first-buyers.ts). The wallets are RFC 8032's test
// public keys (on ed25519); 7vfCX... is off the curve, as a pool's or a curve's owner is.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { RawTrade } from "./decode.ts";
import { ata, firstBuys, readFirstBuys, readHeld, shares, SIG_PAGE, TX_MAX } from "./first-buyers.ts";
import { TOKEN_PROGRAM } from "./token.ts";

const MINT = "So11111111111111111111111111111111111111112";
const DEV = "4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS";
const A = "586Z7H2vpX9qNhN2T4e9Utugie3ogjbxzGaMtM3E6HR5";
const B = "Hyx62wPQGyvXCoihZq1BrbUjBRh2LuNxWiiqMkfAuSZr";
const PDA = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
const tr = (user: string, side: "b" | "s" = "b"): RawTrade => ({ venue: "pump", mint: MINT, pool: null, side, amt: 1n, quote: 1n, quoteMint: MINT, user, ts: 1 });

test("firstBuys: each wallet's first buy within 3 slots of the first trade; the creator, program addresses, sells and later slots left out", () => {
  const f = firstBuys([{ slot: 100, t: tr(DEV) }, { slot: 100, t: tr(A) }, { slot: 100, t: tr(PDA) }, { slot: 102, t: tr(B) }, { slot: 102, t: tr(A) }, { slot: 103, t: tr(DEV.replace("4", "5")) }, { slot: 101, t: tr(B, "s") }], MINT, DEV)!;
  assert.equal(f.anchor, 100);
  assert.deepEqual([...f.buyers], [[A, 100], [B, 102]]);
  assert.equal(firstBuys([], MINT, DEV), null);
});

test("shares: snipers hold what all first buyers hold now; bundlers only when two or more bought in the first slot", () => {
  const f = { anchor: 100, buyers: new Map([[A, 100], [B, 100]]) };
  assert.deepEqual(shares(f, new Map([[A, 50n], [B, 25n]]), 1_000n), { snipers_bps: 750, bundlers_bps: 750 });
  const one = { anchor: 100, buyers: new Map([[A, 100], [B, 101]]) };
  assert.deepEqual(shares(one, new Map([[A, 50n]]), 1_000n), { snipers_bps: 500, bundlers_bps: 0 }, "one wallet in the first slot is no bundle; B sold all");
  assert.equal(shares(f, new Map(), 0n), null);
});

/** A fake RPC: `sigs` newest first, `txs` per signature (logs), `accounts` per address. */
function rpc(sigs: { signature: string; slot: number; err?: unknown }[], txs: Record<string, string[]>, accounts: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    calls.push(method);
    if (method === "getSignaturesForAddress") {
      const before = (params[1] as { before?: string }).before;
      const from = before === undefined ? 0 : sigs.findIndex((s) => s.signature === before) + 1;
      return sigs.slice(from, from + SIG_PAGE).map((s) => ({ err: null, ...s }));
    }
    if (method === "getTransaction") {
      // the node refuses a version 1 transaction to a client that names a lower version (-32015, mainnet 11 Nov 18:51Z)
      if ((params[1] as { maxSupportedTransactionVersion?: number }).maxSupportedTransactionVersion !== 1) throw new Error("-32015 Transaction version (1) is not supported by the requesting client");
      return { meta: { err: null, logMessages: txs[params[0] as string] ?? [] } };
    }
    if (method === "getMultipleAccounts") return (params[0] as string[]).map((a) => accounts[a] ?? null);
    throw new Error(method);
  };
  return { call, calls };
}

test("readFirstBuys: reads to the mint's oldest signature, then its first transactions oldest first; a token past SIG_PAGES pages or a first window past TX_MAX has none", async () => {
  // no decodable trade in the logs: none
  let r = rpc([{ signature: "s2", slot: 11 }, { signature: "s1", slot: 10 }], {});
  assert.equal(await readFirstBuys(r.call, MINT, DEV), null);
  assert.deepEqual(r.calls, ["getSignaturesForAddress", "getTransaction", "getTransaction"]);
  // 3,000 signatures and more: the first trades are out of reach
  const many = Array.from({ length: 3 * SIG_PAGE }, (_, i) => ({ signature: `x${i}`, slot: 10_000 - i }));
  r = rpc(many, {});
  assert.equal(await readFirstBuys(r.call, MINT, DEV), null);
  assert.equal(r.calls.filter((c) => c === "getSignaturesForAddress").length, 3, "three pages at most");
  assert.equal(r.calls.includes("getTransaction"), false);
  // a window wider than TX_MAX: none
  const crowd = Array.from({ length: TX_MAX + 5 }, (_, i) => ({ signature: `c${i}`, slot: 50 }));
  r = rpc(crowd, {});
  assert.equal(await readFirstBuys(r.call, MINT, DEV), null);
  assert.equal(r.calls.filter((c) => c === "getTransaction").length, TX_MAX);
  // a failed signature is never read
  r = rpc([{ signature: "bad", slot: 9, err: { InstructionError: [0, "x"] } }], {});
  assert.equal(await readFirstBuys(r.call, MINT, DEV), null);
  assert.equal(r.calls.includes("getTransaction"), false);
});

test("readFirstBuys: hostile answers are no value", async () => {
  const bad = async (m: string) => (m === "getSignaturesForAddress" ? [{ signature: 5, slot: 1 }] : null);
  assert.equal(await readFirstBuys(bad, MINT, DEV), null);
  const notList = async () => ({ value: [] });
  assert.equal(await readFirstBuys(notList, MINT, DEV), null);
});

test("readHeld: each first buyer's associated account for the mint; a missing account holds 0; an account of another mint or owner is no value", async () => {
  const f = { anchor: 1, buyers: new Map([[A, 1], [B, 1]]) };
  const acct = (owner: string, mint: string, amount: string) => ({ data: { parsed: { info: { owner, mint, tokenAmount: { amount } } } } });
  let r = rpc([], {}, { [ata(A, MINT, TOKEN_PROGRAM)]: acct(A, MINT, "42") });
  assert.deepEqual([...(await readHeld(r.call, f, MINT, TOKEN_PROGRAM))!], [[A, 42n]]);
  r = rpc([], {}, { [ata(A, MINT, TOKEN_PROGRAM)]: acct(B, MINT, "42") });
  assert.equal(await readHeld(r.call, f, MINT, TOKEN_PROGRAM), null);
  r = rpc([], {}, { [ata(A, MINT, TOKEN_PROGRAM)]: acct(A, DEV, "42") });
  assert.equal(await readHeld(r.call, f, MINT, TOKEN_PROGRAM), null);
});

// the recorded mainnet pump.fun buy (fixtures/sol-trades-txs.json "pump-buy", decode.test.ts): its buyer, in the token's
// first slot with a second wallet, is a sniper and a bundler
test("readFirstBuys and shares on a recorded mainnet pump.fun buy: its buyer in the first slot", async () => {
  const F = JSON.parse(readFileSync(new URL("./fixtures/sol-trades-txs.json", import.meta.url), "utf8")) as { txs: Record<string, { result: { meta: { logMessages: string[] } } }> };
  const BUY = F.txs["pump-buy"]!.result.meta.logMessages;
  const mint = "4Tdj8MDuQ7Nx1drP1fkf1H4FVvUDrgZ3kbgQpHWXpump";
  const buyer = "4ZvukwqXc2AFAHcuvW8VrKD9j3zGHuoqW4hvEQfANH2n";
  const r = rpc([{ signature: "late", slot: 205 }, { signature: "b2", slot: 200 }, { signature: "b1", slot: 200 }], { b1: BUY, b2: BUY, late: BUY });
  const f = (await readFirstBuys(r.call, mint, null))!;
  assert.equal(f.anchor, 200);
  assert.deepEqual([...f.buyers], [[buyer, 200]], "one wallet, once");
  assert.deepEqual(r.calls, ["getSignaturesForAddress", "getTransaction", "getTransaction"], "slot 205, past the window, is never read");
  assert.equal(await readFirstBuys(r.call, mint, buyer).then((x) => x!.buyers.size), 0, "the creator is no sniper");
});
