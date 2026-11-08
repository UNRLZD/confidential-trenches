// Card held-deposit-way-out: the held deposit's way out page (src/withdraw/held.ts). The typed account goes through the
// withdraw form's one rule (checkRecipient) before the wallet's move is called; a recorded move is resumed at once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NEAR_NETWORKS, type NearRpc } from "../../kit/src/near/networks.ts";
import type { MoveOutOutcome, MoveOutRecord } from "../../wallet/src/deposit/moveout.ts";
import { CHECK_IDLE_MS } from "../src/withdraw/form.ts";
import { drawHeldMoveOut, HELD_WORDS, nearUp } from "../src/withdraw/held.ts";

const MAIN = NEAR_NETWORKS.mainnet;
const U = "ab".repeat(32);
const VIEW = { jsonrpc: "2.0", result: { amount: "1", block_hash: "x", block_height: 222692520, code_hash: "11111111111111111111111111111111", locked: "0", storage_paid_at: 0, storage_usage: 100 } };
const UNKNOWN = { jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } };

class El {
  dataset: Record<string, string> = {};
  children: (El | string)[] = [];
  textContent = "";
  hidden = false;
  disabled = false;
  readOnly = false;
  value = "";
  type = "";
  autocomplete = "";
  spellcheck = true;
  on: Record<string, Array<() => void>> = {};
  tag: string;
  constructor(tag: string) { this.tag = tag; }
  append(...c: (El | string)[]): void { this.children.push(...c); }
  replaceChildren(...c: El[]): void { this.children = c; this.textContent = ""; }
  setAttribute(): void {}
  addEventListener(type: string, f: () => void): void { (this.on[type] ??= []).push(f); }
  fire(type: string): void { for (const f of this.on[type] ?? []) f(); }
  find(p: (e: El) => boolean): El | undefined {
    for (const c of this.children) { if (typeof c === "string") continue; if (p(c)) return c; const d = c.find(p); if (d) return d; }
    return undefined;
  }
  text(): string { return this.textContent + this.children.map((c) => (typeof c === "string" ? c : c.text())).join(""); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(CHECK_IDLE_MS + 60);

function drawn(answer: (to: string | null) => MoveOutOutcome, recorded?: MoveOutRecord) {
  const rpc = (name: string): NearRpc => ({ name, query: async (p) => (p.account_id === "alice.near" ? VIEW : UNKNOWN) });
  const calls: (string | null)[] = [];
  const steps: Promise<void>[] = [];
  const doc = { createElement: (tag: string) => new El(tag) } as unknown as Document;
  const button = (action: string, label: string, onClick: () => void) => {
    const b = new El("button");
    b.dataset.action = action;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b as unknown as HTMLButtonElement;
  };
  const page = drawHeldMoveOut(doc, { network: "mainnet", rpcs: [rpc(MAIN.fastnear[0]), rpc(MAIN.drpc)], recorded: async () => recorded, moveOut: async (to) => (calls.push(to), answer(to)) }, button, (s) => void steps.push(s())) as unknown as El;
  const input = page.find((e) => e.dataset.input === "to")!;
  const go = page.find((e) => e.dataset.action === "move-out")!;
  return {
    page, go, input, calls,
    type: (v: string) => ((input.value = v), input.fire("input")),
    tap: async () => (go.fire("click"), await Promise.all(steps.splice(0))),
    steps: () => Promise.all(steps.splice(0)),
  };
}

test("refused before anything moves: the vault, intents.near, the token, a bad id and a named account that does not exist", async () => {
  for (const [to, code] of [[MAIN.vault, "vault"], ["intents.near", "intents"], [MAIN.usdc, "token"], ["Alice!", "not-account"], ["nobody.near", "no-account"]] as const) {
    const f = drawn(() => ({ kind: "empty" }));
    await f.steps();
    f.type(to);
    await settle();
    assert.equal(f.page.dataset.state, "refused", to);
    assert.equal(f.page.find((e) => e.dataset.for === "to")!.dataset.refusal, code, to);
    assert.equal(f.go.disabled, true, to);
    await f.tap();
    assert.deepEqual(f.calls, [], `${to}: the wallet's move is never called`);
  }
});

test("a checked account goes to the wallet's move at the tap, checked again; moved is drawn and the field is then read-only", async () => {
  const f = drawn((to) => ({ kind: "moved", to: to!, amount: 2_499_999n, hash: "h" }));
  await f.steps();
  assert.equal(f.go.disabled, true);
  f.type("alice.near");
  await settle();
  assert.equal(f.page.dataset.state, "ready");
  assert.equal(f.go.disabled, false);
  await f.tap();
  assert.deepEqual(f.calls, ["alice.near"]);
  assert.equal(f.page.dataset.outcome, "moved");
  assert.equal(f.input.readOnly, true);
  // an implicit id passes with no read
  const g = drawn((to) => ({ kind: "moved", to: to!, amount: 1n, hash: "h" }));
  await g.steps();
  g.type(U);
  await settle();
  await g.tap();
  assert.deepEqual(g.calls, [U]);
});

test("U short of NEAR: the amount to send to U is drawn, rounded up; a later tap asks again", async () => {
  const f = drawn(() => ({ kind: "gas", need: 7_250_000_000_000_000_000_001n, u: U }));
  await f.steps();
  f.type("alice.near");
  await settle();
  await f.tap();
  assert.equal(f.page.dataset.outcome, "gas");
  const line = f.page.find((e) => e.dataset.outcomeLine === "")!;
  assert.ok(line.text().includes(`${HELD_WORDS.gas} 0.00726 NEAR ${U}`), line.text());
  await f.tap();
  assert.equal(f.calls.length, 2);
  assert.equal(nearUp(10n ** 24n), "1");
});

test("a move the op already holds is resumed at once with its recorded account, never a typed one", async () => {
  const rec: MoveOutRecord = { to: "alice.near", amount: "2499999", nonce: "8", height: 1, register: false, hash: "h", signed: "AA==" };
  const f = drawn(() => ({ kind: "sent", to: "alice.near", amount: 2_499_999n, hash: "h" }), rec);
  await f.steps();
  assert.deepEqual(f.calls, [null], "resumed, no account handed over");
  assert.equal(f.input.value, "alice.near");
  assert.equal(f.input.readOnly, true);
  assert.equal(f.page.dataset.outcome, "sent");
  await f.tap();
  assert.deepEqual(f.calls, [null, null]);
});
