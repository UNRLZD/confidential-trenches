// Card signpage-pool-withdraw-form: the pool withdraw screen (src/withdraw/pool-form.ts). To is checked per chain
// (Solana base58 keys, never the pool's own; EVM 0x addresses, EIP-55 when mixed case, never zero or the pool), the
// amount is refused above what the pool's notes can send, and To and Max fee are drawn before the press.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_IDLE_MS } from "../src/withdraw/form.ts";
import { SOLANA_RESERVED_KEYS } from "../src/rules/pool.ts";
import { checkPoolAmount, checkPoolTo, drawPoolWithdrawForm, eip55, evaluatePool, formatUnits, parseUnits, poolRefusalWords, POOL_WITHDRAW_WORDS, type PoolFunds, type PoolReady } from "../src/withdraw/pool-form.ts";

const POOL = "4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy";
// stand-ins that are no key the runtime reserves, so each refusal below is its own check's
const PROGRAM = "9rTKx2KjYLXGKXwJvCGrCRBEPnrpD5Ctfsx4y5DRiw3T";
const FEE_PAYER = "7MLmfjrk5gj6kTzNuMQovz3gnVbRe2Y5k8GW4uLkjqt9";
const KEYS = { pool: POOL, program: PROGRAM, feePayer: FEE_PAYER };
const TO = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx";
// EIP-55's own test vector (eips.ethereum.org/EIPS/eip-55)
const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const EVM_POOL = "0x1111111111111111111111111111111111111111";
const FEE = 1_300_000n;
const MIN = 1_890_880n;
const W_FEE = 5_000n;
const FUNDS: PoolFunds = { notes: [{ id: "a", value: 30_000_000n }, { id: "b", value: 10_000_000n }], fee: FEE, wFee: W_FEE, minPart: MIN };

test("To on Solana: a base58 key passes; the pool, its program, the fee payer, any key the runtime keeps read-only and any non-key are refused", () => {
  assert.deepEqual(checkPoolTo("solana", ` ${TO} `, KEYS), { ok: true, to: TO });
  for (const bad of [POOL, PROGRAM, FEE_PAYER, "11111111111111111111111111111111", ...SOLANA_RESERVED_KEYS, TO.slice(6), TO + "1", "0OIl" + TO.slice(4), CHECKSUMMED, ""]) {
    assert.deepEqual(checkPoolTo("solana", bad, KEYS), { ok: false, code: "address" }, bad);
  }
});

test("To on Base and Robinhood: 0x and 40 hex digits, EIP-55 right when mixed case, never zero or the pool", () => {
  assert.equal(eip55(CHECKSUMMED.toLowerCase()), CHECKSUMMED);
  for (const chain of ["base", "robinhood"] as const) {
    const keys = { pool: EVM_POOL };
    assert.deepEqual(checkPoolTo(chain, CHECKSUMMED, keys), { ok: true, to: CHECKSUMMED });
    assert.deepEqual(checkPoolTo(chain, CHECKSUMMED.toLowerCase(), keys), { ok: true, to: CHECKSUMMED }, "one case: no checksum to check");
    assert.deepEqual(checkPoolTo(chain, "0x" + CHECKSUMMED.slice(2).toUpperCase(), keys), { ok: true, to: CHECKSUMMED });
    const flipped = CHECKSUMMED.replace("aA", "Aa");
    for (const bad of [flipped, "0x" + "0".repeat(40), EVM_POOL, EVM_POOL.toUpperCase().replace("0X", "0x"), CHECKSUMMED.slice(0, 41), TO]) {
      assert.deepEqual(checkPoolTo(chain, bad, keys), { ok: false, code: "address" }, `${chain} ${bad}`);
    }
  }
});

