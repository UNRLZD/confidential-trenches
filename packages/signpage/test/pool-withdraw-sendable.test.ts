// Card withdraw-form-shows-what-you-can-send: the pool withdraw screen (src/withdraw/pool-form.ts) draws the chain it
// is for (the app's mark and the chain's name, src/withdraw/chain-mark.ts), the asset's symbol at the amount, and what
// can be sent now: a value and its symbol that fills the amount when tapped, exactly the largest amount the amount check
// accepts (poolSendable), so a tap never draws Insufficient or Try. No word is added. The press still hands over only an
// answer equal to the one drawn.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { drawPool } from "../src/rules/pool.ts";
import { POOL_CHAIN_MARK } from "../src/withdraw/chain-mark.ts";
import { CHECK_IDLE_MS } from "../src/withdraw/form.ts";
import { checkPoolAmount, drawPoolWithdrawForm, formatUnits, POOL_ASSET, POOL_WITHDRAW_WORDS, poolSendable, type PoolFunds, type PoolReady, type PoolWithdrawFormDeps } from "../src/withdraw/pool-form.ts";
import { plannableAmounts, poolWithdrawable } from "../src/pool-withdraw.ts";

const POOL = "4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy";
const KEYS = { pool: POOL, program: "9rTKx2KjYLXGKXwJvCGrCRBEPnrpD5Ctfsx4y5DRiw3T", feePayer: "7MLmfjrk5gj6kTzNuMQovz3gnVbRe2Y5k8GW4uLkjqt9" };
const TO = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx";
const EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const FEE = 1_300_000n;
const W_FEE = 5_000n;
const MIN = 1_890_880n;
// the owner's 17:53Z case: one 0.05 SOL deposit
const ONE: PoolFunds = { notes: [{ id: "a", value: 50_000_000n }], fee: FEE, wFee: W_FEE, minPart: MIN };
const TWO: PoolFunds = { notes: [{ id: "a", value: 30_000_000n }, { id: "b", value: 10_000_000n }], fee: FEE, wFee: W_FEE, minPart: MIN };
const CHAINS = ["solana", "base", "robinhood"] as const;

// ---------- the chain's mark and name ----------

test("each chain's mark is the app's own file, byte for byte, and its name the chain line SIGN_HOST draws", () => {
  const file = { solana: "solana.svg", base: "base.svg", robinhood: "robinhood.png" } as const;
  for (const chain of CHAINS) {
    const m = POOL_CHAIN_MARK[chain];
    const at = m.logo.indexOf(";base64,");
    assert.ok(m.logo.startsWith(file[chain].endsWith(".svg") ? "data:image/svg+xml;base64," : "data:image/png;base64,"), chain);
    const app = readFileSync(new URL(`../../../apps/terminal/src/screens/market/logos/${file[chain]}`, import.meta.url));
    assert.ok(Buffer.from(m.logo.slice(at + 8), "base64").equals(app), `${chain}: the app's ${file[chain]}`);
    const line = drawPool({ chain, op: "pool.withdraw", token: null, amount: 1n, feeCap: 1n, pool: POOL, to: TO, decimals: 9, back: null });
    assert.deepEqual(line[0], ["Chain", m.name], chain);
  }
  // the app's insets (apps/terminal/src/screens/market/pads.ts CHAINS)
  assert.deepEqual(CHAINS.map((c) => POOL_CHAIN_MARK[c].inset), [0.2, 0.2, 0]);
});

// ---------- what can be sent ----------

test("what can be sent: the notes less their fees, the largest the amount check accepts; one unit more is refused", () => {
  assert.equal(poolSendable(ONE), 50_000_000n - FEE - W_FEE);
  assert.equal(formatUnits(poolSendable(ONE), 9), "0.048695");
  assert.equal(poolSendable(TWO), 40_000_000n - 2n * (FEE + W_FEE));
  assert.equal(poolSendable({ ...ONE, notes: [] }), 0n);
  assert.equal(poolSendable({ ...ONE, notes: [{ id: "dust", value: FEE + W_FEE + MIN - 1n }] }), 0n, "a note under the smallest part sends nothing");
  // random note sets: the value is accepted, one unit more is Insufficient or has no plan
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let i = 0; i < 300; i++) {
    const notes = Array.from({ length: 1 + rnd(6) }, (_, j) => ({ id: `n${j}`, value: BigInt(1 + rnd(60_000_000)) }));
    const f: PoolFunds = { notes, fee: FEE, wFee: W_FEE, minPart: MIN };
    const s = poolSendable(f);
    assert.ok(s <= poolWithdrawable(notes, f), "never above the Insufficient rule's sum");
    if (s === 0n) {
      { const most = poolWithdrawable(notes, f); assert.ok(!plannableAmounts(notes, f).some(([lo, hi]) => lo <= most && (hi < most ? hi : most) >= MIN), "0 only when nothing can be sent"); }
      continue;
    }
    for (const chain of CHAINS) {
      const d = POOL_ASSET[chain].decimals;
      assert.deepEqual(checkPoolAmount(chain, formatUnits(s, d), f).ok, true, `${chain} ${s}`);
    }
    const more = checkPoolAmount("solana", formatUnits(s + 1n, 9), f);
    assert.ok(!more.ok && (more.code === "insufficient" || more.code === "unplannable"), `${s + 1n}: ${JSON.stringify(more, (_, v) => (typeof v === "bigint" ? String(v) : v))}`);
  }
});

// ---------- the drawn screen ----------

