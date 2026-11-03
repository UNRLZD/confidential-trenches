// Removes each of src/rules/pool.ts's checks, one at a time, and runs the test named for it in test/rules-pool.test.ts:
// each named test passes on the code as it is and fails on every mutant. The file is changed in place and put back after
// each mutant (and checked to be back); exits 1 when a named test passes on its mutant, fails or runs no test on the code
// as it is, or a mutant's text is not in its file exactly once. (The kit's pattern: packages/kit/test/evm-pool-sell-mutants.mjs.)
//   node packages/signpage/test/rules-pool-mutants.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const POOL = fileURLToPath(new URL("../src/rules/pool.ts", import.meta.url));
const TEST = fileURLToPath(new URL("./rules-pool.test.ts", import.meta.url));

const REQ = "a request: each pool kind";
const DEP = "Solana deposit: another program";
const WD = "Solana withdraw: another pool program";
const BUY = "Solana buy: the kit's tag 3";
const SELL = "Solana sell:";
const EBUY = "EVM buy:";
const EWD = "EVM withdraw:";
const ESELL = "EVM sell and authorization";

// [text, replacement, the test that must fail]
export const MUTANTS = [
  // the request
  ['if (!(POOL_CHAINS as readonly string[]).includes(p.chain)) return refuse("chain");', "", REQ],
  ['(m[2] ?? "").length > decimals) return refuse("amount");', 'false) return refuse("amount");', REQ],
  ['if (amount === 0n || amount >= 1n << 64n) return refuse("amount");', "", REQ],
  ['if (typeof token !== "string" || !(chain === "solana" ? SOL_KEY(token) : EVM_ADDRESS.test(token))) return refuse("token");', 'if (typeof token !== "string") return refuse("token");', REQ],
  ["s > POOL_MAX_SLIPPAGE_BPS) return refuse(\"slippage\");", "s > 10_000) return refuse(\"slippage\");", REQ],
  ['!Number.isInteger(s) || s < 0', "s < 0", REQ],
  // the signed bytes
  ['if (m.blockhash !== reads.blockhash) return refuse("blockhash");', "", DEP],
  ['if (ixs.slice(n).some((x) => x.program === SOLANA_COMPUTE_BUDGET_PROGRAM)) refuse("compute_budget");', "", DEP],
  // the deposit (tag 1)
  ['if (x.program !== pin.program) return refuse("program");', "", DEP],
  ['if (!same(pool, pin.pool, false, true)) return refuse("pool");', "", DEP],
  ['if (!same(from, depositor, true, true)) return refuse("depositor");', "", DEP],
  ['if (be32(pre) !== precommitment) return refuse("precommitment");', "", DEP],
  ['if (!same(statePage, solanaPoolPage(pin.program, 0, reads.stateSize), false, true)) return refuse("state_page");', "", DEP],
  ['if (!same(labelPage, solanaPoolPage(pin.program, 1, reads.labelSize), false, true)) return refuse("label_page");', "", DEP],
  ['return refuse("precommitment_mark");', "{}", DEP],
  ['if (!same(system, SOLANA_SYSTEM_PROGRAM, false, false)) return refuse("system");', "", DEP],
  ['if (d.signers.length !== 1 || d.signers[0] !== ctx.wallet) return refuse("signers");\n  const n = head(d.ixs);\n  if (d.ixs.length !== n + 1)', "const n = head(d.ixs);\n  if (d.ixs.length !== n + 1)", DEP],
  ['if (d.ixs.length !== n + 1) return refuse("instructions");', "", DEP],
  ['if (depositOf(d.ixs[n]!, pin, ctx.wallet, ctx.precommitment, reads) !== ask.amount) return refuse("amount");', "", DEP],
  // the withdraw (tag 2)
  ['if (d.signers.length !== 2 || d.signers[0] !== pin.feePayer || d.signers[1] !== ctx.wallet) return refuse("signers");', "", WD],
  ['if (!rel || rel.program !== pin.program) return refuse("program");', 'if (!rel) return refuse("program");', WD],
  ['if (want.length !== rel.data.length || want.some((b, i) => b !== rel.data[i])) return refuse("release_not_devices");', "", WD],
  ['if (!sameList(rel.accounts, accounts)) return refuse("release_accounts");', "", WD],
  ['if (rest.length > 1) return refuse("instructions");', "", WD],
  ['!same(t.accounts[1], to, false, true)) return refuse("transfer_to");', 'false) return refuse("transfer_to");', WD],
  ['if (u64le(t.data, 4) > got.withdrawnValue - got.relayFee) return refuse("transfer_amount");', "", WD],
  // the fee and deadline (withdraw and buy)
  ['if (cap > ctx.feeCap) refuse("fee_cap_over_device_cap");', "", WD],
  ['if (cap > ctx.feeCap) refuse("fee_cap_over_device_cap");', "", BUY],
  ['if (deadlineMs <= ctx.nowMs) refuse("deadline_past");', "", WD],
  ['if (deadlineMs <= ctx.nowMs) refuse("deadline_past");', "", BUY],
  ['if (fee > cap) refuse("fee_over_cap");', "", BUY],
  // the buy (tag 3)
  ['if (req.wallet !== ctx.wallet) return refuse("wallet");', "", BUY],
  ['if (req.feePayer !== pin.feePayer) return refuse("fee_payer");', "", BUY],
  ['if (req.token !== ask.token || venue.mint !== ask.token) return refuse("token");', "", BUY],
  ['if (req.spend !== ask.amount) return refuse("amount");', "", BUY],
  ['if (reads.reference.slippageBps !== ask.slippageBps) return refuse("slippage");', "", BUY],
  ['if (!verdict.ok) return refuse(', "if (false) return refuse(", BUY],
  // the sell
  ['if (venue.mint !== ask.token) return refuse("token");', "", SELL],
  ['if (reference.slippageBps !== ask.slippageBps) return refuse("slippage");', "", SELL],
  ['if (minOut < floor) return refuse("min_out");', "", SELL],
  ['if (g.program !== w.program || g.data.length !== w.data.length || g.data.some((b, j) => b !== w.data[j])) return refuse("sell");', "", SELL],
  ['if (sell.length !== want.length) return refuse("sell");', "", SELL],
  ['if (depositOf(dep, pin, ctx.wallet, ctx.precommitment, reads) > minOut) return refuse("deposit_over_min_out");', "", SELL],
  // the EVM relay data
  ['if (lower(relay.recipient) !== lower(ctx.wallet)) refuse("recipient");', "", EBUY],
  ['if (lower(relay.recipient) !== lower(ctx.wallet)) refuse("recipient");', "", EWD],
  ['if (lower(relay.feeRecipient) !== lower(pins.feeRecipient)) refuse("fee_recipient");', "", EBUY],
  ['if (relay.feeCap > ctx.feeCap) refuse("fee_cap_over_device_cap");', "", EWD],
  ['if (relay.deadlineMs <= ctx.nowMs) refuse("deadline_past");', "", EWD],
  ['if (proof.context !== context) refuse("context");', "", EBUY],
  ['if (proof.context !== context) refuse("context");', "", EWD],
  // the EVM buy and withdraw
  ['if (lower(pool) !== lower(pins.pool)) return refuse("pool");\n  if (![pins.v3', "if (![pins.v3", EBUY],
  ['if (![pins.v3, pins.v4].some((a) => a !== undefined && lower(a) === lower(built.adapter))) return refuse("adapter");', "", EBUY],
  ['if (lower(built.token) !== lower(ask.token ?? "")) return refuse("token");\n  if (proof.value', "if (proof.value", EBUY],
  ['if (proof.value !== ask.amount) return refuse("amount");', "", EBUY],
  ['if (lower(pool) !== lower(pins.pool)) return refuse("pool");\n  if (proof.value === 0n)', "if (proof.value === 0n)", EWD],
  ['if (ask.kind !== "pool.withdraw") return refuse("kind");', "", EWD],
  // the EVM sell and authorization
  ['if (lower(built.w) !== lower(ctx.wallet)) return refuse("wallet");', "", ESELL],
  ['if (lower(built.pool) !== lower(pins.pool)) return refuse("pool");', "", ESELL],
  ['if (lower(built.token) !== lower(ask.token ?? "")) return refuse("token");\n  if (built.amount', "if (built.amount", ESELL],
  ['if (built.amount !== ask.amount) return refuse("amount");', "", ESELL],
  ['if (built.feeCap > ctx.feeCap) return refuse("fee_cap_over_device_cap");', "", ESELL],
  ['if (built.deadline * 1000n <= ctx.nowMs) return refuse("deadline_past");', "", ESELL],
  ['if (nonceReads[0] !== nonceReads[1] || nonce !== nonceReads[0]) return refuse("nonce");', "", ESELL],
  ['if (pins.sellDelegate === undefined) return refuse("delegate_not_pinned");', "", ESELL],
  // the compute budget caps
  ['> SOLANA_POOL_CU_LIMIT_MAX) refuse("cu_limit");', '> 0xffffffff) refuse("cu_limit");', DEP],
  ['if (u64le(ixs[n]!.data, 1) > SOLANA_CU_PRICE_MAX) refuse("cu_price");', "", DEP],
  // the EVM floors
  ['if (typeof floor !== "bigint" || floor <= 0n || built.minOut < floor) return refuse("min_out");\n  checkRelay', "checkRelay", EBUY],
  ['if (typeof floor !== "bigint" || floor <= 0n || built.minOut < floor) return refuse("min_out");\n  passed("evm.sell"', 'passed("evm.sell"', ESELL],
  // only what a check passed is signed
  ['if (!read || read.length !== wire.length || read.some((b, i) => b !== wire[i])) return refuse("unchecked");', "", "Solana deposit: the pinned pool's tag 1"],
  ['if (!read || read.length !== wire.length || read.some((b, i) => b !== wire[i])) return refuse("unchecked");', 'if (!read) return refuse("unchecked");', "Solana deposit: the pinned pool's tag 1"],
  ['  mustHavePassed("evm.buy", built);\n', "", EBUY],
  ['  proofMustHavePassed("evm.buy", proof);\n', "", EBUY],
  ['if (PROOF_READ.get(p) !== `${as}:${proofKey(p)}`) refuse("unchecked");', "", EBUY],
  ['  proofMustHavePassed("evm.withdraw", proof);\n', "", EBUY],
  ['  mustHavePassed("evm.sell", built);\n', "", ESELL],
  ['  mustHavePassed("evm.authorization", checked);\n', "", ESELL],
];

