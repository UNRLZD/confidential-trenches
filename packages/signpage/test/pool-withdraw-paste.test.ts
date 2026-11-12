// Card withdraw-form-shows-what-you-can-send: what a real paste into the pool withdraw screen's To carries, and what the
// screen shows while an address is typed (src/withdraw/pool-form.ts). A copy brings whitespace (spaces, a tab, a line
// break) and invisible format characters around the address, and invisible joiners (zero-width space, joiners, word
// joiner, byte-order mark, soft hyphen) inside it: each is taken out and the address passes, the To drawn and handed over
// being that address. Whitespace inside is refused (it would glue two pieces of a row into another key), a direction
// control anywhere is refused, and so is anything else: a "solana:" or "ethereum:" link, a look-alike letter, a cut.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_IDLE_MS } from "../src/withdraw/form.ts";
import { checkPoolTo, drawPoolWithdrawForm, evaluatePool, type PoolFunds, type PoolReady } from "../src/withdraw/pool-form.ts";

const POOL = "4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy";
const KEYS = { pool: POOL, program: "9rTKx2KjYLXGKXwJvCGrCRBEPnrpD5Ctfsx4y5DRiw3T", feePayer: "7MLmfjrk5gj6kTzNuMQovz3gnVbRe2Y5k8GW4uLkjqt9" };
const TO = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx";
// EIP-55's own test vector (eips.ethereum.org/EIPS/eip-55)
const EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const EVM_KEYS = { pool: "0x1111111111111111111111111111111111111111" };
const FUNDS: PoolFunds = { notes: [{ id: "a", value: 30_000_000n }], fee: 1_300_000n, wFee: 5_000n, minPart: 1_890_880n };

