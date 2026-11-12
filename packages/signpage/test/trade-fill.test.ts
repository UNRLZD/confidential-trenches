// What each filled Solana trade moved, from its own transaction (card portfolio-shows-pool-trades): the rules on the
// owner's four mainnet transactions of 12 Nov (fixtures/trade-fill, getTransaction "json" at finalized on a public RPC,
// its logs and the message's lookup-table entries left out, meta.loadedAddresses kept), and the fill of the ops records
// release 118 wrote for them.
//   node --test packages/signpage/test/trade-fill.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { fillTradeOps, solanaTradeLeg, type FillStore } from "../src/trade-fill.ts";

const MINT = "78GaXFTJzkCWpdxkNHMSP3TXEKbhQTpb3EqMt7Uupump";
const fx = (f: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/trade-fill/${f}.json`, import.meta.url), "utf8"));
const SIG = {
  buy1: "5Qn5LtHiu7xb7irPaPTSpcwPoreem1toPSYT3XvVBPDfH42CU3hMWmKP3AMXg3ag3qdoQb3Rnxrfo6dXVGXtvB8Q",
  sell1: "32CSJ1GSPrJScgPxyF41zuszLjosxgiDbeFWFRM5p7G6DzbxHjeFWihPjqhQqCLobXhkn3aqBD6WxmenAXLu7Kwn",
  buy2: "3sPawpfvAdoYLHa9i5MRKZVv6xEGLCmRXjJTKxEMHpNYqPMSX22QZ6eyLbdyJDNA7T6TTpWWaKamEA1LiAMaDoQr",
  sell2: "3aUiLLSmj1oHFot7bPLp1VewwqHZ1eNsJnTyZvLnDFKyubfqmwK6iCq7AsSXmt497Vjx8o6AxwEbRzxeEjQr52bd",
};
const TX: Record<string, Record<string, unknown>> = { [SIG.buy1]: fx("5Qn5Lt"), [SIG.sell1]: fx("32CSJ1"), [SIG.buy2]: fx("3sPawp"), [SIG.sell2]: fx("3aUiLL") };
const W1 = "TcYd32AdSHY5zuqSK2a7PvkDv8FQvafyTs2uS1ztkZX";
const W2 = "8e8RsnpnL6Toqsa2Q1YPLvopDqPa3HFTdwEikCkqpQ7p";

test("each of the four: W, the token it got or sold, and the SOL into or out of the venue", () => {
  // buys: pump's BuyExactSolIn spend (1,205,887 and 1,204,552, its instruction's own argument)
  assert.deepEqual(solanaTradeLeg(TX[SIG.buy1], "buy", MINT), { wallet: W1, units: 16041923776n, decimals: 6, lamports: 1205887n });
  assert.deepEqual(solanaTradeLeg(TX[SIG.buy2], "buy", MINT), { wallet: W2, units: 34154038071n, decimals: 6, lamports: 1204552n });
  // sales: the curve's 581,910 and 1,189,536 less pump's fees (7,275 and 14,870)
  assert.deepEqual(solanaTradeLeg(TX[SIG.sell1], "sell", MINT), { wallet: W1, units: 16041923776n, decimals: 6, lamports: 574635n });
  assert.deepEqual(solanaTradeLeg(TX[SIG.sell2], "sell", MINT), { wallet: W2, units: 34154038071n, decimals: 6, lamports: 1174666n });
});

test("never a guess: the wrong side, another token, a failed transaction, an unknown system instruction of W's", () => {
  assert.equal(solanaTradeLeg(TX[SIG.buy1], "sell", MINT), null);
  assert.equal(solanaTradeLeg(TX[SIG.sell1], "sell", "So11111111111111111111111111111111111111112"), null);
  const failed = structuredClone(TX[SIG.sell1]) as { meta: { err: unknown } };
  failed.meta.err = { InstructionError: [2, "Custom"] };
  assert.equal(solanaTradeLeg(failed, "sell", MINT), null);
  // W's transfer to the pool as a transfer with seed (tag 11): its lamports are not read, so the figure is unknown
  const odd = structuredClone(TX[SIG.sell1]) as { meta: { innerInstructions: { instructions: { data: string; programIdIndex: number; accounts: number[] }[] }[] }; transaction: { message: { accountKeys: string[] } } };
  const keys = odd.transaction.message.accountKeys;
  const ix = odd.meta.innerInstructions.flatMap((g) => g.instructions).find((i) => keys[i.programIdIndex] === "11111111111111111111111111111111" && keys[i.accounts[0]!] === W1 && base58.decode(i.data)[0] === 2)!;
  const d = base58.decode(ix.data);
  d[0] = 11;
  ix.data = base58.encode(d);
  assert.equal(solanaTradeLeg(odd, "sell", MINT), null);
  assert.equal(solanaTradeLeg(null, "buy", MINT), null);
});

/** The ops store with release 118's records of the four trades. */
function store118(): FillStore & { ops: Map<string, Record<string, unknown>> } {
  const ops = new Map<string, Record<string, unknown>>([
    ["b1", { kind: "buy", stage: "filled", txs: [{ chain: "solana", hash: SIG.buy1 }], created_ms: 1, chain: "solana", token: MINT, amount_usd: "0.19294192" }],
    ["s1", { kind: "sell", pool: "sol", sha: "x", stage: "filled", txs: [{ chain: "solana", hash: SIG.sell1 }], created_ms: 2, chain: "solana", token: MINT, units: "16041.923776", legs: [{ wallet: W1, units: "16041.923776", tx: SIG.sell1, stage: "filled" }] }],
    ["b2", { kind: "buy", stage: "filled", txs: [{ chain: "solana", hash: SIG.buy2 }], created_ms: 3, chain: "solana", token: MINT, amount_usd: "0.19272832" }],
    ["s2", { kind: "sell", pool: "sol", sha: "y", stage: "filled", txs: [{ chain: "solana", hash: SIG.sell2 }], created_ms: 4, chain: "solana", token: MINT, units: "34154.038071" }],
    ["d1", { kind: "pool_deposit", stage: "in_pool", txs: [] }],
    ["r1", { kind: "sell", pool: "sol", stage: "refused", txs: [], code: "failed", chain: "solana", token: MINT }],
  ]);
  return {
    ops,
    keys: async () => [...ops.keys()],
    get: async (_s, k) => ops.get(k),
    update: async (_s, k, f) => void ops.set(k, f(ops.get(k)) as Record<string, unknown>),
  };
}
const PRICE = { price: "16000000000", expo: -8, published_s: 1, read_ms: 0 };

test("release 118's records filled from the chain: units and SOL on each, every other field kept; an old sale gets no USD", async () => {
  const s = store118();
  const reads: string[] = [];
  const wrote = await fillTradeOps({ store: s, read: async (sig) => (reads.push(sig), [TX[sig], structuredClone(TX[sig])]), price: () => ({ ...PRICE, read_ms: 10 * 86_400_000 }), now: () => 10 * 86_400_000 });
  assert.equal(wrote, true);
  assert.deepEqual(reads.sort(), Object.values(SIG).sort(), "each trade's own signature, nothing else");
  assert.deepEqual(s.ops.get("b1"), { kind: "buy", stage: "filled", txs: [{ chain: "solana", hash: SIG.buy1 }], created_ms: 1, chain: "solana", token: MINT, amount_usd: "0.19294192", units: "16041.923776", pool_amount: "0.001205887" });
  assert.equal(s.ops.get("s1")!.pool_amount, "0.000574635");
  assert.equal(s.ops.get("s1")!.amount_usd, undefined, "a sale days old: the price now is not its price");
  assert.equal((s.ops.get("s1")!.legs as unknown[]).length, 1);
  assert.equal(s.ops.get("b2")!.pool_amount, "0.001204552");
  assert.equal(s.ops.get("s2")!.pool_amount, "0.001174666");
  assert.equal(s.ops.get("r1")!.pool_amount, undefined, "a refused sale moved nothing");
  // filled once: a second pass reads nothing
  reads.length = 0;
  assert.equal(await fillTradeOps({ store: s, read: async (sig) => (reads.push(sig), [TX[sig], TX[sig]]), price: () => null, now: () => 0 }), false);
  assert.equal(reads.length, 0);
});

test("a sale filled at its end gets its USD at the page's fresh price; a stale price gives none", async () => {
  const s = store118();
  await fillTradeOps({ store: s, read: async (sig) => [TX[sig], TX[sig]], price: () => ({ ...PRICE, read_ms: 4 }), now: () => 60_000 });
  assert.equal(s.ops.get("s1")!.amount_usd, "0.0919416");
  const t = store118();
  await fillTradeOps({ store: t, read: async (sig) => [TX[sig], TX[sig]], price: () => ({ ...PRICE, read_ms: 0 }), now: () => 200_000 });
  assert.equal(t.ops.get("s1")!.amount_usd, undefined);
  assert.equal(t.ops.get("s1")!.pool_amount, "0.000574635");
});

test("two RPCs that differ, or a read that fails, write nothing for that op", async () => {
  const s = store118();
  const other = structuredClone(TX[SIG.sell1]) as { meta: { postBalances: number[] }; transaction: { message: { accountKeys: string[] } } };
  other.meta.postBalances[other.transaction.message.accountKeys.indexOf(W1)]! += 1;
  await fillTradeOps({
    store: s,
    read: async (sig) => {
      if (sig === SIG.buy2) throw new Error("429");
      return [TX[sig], sig === SIG.sell1 ? other : TX[sig]];
    },
    price: () => null,
    now: () => 0,
  });
  assert.equal(s.ops.get("s1")!.pool_amount, undefined);
  assert.equal(s.ops.get("b2")!.pool_amount, undefined);
  assert.equal(s.ops.get("b1")!.pool_amount, "0.001205887");
  assert.equal(s.ops.get("s2")!.pool_amount, "0.001174666");
});