const run = (name) => {
  try {
    const out = execFileSync(process.execPath, ["--test", "--test-timeout=120000", "--test-name-pattern", name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), TEST], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, ran: /ℹ pass [1-9]/.test(out) };
  } catch (e) {
    return { ok: false, ran: true, out: String(e.stdout ?? "") };
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const original = readFileSync(POOL, "utf8");
  let bad = 0;
  for (const name of new Set(MUTANTS.map((m) => m[2]))) {
    const r = run(name);
    if (!r.ok || !r.ran) { console.log(`BAD  "${name}" does not pass on the code as it is`); bad++; }
  }
  for (const [text, repl, name] of MUTANTS) {
    const n = original.split(text).length - 1;
    if (n !== 1) { console.log(`BAD  mutant text ${n} times in pool.ts, not once: ${text.slice(0, 80)}`); bad++; continue; }
    writeFileSync(POOL, original.replace(text, () => repl));
    try {
      const r = run(name);
      if (r.ok) { console.log(`LIVE "${name}" passes with: ${text.slice(0, 90)}`); bad++; }
      else console.log(`killed  ${text.slice(0, 90).replace(/\n/g, " ")}`);
    } finally {
      writeFileSync(POOL, original);
    }
    if (readFileSync(POOL, "utf8") !== original) { console.log("BAD  pool.ts was not put back"); process.exit(1); }
  }
  console.log(bad === 0 ? `all ${MUTANTS.length} mutants killed` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
