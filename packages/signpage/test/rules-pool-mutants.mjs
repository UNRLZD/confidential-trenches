// Removes each of src/rules/pool.ts's checks, one at a time, and runs the test named for it in test/rules-pool.test.ts
// (or the test file a mutant names, test/rules-pool-onward.test.ts): each named test passes on the code as it is and fails
// on every mutant. A mutant is written to a copy beside pool.ts (src/rules/.pool-mutant-<pid>.ts) and run by a copy of
// its test file that imports it, all removed after: pool.ts itself is
// never changed, so a test run at the same time (the package's own, in parallel) never reads a mutant. Exits 1 when a
// named test passes on its mutant, fails or runs no test on the code as it is, or a mutant's text is not in its file
// exactly once. test/rules-pool-mutants.test.mjs runs it in the package's tests.
//   node packages/signpage/test/rules-pool-mutants.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const POOL = fileURLToPath(new URL("../src/rules/pool.ts", import.meta.url));
const TEST = "rules-pool.test.ts";
const ONWARD = "rules-pool-onward.test.ts";
const testOf = (file) => fileURLToPath(new URL(`./${file}`, import.meta.url));
const MUTANT_SRC = fileURLToPath(new URL(`../src/rules/.pool-mutant-${process.pid}.ts`, import.meta.url));
const mutantTestOf = (file) => fileURLToPath(new URL(`./.${file.replace(/\.test\.ts$/, "")}-mutant-${process.pid}.test.ts`, import.meta.url));
const IMPORT = 'from "../src/rules/pool.ts";';

const REQ = "a request: each pool kind";
const DEC = "a request's decimals";
const DEPOK = "Solana deposit: the pinned pool's tag 1";
const WDOK = "Solana withdraw: the device's release";
const DEP = "Solana deposit: another program";
const WD = "Solana withdraw: another pool program";
const BUY = "Solana buy: the kit's tag 3";
const SELL = "Solana sell:";
const EBUY = "EVM buy:";
const EWD = "EVM withdraw:";
const ESELL = "EVM sell and authorization";
const ONW = "Solana withdraw onward: a fee payer of ours";
const ONTO = "Solana withdraw onward: To that is W";
const ONR = "Solana withdraw onward: reads the two RPCs";
const ONC = "EVM onward send: W's whole balance";
const ONRH = "EVM onward send: on Robinhood";
const ONF = "EVM onward send: a max fee under";
const ONS = "EVM onward send: signs as W";