class El {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: El[] = [];
  textContent = "";
  hidden = false;
  disabled = false;
  value = "";
  type = "";
  src = "";
  alt = "";
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
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
}
const settle = () => new Promise((r) => setTimeout(r, CHECK_IDLE_MS + 60));
const tick = () => new Promise((r) => setTimeout(r, 0));

function drawn(chain: (typeof CHAINS)[number], funds: () => Promise<PoolFunds>, more: Partial<PoolWithdrawFormDeps> = {}) {
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
  const keys = chain === "solana" ? KEYS : { pool: "0x1111111111111111111111111111111111111111" };
  const form = drawPoolWithdrawForm(doc, { chain, keys, funds, handoff: (r) => void handed.push(r), ...more }, button, (s) => void steps.push(s())) as unknown as El;
  const input = (k: string) => form.find((e) => e.dataset.input === k)!;
  return {
    form, handed, input,
    can: form.find((e) => e.dataset.action === "sendable")!,
    row: form.find((e) => e.dataset.row === "sendable")!,
    type: (k: "to" | "amount", v: string) => { input(k).value = v; input(k).fire("input"); },
    press: async () => { form.find((e) => e.dataset.action === "withdraw")!.fire("click"); await Promise.all(steps.splice(0)); },
  };
}

test("the screen draws the chain's mark and name first, and the asset's symbol right after the amount field", () => {
  for (const chain of CHAINS) {
    const f = drawn(chain, async () => ONE);
    const head = f.form.children[0]!;
    assert.equal(head.dataset.mark, chain);
    const img = head.find((e) => e.tag === "img")!;
    assert.equal(img.src, POOL_CHAIN_MARK[chain].logo);
    assert.equal(img.alt, "", "the name beside it says it");
    assert.deepEqual(head.all().filter((e) => e.tag === "span" && e.textContent).map((e) => e.textContent), [POOL_CHAIN_MARK[chain].name]);
    const label = f.form.children.find((e) => e.tag === "label" && e.find((x) => x.dataset.input === "amount"))!;
    const at = label.children.findIndex((e) => e.dataset.input === "amount");
    assert.equal(label.children[at + 1]?.textContent, POOL_ASSET[chain].symbol, chain);
  }
});

test("what can be sent: hidden until the funds are read, then the value and its symbol; none sendable draws 0, not tappable", async () => {
  let open: (f: PoolFunds) => void = () => {};
  const f = drawn("solana", () => new Promise((r) => (open = r)));
  assert.equal(f.row.hidden, true);
  open(ONE);
  await tick();
  assert.equal(f.row.hidden, false);
  assert.equal(f.can.textContent, "0.048695 SOL");
  assert.equal(f.can.disabled, false);
  assert.equal(f.can.style.minHeight, "44px", "the phone's tap target");
  const none = drawn("base", async () => ({ ...ONE, notes: [] }));
  await tick();
  assert.equal(none.can.textContent, "0 ETH");
  assert.equal(none.can.disabled, true);
  const unread = drawn("solana", async () => Promise.reject(new Error("down")));
  await tick();
  assert.equal(unread.row.hidden, true, "unread: no figure drawn");
});

test("the tap fills the amount with what can be sent: ready, never Insufficient or Try, and the press hands over exactly what was drawn", async () => {
  for (const [chain, to, funds] of [["solana", TO, ONE], ["solana", TO, TWO], ["base", EVM, { ...TWO, notes: TWO.notes.map((n) => ({ ...n, value: n.value * 10n ** 9n })) }]] as const) {
    const f = drawn(chain, async () => funds);
    f.type("to", to);
    await settle();
    f.can.fire("click");
    await tick();
    const want = poolSendable(funds);
    assert.equal(f.input("amount").value, formatUnits(want, POOL_ASSET[chain].decimals));
    assert.equal(f.form.dataset.state, "ready", `${chain}: the tap is checked now, no idle wait`);
    assert.equal(f.form.find((e) => e.dataset.for === "amount")!.hidden, true, "no refusal line");
    await f.press();
    assert.equal(f.handed.length, 1);
    assert.deepEqual({ ...f.handed[0] }, { chain, to, amount: want, maxFee: BigInt(funds.notes.length) * (FEE + W_FEE) });
  }
});

test("the press after a tap: a note spent since hands nothing over, and the figure drawn is the new one", async () => {
  let funds = TWO;
  const f = drawn("solana", async () => funds);
  f.type("to", TO);
  await settle();
  f.can.fire("click");
  await tick();
  assert.equal(f.form.dataset.state, "ready");
  funds = { ...TWO, notes: [TWO.notes[1]!] };
  await f.press();
  assert.deepEqual(f.handed, []);
  assert.equal(f.form.dataset.state, "refused");
  assert.equal(f.can.textContent, `${formatUnits(poolSendable(funds), 9)} SOL`);
});

test("no new word: every text the screen draws is a kept word, a chain name, a symbol or a value", async () => {
  const f = drawn("solana", async () => ONE);
  f.type("to", TO);
  await settle();
  f.can.fire("click");
  await tick();
  const words = new Set<string>([...Object.values(POOL_WITHDRAW_WORDS), ...CHAINS.map((c) => POOL_CHAIN_MARK[c].name), "SOL", "ETH"]);
  const value = /^\d+(?:\.\d+)? (?:SOL|ETH)$/;
  for (const e of f.form.all().filter((x) => x.textContent && x.children.length === 0)) {
    assert.ok(words.has(e.textContent) || value.test(e.textContent) || e.textContent === TO, JSON.stringify(e.textContent));
  }
});