test("Amount: refused above what the notes can send, under the smallest part, or not a decimal of the asset; else its parts and Max fee", () => {
  assert.equal(parseUnits("0.002", 9), 2_000_000n);
  assert.equal(parseUnits("1.0000000001", 9), null);
  assert.equal(formatUnits(2_600_000n, 9), "0.0026");
  const most = 40_000_000n - 2n * (FEE + W_FEE);
  assert.deepEqual(checkPoolAmount("solana", formatUnits(most + 1n, 9), FUNDS), { ok: false, code: "insufficient" });
  assert.deepEqual(checkPoolAmount("solana", "1", FUNDS), { ok: false, code: "insufficient" });
  assert.deepEqual(checkPoolAmount("solana", formatUnits(MIN - 1n, 9), FUNDS), { ok: false, code: "min", min: MIN });
  for (const bad of ["", "0", "-1", "1e3", "0.0000000001", "abc"]) assert.deepEqual(checkPoolAmount("solana", bad, FUNDS), { ok: false, code: "amount" }, bad);
  assert.deepEqual(checkPoolAmount("solana", "0.002", null), { ok: false, code: "unread" });
  // Max fee: each part's relay fee and W's own fee for its send onward
  assert.deepEqual(checkPoolAmount("solana", "0.002", FUNDS), { ok: true, amount: 2_000_000n, parts: 1, maxFee: FEE + W_FEE });
  assert.deepEqual(checkPoolAmount("solana", formatUnits(most, 9), FUNDS), { ok: true, amount: most, parts: 2, maxFee: 2n * (FEE + W_FEE) });
  const v = evaluatePool("solana", TO, "0.002", KEYS, FUNDS);
  assert.equal(v.state, "ready");
  assert.deepEqual(v.ready, { chain: "solana", to: TO, amount: 2_000_000n, maxFee: FEE + W_FEE });
  assert.equal(evaluatePool("solana", POOL, "0.002", KEYS, FUNDS).state, "refused");
  assert.equal(evaluatePool("solana", "", "", KEYS, FUNDS).state, "empty");
});

// ---------- the drawn screen ----------

class El {
  dataset: Record<string, string> = {};
  children: El[] = [];
  textContent = "";
  hidden = false;
  disabled = false;
  value = "";
  type = "";
  autocomplete = "";
  spellcheck = true;
  inputMode = "";
  on: Record<string, Array<() => void>> = {};
  tag: string;
  constructor(tag: string) { this.tag = tag; }
  append(...c: El[]): void { this.children.push(...c); }
  replaceChildren(...c: El[]): void { this.children = c; this.textContent = ""; }
  setAttribute(): void {}
  addEventListener(type: string, f: () => void): void { (this.on[type] ??= []).push(f); }
  fire(type: string): void { for (const f of this.on[type] ?? []) f(); }
  find(p: (e: El) => boolean): El | undefined {
    for (const c of this.children) { if (p(c)) return c; const d = c.find(p); if (d) return d; }
    return undefined;
  }
}
const settle = () => new Promise((r) => setTimeout(r, CHECK_IDLE_MS + 60));

function drawn(funds: () => Promise<PoolFunds> = async () => FUNDS) {
  const handed: PoolReady[] = [];
  const steps: Promise<void>[] = [];
  const doc = { createElement: (tag: string) => new El(tag) } as unknown as Document;
  const button = (action: string, label: string, onClick: () => void) => {
    const b = new El("button");
    b.dataset.action = action;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b as unknown as HTMLButtonElement;
  };
  const form = drawPoolWithdrawForm(doc, { chain: "solana", keys: KEYS, funds, handoff: (r) => void handed.push(r) }, button, (s) => void steps.push(s())) as unknown as El;
  const input = (k: string) => form.find((e) => e.dataset.input === k)!;
  return {
    form, handed,
    go: form.find((e) => e.dataset.action === "withdraw")!,
    lines: form.find((e) => e.dataset.lines === "pool-withdraw")!,
    input,
    type: (k: "to" | "amount", v: string) => { input(k).value = v; input(k).fire("input"); },
    tap: async () => { form.find((e) => e.dataset.action === "withdraw")!.fire("click"); await Promise.all(steps.splice(0)); },
  };
}