// [text, replacement, the test that must fail, its file when not rules-pool.test.ts]
export const MUTANTS = [
  // the request
  ['if (!(POOL_CHAINS as readonly string[]).includes(p.chain)) return refuse("chain");', "", REQ],
  ['(m[2] ?? "").length > decimals) return refuse("amount");', 'false) return refuse("amount");', REQ],
  ['if (amount === 0n || amount >= AMOUNT_BOUND[chain]) return refuse("amount");', 'if (amount === 0n) return refuse("amount");', DEC],
  ["Object.freeze({ solana: 1n << 64n, base: 1n << 256n, robinhood: 1n << 256n })", "Object.freeze({ solana: 1n << 64n, base: 1n << 64n, robinhood: 1n << 256n })", DEC],
  ['if (p.kind !== "pool.deposit" && (typeof token !== "string" || !(chain === "solana" ? SOL_KEY(token) : EVM_ADDRESS.test(token)))) return refuse("token");', 'if (p.kind !== "pool.deposit" && typeof token !== "string") return refuse("token");', REQ],
  // the decimals: the pool asset's, or the token's from two agreeing reads, never the caller's
  ["Object.freeze({ solana: 9, base: 18, robinhood: 18 })", "Object.freeze({ solana: 9, base: 18, robinhood: 9 })", DEC],
  ['const decimals = p.kind === "pool.sell" ? tokenDecimalsOf(chain, tokenReads as TokenDecimalsReads) : asset;', "const decimals = asset;", DEC],
  ['if (!Array.isArray(reads) || reads.length !== 2) return refuse("decimals");', "", DEC],
  ['if (decimalsAnswer(chain, reads[1]) !== a) return refuse("decimals");', "", DEC],
  ["o.owner === SOLANA_TOKEN_PROGRAM ? d.length === 82 :", "o.owner === SOLANA_TOKEN_PROGRAM ? d.length >= 82 :", DEC],
  ["d.length !== 355 && d[165] === 1)", "d.length !== 355)", DEC],
  ["(d.length > 165 && d.length !== 355 && d[165] === 1)", "(d.length > 165 && d[165] === 1)", DEC],
  ['if (!mint || d[45] !== 1) return refuse("decimals");', 'if (!mint) return refuse("decimals");', DEC],
  ['/^0x[0-9a-fA-F]{64}$/.test(a)', "/^0x[0-9a-fA-F]+$/.test(a)", DEC],
  ['if (n > 255n) return refuse("decimals");', "", DEC],
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
  ['if (d.ixs.length > n + 1) return refuse("instructions");', "", WDOK],
  // W's onward send (the withdraw's second transaction)
  ["[ctx.wallet, pin.pool, pin.program, pin.feePayer, SOLANA_SYSTEM_PROGRAM, ...reads.releaseAccounts].includes(to)", "false", ONTO],
  [", ...reads.releaseAccounts].includes(to)", "].includes(to)", ONTO],
  ['if (!Array.isArray(reads.toExecutable) || reads.toExecutable.length !== 2 || reads.toExecutable.some((x) => x !== false)) return refuse("to");', "", ONTO],
  ["p[0] >= 0n && p[0] === p[1] ? p[0]", "p[0] >= 0n ? p[0]", ONR],
  ['// W alone signs and pays: no fee payer of ours, nobody else\'s key\n  if (d.signers.length !== 1 || d.signers[0] !== ctx.wallet) return refuse("signers");', "", ONW],
  ['if (d.ixs.length !== 1) return refuse("instructions");', "", ONW],
  ['u64le(Uint8Array.of(...t.data.subarray(0, 4), 0, 0, 0, 0), 0) !== 2n) return refuse("transfer");', 'false) return refuse("transfer");', ONW],
  ['!same(t.accounts[1], to, false, true)) return refuse("transfer_to");', 'false) return refuse("transfer_to");', ONW],
  ["if (amount === 0n || amount + fee !== balance)", "if (amount === 0n || amount + fee > balance)", ONW],
  ["if (amount === 0n || amount + fee", "if (amount + fee", ONW],
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
  ['if (back !== minOut - reserve) return refuse("deposit_amount");', 'if (back > minOut) return refuse("deposit_amount");', SELL],
  ['if (typeof reserve !== "bigint" || reserve < 0n || reserve > SOLANA_POOL_SELL_RESERVE_MAX || reserve >= minOut) return refuse("reserve");', "", SELL],
  ["reserve > SOLANA_POOL_SELL_RESERVE_MAX || ", "", SELL],
  ["+ 2n * (128n + 16n + 72n) * SOLANA_RENT_PER_BYTE_MAX;", "+ (128n + 16n + 72n) * SOLANA_RENT_PER_BYTE_MAX;", SELL],
  ["export const SOLANA_RENT_PER_BYTE_MAX = 6_960n;", "export const SOLANA_RENT_PER_BYTE_MAX = 6_961n;", SELL],
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
  ['if (ask.kind !== "pool.withdraw") return refuse("kind");\n  const proof', "const proof", EWD],
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
  // the signers: only what a check passed, as it read it, by what it is
  ['return r ?? refuse("unchecked");', 'return r ?? CHECKED["evm.buy"].get(x) ?? CHECKED["evm.withdraw"].get(x) ?? refuse("unchecked");', EBUY],
  ['if (!k || p.nullifier !== k.nullifier || p.context !== k.context || p.value !== k.value) return refuse("unchecked");', 'if (!k) return refuse("unchecked");', EBUY],
  ['  passed("evm.buy", given, read);\n', "", EBUY],
  ['if (lower(pool) !== lower(read.pool) || b.pool !== read.pool || b.venues !== read.venues || b.proof !== read.proof) return refuse("unchecked");', "", EBUY],
  [" || b.proof !== read.proof) return refuse(\"unchecked\");", ") return refuse(\"unchecked\");", EBUY],
  ['  passed("evm.withdraw", given, { venues: pins.venues, pool: pins.pool, chainId: pins.chainId, proof });\n', "", EWD],
  ['  passed("evm.sell", built, { venues: pins.venues, pool: pins.pool, chainId: pins.chainId });\n', "", ESELL],
  ["pinnedSignSellAuthorization(read.venues,", "pinnedSignSellAuthorization(_ctx.evm!.venues,", ESELL],
  // the review's fold: the sell's precommitment, the venue list's chain id
  ['if (built.precommitment !== ctx.precommitment) return refuse("precommitment");', "", ESELL],
  ['if (!Number.isSafeInteger(venue.chainId) || venue.chainId <= 0) return refuse("chain");', "", EWD],
  // the draw: where the money lands, and what goes into the pool on a sell
  ['if (d.op === "pool.withdraw" || d.op === "pool.sell") lines.push(["To", d.to]);', "", WDOK],
  ['if (d.back !== null) lines.push(["To private balance", poolUnits(d.back, asset)]);', "", SELL],
  ['const frac = (amount % base).toString().padStart(decimals, "0").replace(/0+$/, "");', 'const frac = (amount % base).toString().replace(/0+$/, "");', SELL],
  // the EVM onward send (W's second step of a withdraw): each refusal, and the signer's
  ['if (ask.kind !== "pool.withdraw") return refuse("kind");\n  const chain', "const chain", ONC, ONWARD],
  ['if (typeof ctx.wallet !== "string" || !EVM_ADDRESS.test(ctx.wallet)) return refuse("wallet");', "", ONC, ONWARD],
  ['typeof tx !== "object" || tx === null || Object.keys', "Object.keys", ONC, ONWARD],
  ["Object.keys(tx).sort().join() !== ONWARD_KEYS || ", "", ONC, ONWARD],
  [' || tx.type !== 2) return refuse("type");', ') return refuse("type");', ONC, ONWARD],
  ["![t.chainId, t.maxPriorityFeePerGas, t.maxFeePerGas, t.gasLimit, t.value].every(uint) || ", "", ONC, ONWARD],
  [' || t.nonce >= (1n << 64n) - 1n) return refuse("tx_fields");', ') return refuse("tx_fields");', ONC, ONWARD],
  ['if (typeof t.to !== "string" || typeof t.data !== "string" || !Array.isArray(t.accessList)) return refuse("tx_fields");', "", ONC, ONWARD],
  ["!Array.isArray(pair) || pair.length !== 2 || ", "", ONC, ONWARD],
  ['ok(pair[0]) || pair[0] !== pair[1]) return refuse("reads");', 'ok(pair[0])) return refuse("reads");', ONC, ONWARD],
  ['if (!uint(reads.priorityCap)) return refuse("reads");', "", ONC, ONWARD],
  ["const estimate = hasCode || nitro ? agreed(reads.estimate, uint) : null;", "const estimate = reads.estimate ? agreed(reads.estimate, uint) : null;", ONC, ONWARD],
  ["const estimate = hasCode || nitro ?", "const estimate = hasCode ?", ONRH, ONWARD],
  ['const nitro = ask.chain === "robinhood";', "const nitro = false;", ONRH, ONWARD],
  ['if (nitro && l1Fee !== 0n) return refuse("l1_fee");', "", ONRH, ONWARD],
  ['if (t.chainId !== pins.chainId) return refuse("chain_id");', "", ONC, ONWARD],
  ["!EVM_ADDRESS.test(to) || lower(to) === ZERO_ADDRESS", "lower(to) === ZERO_ADDRESS", ONC, ONWARD],
  [" || lower(to) === ZERO_ADDRESS", "", ONC, ONWARD],
  [" || lower(to) === lower(pins.pool)", "", ONC, ONWARD],
  [' || lower(to) === lower(ctx.wallet)) return refuse("to");', ') return refuse("to");', ONC, ONWARD],
  ['if (lower(t.to) !== lower(to)) return refuse("transfer_to");', "", ONC, ONWARD],
  ['if (t.nonce !== nonce) return refuse("nonce");', "", ONC, ONWARD],
  ['if (t.data !== "0x") return refuse("data");', "", ONC, ONWARD],
  ['if (t.accessList.length !== 0) return refuse("access_list");', "", ONC, ONWARD],
  ['if (t.gasLimit !== EVM_ONWARD_GAS) return refuse("gas_limit");', "", ONC, ONWARD],
  ['if (t.gasLimit !== estimate) return refuse("gas_estimate");', "", ONC, ONWARD],
  ['if (t.gasLimit > EVM_ONWARD_GAS_MAX) return refuse("gas_over_cap");', "", ONC, ONWARD],
  ["export const EVM_ONWARD_GAS_MAX = 100_000n;", "export const EVM_ONWARD_GAS_MAX = 100_001n;", ONC, ONWARD],
  ['if (t.maxPriorityFeePerGas > reads.priorityCap || t.maxPriorityFeePerGas > t.maxFeePerGas) return refuse("priority_fee");', "", ONC, ONWARD],
  [" || t.maxPriorityFeePerGas > t.maxFeePerGas) return", ") return", ONF, ONWARD],
  ['if (t.maxFeePerGas > 2n * baseFee + reads.priorityCap || t.maxFeePerGas < baseFee) return refuse("max_fee");', "", ONC, ONWARD],
  [" || t.maxFeePerGas < baseFee) return", ") return", ONF, ONWARD],
  ["t.maxFeePerGas > 2n * baseFee", "t.maxFeePerGas > 3n * baseFee", ONC, ONWARD],
  ["t.value + feeBound !== balance", "t.value + feeBound > balance", ONC, ONWARD],
  ["t.value + feeBound !== balance", "t.value + feeBound < balance", ONC, ONWARD],
  ['if (t.value === 0n || t.value', "if (t.value", ONC, ONWARD],
  ["const feeBound = t.gasLimit * t.maxFeePerGas + l1Fee;", "const feeBound = t.gasLimit * t.maxFeePerGas;", ONC, ONWARD],
  ["  ONWARD_CHECKED.set(tx, Object.freeze({ ...t, wallet: lower(ctx.wallet) }));\n", "", ONS, ONWARD],
  ['if (!read) return refuse("unchecked");', "", ONS, ONWARD],
  ['    return refuse("unchecked");\n  }\n  const fields', "    now = read;\n  }\n  const fields", ONS, ONWARD],
  ['if (fields.some((k) => now[k] !== read[k]) || now.accessList.length !== 0) return refuse("unchecked");', "", ONS, ONWARD],
  [' || now.accessList.length !== 0) return refuse("unchecked");', ') return refuse("unchecked");', ONS, ONWARD],
  ['!== read.wallet) return refuse("wallet");', '=== "") return refuse("wallet");', ONS, ONWARD],
];