/** What a paste can carry around an address, and the invisible joiners it can carry inside one. */
const carried = (a: string): [string, string][] => [
  ["spaces around", `  ${a}  `],
  ["a line break after", `${a}\n`],
  ["CRLF around", `\r\n${a}\r\n`],
  ["a tab before", `\t${a}`],
  ["a no-break space after", `${a}\u00a0`],
  ["a zero-width space before", `\u200b${a}`],
  ...[["a zero-width space", "\u200b"], ["a zero-width non-joiner", "\u200c"], ["a zero-width joiner", "\u200d"], ["a word joiner", "\u2060"], ["a byte-order mark", "\ufeff"], ["a soft hyphen", "\u00ad"]]
    .map(([n, c]): [string, string] => [`${n} inside`, `${a.slice(0, 10)}${c}${a.slice(10)}`]),
  ["a byte-order mark before", `\ufeff${a}`],
  ["a word joiner after", `${a}\u2060`],
];
/** The direction controls: refused anywhere in the field. */
const DIRECTION = ["\u061c", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"];
// a 43-character address (base58 of 32 bytes), as the rows below use
const TO43 = "6x9oCLCqaQqYY2BaybVn75Tt7HTSsS3cPaMG7LbgGTX";

test("To on Solana: the address inside each paste passes, and the one checked is the address alone", () => {
  for (const [what, raw] of carried(TO)) assert.deepEqual(checkPoolTo("solana", raw, KEYS), { ok: true, to: TO }, what);
});

test("To on Base and Robinhood: the address inside each paste passes, checksummed", () => {
  for (const chain of ["base", "robinhood"] as const) {
    for (const [what, raw] of carried(EVM)) assert.deepEqual(checkPoolTo(chain, raw, EVM_KEYS), { ok: true, to: EVM }, `${chain} ${what}`);
  }
});

test("whitespace inside is refused, never taken out: a row's pieces are never glued into another key", () => {
  assert.equal(TO43.length, 43);
  assert.deepEqual(checkPoolTo("solana", TO43, KEYS), { ok: true, to: TO43 }, "the key alone passes");
  // the review's rows: a numbered row and an "address amount" row, each a valid key when glued
  for (const raw of [`3\t${TO43}`, `${TO43} 5`, `3 ${TO43}`, `${TO43}\t0.1`, `${TO.slice(0, 20)}\n${TO.slice(20)}`, `${TO.slice(0, 20)} ${TO.slice(20)}`, `${TO.slice(0, 20)}\u00a0${TO.slice(20)}`]) {
    assert.deepEqual(checkPoolTo("solana", raw, KEYS), { ok: false, code: "address" }, JSON.stringify(raw));
  }
  assert.deepEqual(checkPoolTo("base", `${EVM.slice(0, 20)} ${EVM.slice(20)}`, EVM_KEYS), { ok: false, code: "address" });
});

test("a direction control is refused anywhere in the field: before, inside, after, and an override showing a reversed key", () => {
  for (const c of DIRECTION) {
    for (const raw of [`${c}${TO}`, `${TO.slice(0, 10)}${c}${TO.slice(10)}`, `${TO}${c}`]) {
      assert.deepEqual(checkPoolTo("solana", raw, KEYS), { ok: false, code: "address" }, `U+${c.codePointAt(0)!.toString(16)} in ${JSON.stringify(raw)}`);
    }
    assert.deepEqual(checkPoolTo("base", `${c}${EVM}`, EVM_KEYS), { ok: false, code: "address" }, `base U+${c.codePointAt(0)!.toString(16)}`);
  }
  // a right-to-left override in front of a reversed key: shown as the key, held as another one
  const reversed = [...TO].reverse().join("");
  assert.deepEqual(checkPoolTo("solana", `\u202e${reversed}`, KEYS), { ok: false, code: "address" });
  assert.deepEqual(checkPoolTo("solana", `\u202e${reversed}\u202c`, KEYS), { ok: false, code: "address" });
});

test("a look-alike letter is refused, never taken out: a Cyrillic o or a Greek O inside the key", () => {
  for (const raw of [TO.replace("o", "\u043e"), TO.replace("o", "\u03bf"), TO.replace("K", "\u039a")]) {
    assert.notEqual(raw, TO);
    assert.deepEqual(checkPoolTo("solana", raw, KEYS), { ok: false, code: "address" }, JSON.stringify(raw));
  }
  assert.deepEqual(checkPoolTo("base", EVM.replace("a", "\u0430"), EVM_KEYS), { ok: false, code: "address" });
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
  for (const raw of ["\u200b", "\ufeff", " \n\t", "\u2060\u00ad"]) assert.equal(evaluatePool("solana", raw, "", KEYS, FUNDS).state, "empty", JSON.stringify(raw));
});

test("the screen's view of a paste: ready, and the To it hands over is the address alone", () => {
  const v = evaluatePool("solana", `\ufeff ${TO}\u200b\n`, "0.002", KEYS, FUNDS);
  assert.equal(v.state, "ready");
  assert.equal(v.ready?.to, TO);
});

test("a field holding a direction control alone is refused, not blank", () => {
  assert.equal(evaluatePool("solana", "\u200e", "", KEYS, FUNDS).state, "refused");
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
  to.value = `\u200b${TO}\n`;
  to.fire("input");
  await wait(CHECK_IDLE_MS + 60);
  assert.equal(line.hidden, true, "the pasted address passes");
});

test("a paste with hidden characters: the To line drawn before the press is the address alone, and the press hands over that same To", async () => {
  const handed: PoolReady[] = [];
  const steps: Promise<void>[] = [];
  const doc = { createElement: () => new El() } as unknown as Document;
  const button = (action: string, label: string, onClick: () => void) => {
    const b = new El();
    b.dataset.action = action;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b as unknown as HTMLButtonElement;
  };
  const form = drawPoolWithdrawForm(doc, { chain: "solana", keys: KEYS, funds: async () => FUNDS, handoff: (r) => void handed.push(r) }, button, (s) => void steps.push(s())) as unknown as El;
  const field = (k: string) => form.find((e) => e.dataset.input === k)!;
  const pasted = `\ufeff ${TO.slice(0, 10)}\u200b${TO.slice(10)}\u2060\n`;
  field("to").value = pasted;
  field("to").fire("input");
  field("amount").value = "0.002";
  field("amount").fire("input");
  await wait(CHECK_IDLE_MS + 60);
  assert.equal(form.dataset.state, "ready");
  const drawn = form.find((e) => e.dataset.line === "to")!;
  assert.equal(drawn.textContent, TO, "the To line shows the address the check passed, not the field's text");
  assert.notEqual(drawn.textContent, pasted);
  form.find((e) => e.dataset.action === "withdraw")!.fire("click");
  await Promise.all(steps.splice(0));
  assert.equal(handed.length, 1);
  assert.equal(handed[0]!.to, drawn.textContent, "handed over: the To drawn");
});
