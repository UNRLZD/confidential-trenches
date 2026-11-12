// node packages/kit/test/near-swap-mutants.mjs (card near-private-trading, slice near-swap-build): removes each check of
// the NEAR swap's calls (src/trade/near/swap.ts, N1-N4 and N7) one at a time in a copy of the kit (test/mutant-copy.mjs),
// runs the test of test/near-swap.test.ts named for it there, and expects it to fail: each bad shape that test plants
// is then refused by nothing else.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runSync } from "../../../scripts/group-run.mjs";
import { kitCopy } from "./mutant-copy.mjs";

// [name, the source text, its replacement, the test name pattern]
const M = [
  ["N1 the quote not held to the request", "  if (tokenIn === null || q.network !== r.network || q.exchange !== exchange || q.side !== r.side || q.token !== r.token || q.tokenIn !== tokenIn || q.tokenOut !== tokenOut || q.amountIn !== r.amountIn)\n", "  if (tokenIn === null)\n", "^N1 "],
  ["N1 another signer taken", "    if (c.sender_id !== r.wallet) throw", "    if (false) throw", "^N1 "],
  ["N1 the swap's amount not compared", "      if (u128(args.amount) !== r.amountIn) throw", "      if (false) throw", "^N1 "],
  ["N2 any receiver taken", "    if (c.receiver_id !== tokenIn && c.receiver_id !== tokenOut && c.receiver_id !== exchange) throw", "    if (false) throw", "^N2 "],
  ["N2 the swap into any account", " || args.receiver_id !== exchange) throw new NearSwapRefused(\"N2\"", ") throw new NearSwapRefused(\"N2\"", "^N2 "],
  ["N3 any registration deposit", "      if (deposit === null || deposit <= 0n || deposit !== ctx.storageMin || deposit > NEAR_SWAP_STORAGE_MAX) throw", "      if (deposit === null) throw", "^N3 "],
  ["N3 the registration cap removed", " || deposit > NEAR_SWAP_STORAGE_MAX) throw", ") throw", "^N3 "],
  ["N3 another account's registration", "      if (!sameKeys(args, [\"account_id\", \"registration_only\"]) || args.account_id !== r.wallet || args.registration_only !== true) throw", "      if (false) throw", "^N3 "],
  ["N3 any swap deposit", "      if (deposit !== 1n) throw new NearSwapRefused(\"N3\", \"ft_transfer_call: 1 yocto\");", "", "^N3 "],
  ["N3 any claim deposit", "      if (deposit !== 1n) throw new NearSwapRefused(\"N3\", \"claim_lostfound: 1 yocto\");", "", "^N3 "],
  ["N3 the claim of another token", "      if (!sameKeys(args, [\"token_id\"]) || args.token_id !== tokenOut) throw", "      if (false) throw", "^N3 "],
  ["N3 any method or order", "    if (at < 0 || at <= last) throw", "    if (false) throw", "^N3 "],
  ["N3 more than one action", "    if (!Array.isArray(c.actions) || c.actions.length !== 1) throw", "    if (!Array.isArray(c.actions)) throw", "^N3 "],
  ["N3 no swap or two", "  if (ctx.registered && swaps !== 1) throw", "  if (false) throw", "^N3 "],
  ["N3 two swaps in three calls (the order loosened)", ["    if (at < 0 || at <= last) throw", "  if (ctx.registered && swaps !== 1) throw"], ["    if (at < 0 || at < last) throw", "  if (ctx.registered && swaps < 1) throw"], "^N3 "],
  ["N3 the cap raised to 0.0126 N", "NEAR_SWAP_STORAGE_MAX = 12_500_000_000_000_000_000_000n", "NEAR_SWAP_STORAGE_MAX = 12_600_000_000_000_000_000_000n", "^N3 "],
  ["N3 the cap raised to 0.99 N", "NEAR_SWAP_STORAGE_MAX = 12_500_000_000_000_000_000_000n", "NEAR_SWAP_STORAGE_MAX = 990_000_000_000_000_000_000_000n", "^N3 "],
  ["N3 a swap beside W's registration", "      if (!ctx.registered) throw new NearSwapRefused(\"N3\", \"a swap before", "      if (false) throw new NearSwapRefused(\"N3\", \"a swap before", "^N3 "],
  ["N3 a claim beside W's registration", "      if (!ctx.registered) throw new NearSwapRefused(\"N3\", \"a claim before", "      if (false) throw new NearSwapRefused(\"N3\", \"a claim before", "^N3 "],
  ["N3 a registration once W is registered", "      if (ctx.registered) throw new NearSwapRefused(\"N3\", \"storage_deposit: W is registered", "      if (false) throw new NearSwapRefused(\"N3\", \"storage_deposit: W is registered", "^N3 "],
  ["S1 the builder signs the swap beside the registration", "  else {\n    calls.push(call(q.tokenIn", "  {\n    calls.push(call(q.tokenIn", "^S1 "],
  ["S5 the floor taken on what W receives (builder and check)", ["const floor = nearSwapFloor(q.venueOut, a.slippageBps);", "const floor = nearSwapFloor(q.venueOut, slippageBps);"], ["const floor = nearSwapFloor(q.amountOut, a.slippageBps);", "const floor = nearSwapFloor(q.amountOut, slippageBps);"], "^S5 "],
  ["N3 a registration on the input", "      if (c.receiver_id !== tokenOut) throw new NearSwapRefused(\"N3\", \"a registration", "      if (false) throw new NearSwapRefused(\"N3\", \"a registration", "^N3 "],
  ["N4 the msg's keys not held", "  if (!isObj(m) || !sameKeys(m, [\"force\", \"actions\", \"skip_degen_price_sync\", \"skip_unwrap_near\"])) throw", "  if (!isObj(m)) throw", "^N4 the msg read back"],
  // the byte comparison holds the flags and the hops too, so each of those checks is planted with it removed as well:
  // the check alone must still refuse
  ["N4 the flags not held (nor the bytes)", ["  if (m.force !== 0 || m.skip_degen_price_sync !== true || m.skip_unwrap_near !== true) throw", "  if (msg !== nearSwapMsg(q, floor)) throw"], ["  if (false) throw", "  if (false) throw"], "^N4 the msg read back"],
  ["N4 the hop count not held", "  if (!Array.isArray(acts) || acts.length !== q.hops.length || acts.length < 1 || acts.length > 2) throw", "  if (!Array.isArray(acts)) throw", "^N4 the msg read back"],
  ["N4 an action's keys not held", "    if (!isObj(a) || !sameKeys(a, [\"pool_id\", \"token_in\", \"token_out\", \"min_amount_out\"]) || h === undefined) throw", "    if (!isObj(a) || h === undefined) throw", "^N4 the msg read back"],
  ["N4 the minimums not held", "    if (min === null || min !== want) throw", "    if (min === null) throw", "^N4 the msg read back"],
  ["N4 the bytes not compared", "  if (msg !== nearSwapMsg(q, floor)) throw", "  if (false) throw", "^N4 the msg read back"],
  ["N4 the hops not compared (nor the bytes)", ["    if (a.pool_id !== h.pool || a.token_in !== h.tokenIn || a.token_out !== h.tokenOut) throw", "  if (msg !== nearSwapMsg(q, floor)) throw"], ["    if (false) throw", "  if (false) throw"], "^N4 "],
  ["N7 gas below the kit's taken", "    if (f.gas !== NEAR_SWAP_GAS[method as keyof typeof NEAR_SWAP_GAS]) throw", "    if ((f.gas as number) > NEAR_SWAP_GAS[method as keyof typeof NEAR_SWAP_GAS]) throw", "^N7 "],
  ["N7 any gas", "    if (f.gas !== NEAR_SWAP_GAS[method as keyof typeof NEAR_SWAP_GAS]) throw", "    if (false) throw", "^N7 "],
];
const CHILD_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined };
const root = kitCopy();
const F = path.join(root, "src/trade/near/swap.ts");
const src = readFileSync(F, "utf8");
const list = (x) => (Array.isArray(x) ? x : [x]);
const plant = (from, repl) => list(from).reduce((t, f, i) => t.replace(f, list(repl)[i]), src);
for (const [name, from] of M) {
  if (list(from).some((f) => src.split(f).length !== 2)) {
    console.log(`NOT ONCE [${name}]: its source text in swap.ts`);
    process.exit(1);
  }
}
const base = runSync(process.execPath, ["--test", "test/near-swap.test.ts"], { cwd: root, encoding: "utf8", env: CHILD_ENV, timeoutMs: 120_000 });
if (base.status !== 0) {
  console.log(`the named tests fail on the code as it is:\n${base.stdout.slice(-2000)}`);
  process.exit(1);
}
let ok = 0;
for (const [name, from, repl, pat] of M) {
  writeFileSync(F, plant(from, repl));
  let r;
  try {
    r = runSync(process.execPath, ["--test", `--test-name-pattern=${pat}`, "test/near-swap.test.ts"], { cwd: root, encoding: "utf8", env: CHILD_ENV, timeoutMs: 120_000 });
  } finally {
    writeFileSync(F, src);
  }
  const fail = (r.stdout.match(/ℹ fail (\d+)/) ?? [])[1];
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1];
  const killed = r.status !== 0 && Number(fail) > 0;
  if (killed) ok++;
  console.log(`${killed ? "KILLED" : "SURVIVED"} [${name}] pass ${pass} fail ${fail}`);
}
console.log(`${ok}/${M.length} killed`);
if (ok !== M.length) process.exitCode = 1;
else console.log(`every one of ${M.length} mutants fails its named test`);
