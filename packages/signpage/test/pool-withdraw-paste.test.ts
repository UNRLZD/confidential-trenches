// Card withdraw-form-shows-what-you-can-send: what a real paste into the pool withdraw screen's To carries, and what the
// screen shows while an address is typed (src/withdraw/pool-form.ts). A copy brings whitespace (spaces, a tab, a line
// break) and invisible format characters (a zero-width space, a byte-order mark, a direction mark) around or inside the
// address: each is taken out and the address inside passes, the To drawn and handed over being that address. Anything
// else is not taken out: a "solana:" or "ethereum:" link is refused, as is an address cut short.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_IDLE_MS } from "../src/withdraw/form.ts";
import { checkPoolTo, drawPoolWithdrawForm, evaluatePool, type PoolFunds } from "../src/withdraw/pool-form.ts";

const POOL = "4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy";
const KEYS = { pool: POOL, program: "9rTKx2KjYLXGKXwJvCGrCRBEPnrpD5Ctfsx4y5DRiw3T", feePayer: "7MLmfjrk5gj6kTzNuMQovz3gnVbRe2Y5k8GW4uLkjqt9" };
const TO = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx";
// EIP-55's own test vector (eips.ethereum.org/EIPS/eip-55)
const EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const EVM_KEYS = { pool: "0x1111111111111111111111111111111111111111" };
const FUNDS: PoolFunds = { notes: [{ id: "a", value: 30_000_000n }], fee: 1_300_000n, wFee: 5_000n, minPart: 1_890_880n };

/** What a paste can carry around (and, for the invisible ones, inside) an address. */
const carried = (a: string): [string, string][] => [
  ["spaces around", `  ${a}  `],
  ["a line break after", `${a}\n`],
  ["CRLF around", `\r\n${a}\r\n`],
  ["a tab before", `\t${a}`],
  ["a no-break space after", `${a} `],
  ["a zero-width space before", `​${a}`],
  ["a zero-width space inside", `${a.slice(0, 10)}​${a.slice(10)}`],
  ["a byte-order mark before", `﻿${a}`],
  ["a word joiner after", `${a}⁠`],
  ["a left-to-right mark before", `‎${a}`],
  ["a line break inside (a wrapped copy)", `${a.slice(0, 20)}\n${a.slice(20)}`],
];

test("To on Solana: the address inside each paste passes, and the one checked is the address alone", () => {
  for (const [what, raw] of carried(TO)) assert.deepEqual(checkPoolTo("solana", raw, KEYS), { ok: true, to: TO }, what);
});

test("To on Base and Robinhood: the address inside each paste passes, checksummed", () => {
  for (const chain of ["base", "robinhood"] as const) {
    for (const [what, raw] of carried(EVM)) assert.deepEqual(checkPoolTo(chain, raw, EVM_KEYS), { ok: true, to: EVM }, `${chain} ${what}`);
  }
});

test("nothing but whitespace and invisible characters is taken out: a payment link, a cut address or another character is refused", () => {
  for (const raw of [`solana:${TO}`, `solana:${TO}?amount=0.1`, `SOLANA:${TO}`, TO.slice(0, 22), `${TO}.`, `"${TO}"`, `<${TO}>`]) {
    assert.deepEqual(checkPoolTo("solana", raw, KEYS), { ok: false, code: "address" }, raw);
  }
  for (const raw of [`ethereum:${EVM}`, `ethereum:${EVM}@8453`, EVM.slice(0, 22), `${EVM},`]) {
    assert.deepEqual(checkPoolTo("base", raw, EVM_KEYS), { ok: false, code: "address" }, raw);
  }
});

test("a field holding only what a paste carries is blank, not refused", () => {
  for (const raw of ["​", "﻿", " \n\t", "⁠‎"]) assert.equal(evaluatePool("solana", raw, "", KEYS, FUNDS).state, "empty", JSON.stringify(raw));
});

test("the screen's view of a paste: ready, and the To it hands over is the address alone", () => {
  const v = evaluatePool("solana", `﻿ ${TO}​\n`, "0.002", KEYS, FUNDS);
  assert.equal(v.state, "ready");
  assert.equal(v.ready?.to, TO);
});

// ---------- while typing ----------

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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("while typing: each key draws typing with no refusal; a check runs only CHECK_IDLE_MS after the last key, on the whole field", async () => {
  const doc = { createElement: () => new El() } as unknown as Document;
  const button = (action: string, label: string, onClick: () => void) => {
    const b = new El();
    b.dataset.action = action;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b as unknown as HTMLButtonElement;
  };
  const form = drawPoolWithdrawForm(doc, { chain: "solana", keys: KEYS, funds: async () => FUNDS }, button, () => {}) as unknown as El;
  const to = form.find((e) => e.dataset.input === "to")!;
  const line = form.find((e) => e.dataset.for === "to")!;
  // typed by hand, a key every 100 ms: never refused while the keys come
  for (let i = 1; i <= 8; i++) {
    to.value = TO.slice(0, i * 4);
    to.fire("input");
    assert.equal(form.dataset.state, "typing", `key ${i}`);
    assert.equal(line.hidden, true, `key ${i}: no refusal while typing`);
    await wait(100);
  }
  // a pause past the idle time on a half-typed address: refused, as any address cut short is
  await wait(CHECK_IDLE_MS);
  assert.equal(form.dataset.state, "refused");
  assert.equal(line.dataset.refusal, "address");
  // the next key takes the refusal away until the next pause
  to.value = TO;
  to.fire("input");
  assert.equal(form.dataset.state, "typing");
  assert.equal(line.hidden, true);
  await wait(CHECK_IDLE_MS + 60);
  assert.equal(line.hidden, true, "the whole address passes");
  // a paste is one input: checked whole, once, after the idle time
  to.value = `​${TO}\n`;
  to.fire("input");
  await wait(CHECK_IDLE_MS + 60);
  assert.equal(line.hidden, true, "the pasted address passes");
});