test("the drawn screen: To and Max fee shown before the press, the press hands over what was drawn, a refused amount draws its words", async () => {
  const f = drawn();
  assert.equal(f.go.disabled, true);
  assert.equal(f.lines.hidden, true);
  f.type("to", TO);
  f.type("amount", "1");
  await settle();
  assert.equal(f.form.dataset.state, "refused");
  const refusal = f.form.find((e) => e.dataset.for === "amount")!;
  assert.equal(refusal.dataset.refusal, "insufficient");
  assert.equal(refusal.textContent, POOL_WITHDRAW_WORDS.insufficient);
  assert.equal(f.go.disabled, true);
  await f.tap();
  assert.deepEqual(f.handed, [], "a refused screen hands nothing over");
  f.type("amount", "0.002");
  await settle();
  assert.equal(f.form.dataset.state, "ready");
  assert.equal(f.lines.hidden, false);
  const shown = Object.fromEntries(f.lines.children.filter((e) => e.tag === "dd").map((e) => [e.dataset.line, e.textContent]));
  assert.deepEqual(shown, { to: TO, "max-fee": "0.001305 SOL" });
  assert.deepEqual(f.lines.children.filter((e) => e.tag === "dt").map((e) => e.dataset.draftCopy), ["to", "max-fee"]);
  assert.equal(f.go.disabled, false);
  await f.tap();
  assert.deepEqual(f.handed, [{ chain: "solana", to: TO, amount: 2_000_000n, maxFee: FEE + W_FEE }]);
});

// review #232 HIGH 2: an amount no plan sends without a change no withdraw could ever send is refused, naming the
// nearest amounts that can be sent
test("Amount: one no plan sends without dust is refused with the nearest amounts that can be sent, each of them sendable", () => {
  const one: PoolFunds = { ...FUNDS, notes: [{ id: "a", value: 10_000_000n }] };
  const cap = 10_000_000n - FEE - W_FEE;
  const floor = FEE + W_FEE + MIN;
  const got = checkPoolAmount("solana", formatUnits(cap - 1n, 9), one);
  assert.deepEqual(got, { ok: false, code: "unplannable", below: cap - floor, above: cap });
  for (const x of [cap - floor, cap]) assert.equal(checkPoolAmount("solana", formatUnits(x, 9), one).ok, true, String(x));
  assert.equal(checkPoolAmount("solana", formatUnits(cap - floor + 1n, 9), one).ok, false);
  assert.equal(poolRefusalWords("solana", "unplannable", undefined, { below: cap - floor, above: cap }), `Try ${formatUnits(cap - floor, 9)} or ${formatUnits(cap, 9)} SOL`);
  assert.equal(poolRefusalWords("solana", "unplannable", undefined, { above: cap }), `Try ${formatUnits(cap, 9)} SOL`);
});

test("the drawn screen: an unplannable amount draws the nearest amounts, under the try words' draft key", async () => {
  const f = drawn(async () => ({ ...FUNDS, notes: [{ id: "a", value: 10_000_000n }] }));
  f.type("to", TO);
  f.type("amount", formatUnits(10_000_000n - FEE - W_FEE - 1n, 9));
  await settle();
  const refusal = f.form.find((e) => e.dataset.for === "amount")!;
  assert.equal(refusal.dataset.refusal, "unplannable");
  assert.equal(refusal.dataset.draftCopy, "try");
  assert.match(refusal.textContent, /^Try \S+ or \S+ SOL$/);
});

// review #232 LOW: the press compares the amount it reads now with the one drawn, not only the input events
test("the press: an amount changed with no input event (a script, an autofill) hands nothing over", async () => {
  const f = drawn();
  f.type("to", TO);
  f.type("amount", "0.002");
  await settle();
  assert.equal(f.form.dataset.state, "ready");
  f.input("amount").value = "0.003";
  await f.tap();
  assert.deepEqual(f.handed, [], "the drawn 0.002 is not what the field holds at the press");
});

test("the press reads the funds again: a note spent meanwhile hands nothing over", async () => {
  let funds = FUNDS;
  const f = drawn(async () => funds);
  f.type("to", TO);
  f.type("amount", "0.03");
  await settle();
  assert.equal(f.form.dataset.state, "ready");
  funds = { ...FUNDS, notes: [FUNDS.notes[1]!] };
  await f.tap();
  assert.deepEqual(f.handed, []);
  assert.equal(f.form.dataset.state, "refused");
});
