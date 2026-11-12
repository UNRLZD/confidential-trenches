// Card fresh-money-spendable-at-once: a plan on the rested notes first can need more parts than the plan the screen
// priced its Max fee on (every unspent note, the fresh one included); the run takes the rested plan only when it has no
// more parts, so it never stops "max_fee" where one part from the fresh note sends.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import type { Pool } from "../../wallet/src/pool/pool.ts";
import type { NoteRef } from "../../wallet/src/notes/secrets.ts";
import type { SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";
import { planPoolWithdraw, runPoolWithdraw, withdrawSources } from "../src/pool-withdraw.ts";
import { checkPoolAmount } from "../src/withdraw/pool-form.ts";
import { ASK, C, COST, NOW, SCOPE, TO, closers, world } from "./pool-withdraw-world.ts";

after(async () => {
  for (const c of closers.splice(0)) await c();
});

const cutAt = (times: readonly bigint[]) => (state: readonly bigint[], labels: readonly bigint[]): Pool<SolanaReleaseRequest>["trees"] => async (beforeMs) => {
  const n = times.filter((t) => t < beforeMs).length;
  const s = new VaultTree(state.slice(0, n)), l = new VaultTree(labels.slice(0, n));
  return { stateTree: s, labelTree: l, stateRoot: s.root!, labelRoot: l.root! };
};
const RETURN: NoteRef = { kind: "return", c: "sol", l: 7n, j: 0 };

test("two rested notes and one fresh note that sends the amount alone: the Max fee the screen draws is one part's, and the run sends", async () => {
  // leaves 0 and 1 landed before the epoch (rested, 20M each), leaf 2 (a sell's return, 50M) 1 ms before now
  const wd = await world([20_000_000n, 20_000_000n, 50_000_000n, 1_000n], { trees: cutAt([NOW - 30_000n, NOW - 30_000n, NOW - 1n, NOW + 29_000n]), refs: [undefined, undefined, RETURN] });
  const amount = 25_000_000n;
  // the screen's own check, on the same notes the page gives it (pool-testnet.ts withdrawSources): one part
  const sources = withdrawSources(await wd.ns.list(), SCOPE);
  const screen = checkPoolAmount("solana" as never, "0.025", { notes: sources, ...C } as never);
  const onePart = planPoolWithdraw(sources, amount, C)!;
  assert.equal(onePart.length, 1, "the fewest parts over every note: the fresh 50M note alone");
  if (screen.ok) assert.equal(screen.maxFee, COST, "the screen's Max fee: one part");
  const a = await runPoolWithdraw(wd.host, ASK, TO, amount, COST);
  assert.equal(a.stage, "sent", `stopped: ${a.cause}`);
});

// the same with the fresh note a deposit's own: at the base d52b0a613 it proved on the newest root at once and sent
test("two rested notes and one fresh deposit note that sends the amount alone: the run sends (as it did before the card)", async () => {
  const wd = await world([20_000_000n, 20_000_000n, 50_000_000n, 1_000n], { trees: cutAt([NOW - 30_000n, NOW - 30_000n, NOW - 1n, NOW + 29_000n]) });
  const a = await runPoolWithdraw(wd.host, ASK, TO, 25_000_000n, COST);
  assert.equal(a.stage, "sent", `stopped: ${a.cause}`);
});