// a child test run must not inherit this process's own node --test context (when the sweep runs as a test, the child
// would report to the parent's runner and print no summary of its own)
const CHILD_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined };
const run = (name, file) => {
  try {
    const out = execFileSync(process.execPath, ["--test", "--test-timeout=120000", "--test-name-pattern", name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: CHILD_ENV });
    return { ok: true, ran: /ℹ pass [1-9]/.test(out) };
  } catch (e) {
    return { ok: false, ran: true, out: String(e.stdout ?? "") };
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const original = readFileSync(POOL, "utf8");
  const files = [TEST, ONWARD];
  process.on("exit", () => { for (const f of files) rmSync(mutantTestOf(f), { force: true }); rmSync(MUTANT_SRC, { force: true }); });
  for (const f of files) {
    const test = readFileSync(testOf(f), "utf8");
    if (test.split(IMPORT).length !== 2) { console.log(`BAD  ${f} imports pool.ts not once`); process.exit(1); }
    writeFileSync(mutantTestOf(f), test.replace(IMPORT, `from "../src/rules/.pool-mutant-${process.pid}.ts";`));
  }
  // an interrupt removes the copies too (exit runs the handler above)
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
  let bad = 0;
  for (const key of new Set(MUTANTS.map((m) => `${m[3] ?? TEST}\0${m[2]}`))) {
    const [file, name] = key.split("\0");
    const r = run(name, testOf(file));
    if (!r.ok || !r.ran) { console.log(`BAD  "${name}" does not pass on the code as it is`); bad++; }
  }
  for (const [text, repl, name, file = TEST] of MUTANTS) {
    const n = original.split(text).length - 1;
    if (n !== 1) { console.log(`BAD  mutant text ${n} times in pool.ts, not once: ${text.slice(0, 80)}`); bad++; continue; }
    writeFileSync(MUTANT_SRC, original.replace(text, () => repl));
    try {
      const r = run(name, mutantTestOf(file));
      if (r.ok) { console.log(`LIVE "${name}" passes with: ${text.slice(0, 90)}`); bad++; }
      else console.log(`killed  ${text.slice(0, 90).replace(/\n/g, " ")}`);
    } finally {
      rmSync(MUTANT_SRC, { force: true });
    }
  }
  console.log(bad === 0 ? `all ${MUTANTS.length} mutants killed` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
