// The pool withdraw screen (src/withdraw/pool-form.ts) in the sheet (src/sheet.ts dress, the look every element of a
// screen gets when it comes into the sheet): what can be sent is a value the user taps, never a second main button, and
// the screen's own layout survives the dress: the amount row (its input shares the line with the symbol), the symbol,
// the chain's mark in its round badge, and the To line's wrap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dress } from "../src/sheet.ts";
import { drawPoolWithdrawForm, type PoolFunds } from "../src/withdraw/pool-form.ts";

const FUNDS: PoolFunds = { notes: [{ id: "a", value: 50_000_000n }], fee: 1_300_000n, wFee: 5_000n, minPart: 1_890_880n };
const PAPER = "#f4f4f2";

class El {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: El[] = [];
  parent: El | null = null;
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
  readonly tagName: string;
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  append(...c: El[]): void { for (const x of c) x.parent = this; this.children.push(...c); }
  replaceChildren(...c: El[]): void { this.children = []; this.append(...c); this.textContent = ""; }
  setAttribute(): void {}
  addEventListener(): void {}
  closest(sel: string): El | null { for (let e: El | null = this; e; e = e.parent) if (e.tagName === sel.toUpperCase()) return e; return null; }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
}

function dressed(phone: boolean) {
  const doc = { createElement: (t: string) => new El(t) } as unknown as Document;
  const button = (action: string, label: string) => {
    const b = new El("button");
    b.dataset.action = action;
    b.textContent = label;
    return b as unknown as HTMLButtonElement;
  };
  const form = drawPoolWithdrawForm(doc, { chain: "solana", keys: { pool: "4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy" }, funds: async () => FUNDS }, button, () => {}) as unknown as El;
  const main = new El("main");
  main.append(form);
  for (const e of [main, ...main.all()]) dress(e as unknown as HTMLElement, phone);
  const find = (p: (e: El) => boolean) => main.all().find(p)!;
  return { find };
}

for (const phone of [true, false]) {
  const w = phone ? "phone" : "desktop";
  test(`${w}: what can be sent is a value to tap in the sheet, not a paper button; at least 44 px tall on the phone`, () => {
    const { find } = dressed(phone);
    const can = find((e) => e.dataset.action === "sendable");
    assert.notEqual(can.style.background, PAPER, "not the main button's paper");
    assert.notEqual(can.style.width, "100%", "not the full width a main button takes");
    assert.equal(can.style.display, "inline-flex");
    if (phone) assert.equal(can.style.minHeight, "44px");
    const go = find((e) => e.dataset.action === "withdraw");
    assert.equal(go.style.width, "100%", "Withdraw stays the one main button");
  });

  test(`${w}: the amount row, the symbol, the chain's mark and the To line keep the screen's own layout under the dress`, () => {
    const { find } = dressed(phone);
    const amount = find((e) => e.dataset.input === "amount");
    const label = amount.parent!;
    assert.equal(label.style.display, "flex", "the amount's name over a row of input and symbol");
    assert.equal(amount.style.flex, "1 1 0", "the input gives the symbol its room");
    assert.equal(amount.style.minWidth, "0");
    const symbol = find((e) => e.dataset.symbol === "SOL");
    assert.equal(symbol.style.flex, "none");
    const mark = find((e) => e.dataset.mark === "solana");
    assert.equal(mark.style.display, "flex");
    const badge = mark.children[0]!;
    assert.deepEqual([badge.style.width, badge.style.height, badge.style.borderRadius, badge.style.background], ["20px", "20px", "50%", "#000"]);
    assert.equal(badge.children[0]!.tagName, "IMG");
    assert.equal(find((e) => e.dataset.row === "sendable").tagName, "DIV", "the row that carries hidden is no element the dress styles");
  });
}
