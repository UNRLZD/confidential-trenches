// The withdraw form's states and words (card signpage-withdraw-form): empty, typing, each refusal and ready, from the
// two fields as typed; a refusal is drawn before any proof, and only a form whose both fields pass is ready.
//   node --test test/withdraw-form.test.ts   (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NEAR_NETWORKS, type NearRpc } from "../../kit/src/near/networks.ts";
import { CHECK_IDLE_MS, drawWithdrawForm, evaluate, formatUnits, refusalWords, WITHDRAW_WORDS } from "../src/withdraw/form.ts";
import { RELEASE_WITHDRAW_RELAYER } from "../../wallet/src/withdraw/relay.ts";
import { PAGE_NETWORK, withdrawFormDeps, withdrawHandoff, withdrawSettle } from "../src/withdraw/handoff.ts";

const MAIN = NEAR_NETWORKS.mainnet;
const VIEW = { jsonrpc: "2.0", result: { amount: "1", block_hash: "x", block_height: 222692520, code_hash: "11111111111111111111111111111111", locked: "0", storage_paid_at: 0, storage_usage: 100 } };
const UNKNOWN = { jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } };
const reads: string[] = [];
const rpc = (name: string): NearRpc => ({
  name,
  async query(p) {
    reads.push(String(p.account_id));
    return p.account_id === "alice.near" ? VIEW : UNKNOWN;
  },
});
const ctx: Parameters<typeof evaluate>[2] = { network: "mainnet", rpcs: [rpc(MAIN.fastnear[0]), rpc(MAIN.drpc)], notes: [{ id: "a", value: 10_000_000n }], fee: 120_000n };
/** The plan of `amount` from the one 10 USDC note "a" at the 0.12 USDC fee: one withdrawal. */
const oneNote = (amount: bigint) => [{ noteId: "a", part: amount, chunk: amount + 120_000n }];

test("empty, typing, each refusal and ready", async () => {
  const v = (to: string, amount: string, c = ctx) => evaluate(to, amount, c);
  assert.equal((await v("", "")).state, "empty");
  assert.equal((await v("  ", " ")).state, "empty");
  // one field filled and passing, the other blank: typing, not ready
  assert.equal((await v("alice.near", "")).state, "typing");
  assert.equal((await v("", "5")).state, "typing");
  const refused = async (to: string, amount: string, field: "address" | "amount", code: string, c = ctx) => {
    const r = await v(to, amount, c);
    assert.equal(r.state, "refused", `${to} ${amount}`);
    assert.equal(r.ready, null);
    assert.equal(r[field]?.ok, false);
    assert.equal((r[field] as { code: string }).code, code, `${to} ${amount}`);
  };
  await refused("Alice.near", "", "address", "not-account");
  await refused("nobody-here.near", "5", "address", "no-account");
  await refused("intents.near", "5", "address", "intents");
  await refused(MAIN.usdc, "5", "address", "token");
  await refused("alice.near", "5,0", "amount", "amount");
  await refused("alice.near", "0.12", "amount", "min");
  // above what can be sent: what can be (card withdraw-max-means-all); nothing at all: Insufficient
  assert.equal((await v("alice.near", "9.880001")).ready?.amount, 9_880_000n);
  await refused("alice.near", "1", "amount", "insufficient", { ...ctx, notes: [] });
  await refused("alice.near", "5", "amount", "unread", { ...ctx, fee: null });
  // a refused address with a good amount is still refused: never ready
  await refused("intents.near", "1", "address", "intents");
  const ok = await v("alice.near", "9.88");
  assert.equal(ok.state, "ready");
  assert.deepEqual(ok.ready, { recipient: "alice.near", amount: 9_880_000n, parts: oneNote(9_880_000n) });
  assert.ok(Object.isFrozen(ok.ready));
  const implicit = await v(" " + "ab".repeat(32) + " ", "1");
  assert.deepEqual(implicit.ready, { recipient: "ab".repeat(32), amount: 1_000_000n, parts: oneNote(1_000_000n) });
});

test("the testnet vault is refused on its network", async () => {
  const T = NEAR_NETWORKS.testnet;
  const r = await evaluate(T.vault, "1", { ...ctx, network: "testnet", rpcs: [rpc(T.fastnear[0]), rpc(T.drpc)] });
  assert.equal(r.state, "refused");
  assert.deepEqual(r.address, { ok: false, code: "vault" });
});

test("each refusal's words; every word is in the draft table", () => {
  assert.equal(refusalWords("not-account"), "Invalid address");
  for (const c of ["vault", "intents", "token", "no-account"] as const) assert.equal(refusalWords(c), "Invalid address");
  assert.equal(refusalWords("unread"), "Busy · Retry");
  assert.equal(refusalWords("insufficient"), "Insufficient");
  assert.equal(refusalWords("amount"), "Invalid amount");
  assert.equal(refusalWords("min", 120_001n), "Min $0.120001");
  assert.equal(formatUnits(0n), "0");
  assert.equal(formatUnits(1n), "0.000001");
  assert.equal(formatUnits(1_500_000n), "1.5");
  assert.equal(formatUnits(12_000_000n), "12");
});

test("every word of the form is a draft with its source on its line, under the DRAFT COPY note", () => {
  const src = readFileSync(new URL("../src/withdraw/form.ts", import.meta.url), "utf8").split("\n");
  const start = src.findIndex((l) => l === "export const WITHDRAW_WORDS = {");
  const end = src.findIndex((l, i) => i > start && l === "} as const;");
  assert.ok(src[start - 1]!.startsWith("// DRAFT COPY:"));
  const lines = src.slice(start + 1, end);
  assert.equal(lines.length, Object.keys(WITHDRAW_WORDS).length);
  for (const l of lines) assert.match(l, /^  ("[a-z-]+"|[a-z]+): ".+", \/\/ .+/, l);
  // every drawn element names its key: the form sets data-draft-copy on each word it draws
  const body = src.slice(end).join("\n");
  for (const k of ["key", '"withdraw"', '"busy"', '"invalid-amount"', '"invalid-address"']) assert.ok(body.includes(`draftCopy = `) && body.includes(k), k);
});

// ------------------------------------------------------------------------------------------- the drawn form and its tap
// A fake DOM, just what drawWithdrawForm uses, so the tap gate, the stale-answer guard and Withdraw's disabled flag run
// as drawn (the screen run, test/withdraw-screens/run.mjs, drives the same in Chromium).
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
  style: Record<string, string> = {};
  on: Record<string, Array<() => void>> = {};
  tag: string;
  constructor(tag: string) { this.tag = tag; }
  append(...c: El[]): void { this.children.push(...c); }
  replaceChildren(...c: El[]): void { this.children = c; this.textContent = ""; }
  attrs: Record<string, string> = {};
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  addEventListener(type: string, f: () => void): void { (this.on[type] ??= []).push(f); }
  fire(type: string): void { for (const f of this.on[type] ?? []) f(); }
  find(p: (e: El) => boolean): El | undefined {
    for (const c of this.children) { if (p(c)) return c; const d = c.find(p); if (d) return d; }
    return undefined;
  }
  findAll(p: (e: El) => boolean): El[] {
    return this.children.flatMap((c) => [...(p(c) ? [c] : []), ...c.findAll(p)]);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(CHECK_IDLE_MS + 60);

/** A drawn form whose RPCs answer from `exists` (an account's name -> it exists) and may be held by `gate`. */
function drawn(over: { cash?: () => Promise<{ id: string; value: bigint }[]>; fee?: () => Promise<bigint>; handoff?: boolean; end?: (step: (i: number, kind: string) => void) => { kind: string; fee?: bigint } | void; unmatched?: () => number } = {}) {
  const exists = new Set(["alice.near", "bob.near"]);
  let gate: Promise<void> | null = null;
  const view = (name: string): NearRpc => ({
    name,
    async query(p) {
      const g = gate;
      if (g) await g;
      return exists.has(String(p.account_id)) ? VIEW : UNKNOWN;
    },
  });
  const handed: unknown[] = [];
  const fees: bigint[] = [];
  const steps: Promise<void>[] = [];
  const doc = { createElement: (tag: string) => new El(tag) } as unknown as Document;
  const button = (action: string, label: string, onClick: () => void) => {
    const b = new El("button");
    b.dataset.action = action;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b as unknown as HTMLButtonElement;
  };
  const deps = {
    network: "mainnet" as const,
    rpcs: [view(MAIN.fastnear[0]), view(MAIN.drpc)] as const,
    cash: over.cash ?? (async () => [{ id: "a", value: 10_000_000n }]),
    available: async () => 10_000_000n,
    fee: over.fee ?? (async () => 120_000n),
    ...(over.handoff === false ? {} : { handoff: async (w: unknown, fee: bigint, step: (i: number, kind: string) => void) => (handed.push(w), fees.push(fee), over.end?.(step)) }),
    ...(over.unmatched ? { unmatched: over.unmatched } : {}),
  };
  const form = drawWithdrawForm(doc, deps, button, (step) => void steps.push(step())) as unknown as El;
  const input = (k: string) => form.find((e) => e.dataset.input === k)!;
  const go = form.find((e) => e.dataset.action === "withdraw")!;
  return {
    form, go, handed, fees, exists,
    /** Holds the reads made from now on until the returned `open`; reads made after `free` are not held. */
    hold: () => { let open!: () => void; gate = new Promise((r) => (open = r)); return open; },
    free: () => { gate = null; },
    type: (k: "to" | "amount", v: string) => { input(k).value = v; input(k).fire("input"); },
    /** A value set with no input event (autofill, a script): the tap's check must still read it. */
    set: (k: "to" | "amount", v: string) => { input(k).value = v; },
    tap: async () => { go.fire("click"); await Promise.all(steps.splice(0)); },
  };
}

test("Withdraw is disabled until both fields pass, and with no hand-off it stays disabled", async () => {
  const f = drawn();
  assert.equal(f.go.disabled, true);
  f.type("to", "alice.near");
  await settle();
  assert.equal(f.form.dataset.state, "typing");
  assert.equal(f.go.disabled, true);
  f.type("amount", "0.1");
  await settle();
  assert.equal(f.form.dataset.state, "refused");
  assert.equal(f.go.disabled, true);
  f.type("amount", "5");
  assert.equal(f.go.disabled, true, "typing: disabled while the check waits");
  await settle();
  assert.equal(f.form.dataset.state, "ready");
  assert.equal(f.go.disabled, false);
  await f.tap();
  assert.deepEqual(f.handed, [{ recipient: "alice.near", amount: 5_000_000n, parts: oneNote(5_000_000n) }]);
  const none = drawn({ handoff: false });
  none.type("to", "alice.near");
  none.type("amount", "5");
  await settle();
  assert.equal(none.form.dataset.state, "ready");
  assert.equal(none.go.disabled, true);
  assert.equal(none.go.dataset.pending, "withdraw-relay");
});

// owner 8 Nov 07:55Z kept Withdraw, Invalid address, Invalid amount, Insufficient and Busy · Retry (pw.*): no draft mark on
// their elements. To, Amount and Min $ (this form's own, not on the page) keep theirs.
test("no draft mark on the kept words: Withdraw and each refusal; To, Amount and Min $ keep theirs", async () => {
  const f = drawn();
  assert.equal(f.go.dataset.draftCopy, undefined);
  const marks = () => f.form.children.filter((e) => e.tag === "p" && !e.hidden && e.dataset.for).map((e) => [e.dataset.refusal, e.dataset.draftCopy]);
  assert.deepEqual(f.form.children.filter((e) => e.tag === "label").map((l) => l.children[0]!.dataset.draftCopy), ["to", "amount"]);
  f.type("to", "not an account!");
  f.type("amount", "abc");
  await settle();
  assert.deepEqual(marks(), [["not-account", undefined], ["amount", undefined]]);
  f.type("to", "alice.near");
  f.type("amount", "0.1");
  await settle();
  assert.deepEqual(marks(), [["min", "min"]], "Min $X is this form's own word, still a draft");
  f.type("amount", "50");
  await settle();
  // above what can be sent: no line, the box holds what can be (card withdraw-max-means-all)
  assert.deepEqual(marks(), []);
  assert.equal(f.go.dataset.draftCopy, undefined);
});

test("the tap gives the hand-off the fee it drew; a hand-off that finds the relayer's fee higher has the form draw it and stop", async () => {
  const f = drawn();
  f.type("to", "alice.near");
  f.type("amount", "5");
  await settle();
  await f.tap();
  assert.deepEqual(f.fees, [120_000n], "the fee drawn at the tap");
  // the new fee still fits the note: drawn ready again, no outcome, nothing more handed over until the next tap
  const g = drawn({ end: () => ({ kind: "fee", fee: 130_000n }) });
  g.type("to", "alice.near");
  g.type("amount", "5");
  await settle();
  await g.tap();
  assert.equal(g.handed.length, 1);
  assert.equal(g.form.dataset.outcome, undefined, "a fee above the drawn one is no outcome");
  assert.equal(g.form.dataset.state, "ready");
  // the new fee leaves the note short: drawn refused, Withdraw disabled
  const h = drawn({ end: () => ({ kind: "fee", fee: 6_000_000n }) });
  h.type("to", "alice.near");
  h.type("amount", "5");
  await settle();
  await h.tap();
  assert.equal(h.handed.length, 1);
  assert.equal(h.form.dataset.outcome, undefined);
  assert.equal(h.form.dataset.state, "refused");
  assert.equal(h.go.disabled, true);
});

test("the tap hands over nothing when the address or amount it checks again is not the one drawn", async () => {
  for (const [k, v] of [["to", "bob.near"], ["amount", "6"]] as const) {
    const f = drawn();
    f.type("to", "alice.near");
    f.type("amount", "5");
    await settle();
    assert.equal(f.form.dataset.state, "ready");
    f.set(k, v);
    await f.tap();
    assert.deepEqual(f.handed, [], `${k} changed to ${v}`);
  }
});

test("the tap reads the account again: gone on both RPCs since it was drawn, nothing is handed over", async () => {
  const f = drawn();
  f.type("to", "alice.near");
  f.type("amount", "5");
  await settle();
  assert.equal(f.form.dataset.state, "ready");
  f.exists.delete("alice.near");
  await f.tap();
  assert.deepEqual(f.handed, []);
  assert.equal(f.form.dataset.state, "refused");
  assert.equal(f.go.disabled, true);
});

test("the tap reads the note value and the fee bound again: a smaller note or a larger fee since, nothing is handed over", async () => {
  let note = 10_000_000n;
  const f = drawn({ cash: async () => [{ id: "a", value: note }] });
  f.type("to", "alice.near");
  f.type("amount", "5");
  await settle();
  assert.equal(f.form.dataset.state, "ready");
  note = 4_000_000n;
  await f.tap();
  assert.deepEqual(f.handed, []);
  // what the smaller note pays now is in the box for the next tap
  assert.equal(f.form.find((e) => e.dataset.input === "amount")!.value, "3.88");
  let fee = 120_000n;
  const g = drawn({ fee: async () => fee });
  g.type("to", "alice.near");
  g.type("amount", "5");
  await settle();
  fee = 6_000_000n;
  await g.tap();
  assert.deepEqual(g.handed, []);
});

test("a stale answer is never drawn: a check that answers after a newer keystroke is dropped", async () => {
  const f = drawn();
  f.type("to", "alice.near");
  f.type("amount", "5");
  const open = f.hold();
  await settle(); // the first check (ready) is held at the RPCs
  f.free();
  f.type("amount", "0.1"); // under the least: the newer check reads at once
  await settle();
  assert.equal(f.form.dataset.state, "refused");
  open(); // the held first check answers now, after the newer one
  await sleep(50);
  assert.equal(f.form.dataset.state, "refused", "the older ready answer is not drawn over the newer refusal");
  assert.equal(f.go.disabled, true);
});

test("SIGN_HOST's build (no __SIGN_NETWORK__): mainnet, its pair, the release's mainnet relayer and its hand-off, no testnet relayer, and a settle pass with nothing RESERVED opens no seed", async () => {
  assert.equal(PAGE_NETWORK, "mainnet");
  assert.equal(RELEASE_WITHDRAW_RELAYER.testnet, null, "the testnet relayer is the testnet build's only");
  let opened = 0;
  const no = async (): Promise<never> => {
    opened += 1;
    throw new Error("not opened");
  };
  // mainnet names the vault of contracts/vault/deployments/mainnet-v1.json (card vault-mainnet-deploy), so the settle
  // pass reads the note store (handoff.ts withdrawSettle: nothing only where the network names no vault); with no
  // RESERVED note in it, the seed is never opened
  let listed = 0;
  const store = {
    list: async () => {
      listed += 1;
      return [];
    },
  };
  const notes = async () => store as unknown as Awaited<ReturnType<Parameters<typeof withdrawSettle>[0]["notes"]>>;
  assert.equal(MAIN.vault, JSON.parse(readFileSync(new URL("../../../contracts/vault/deployments/mainnet-v1.json", import.meta.url), "utf8")).account_id);
  const page = { store: no, notes, seed64: no, prover: { load: no, prove: no } };
  const d = withdrawFormDeps(page);
  assert.equal(d.network, "mainnet");
  assert.deepEqual(d.rpcs.map((r) => r.name), [MAIN.fastnear[0], MAIN.drpc]);
  // the release names its mainnet withdrawal relayer (card wallet-mainnet-relayer-pins), so the form offers the hand-off;
  // the build that names none is held in test/withdraw-mainnet-relayer.test.ts
  assert.deepEqual({ ...RELEASE_WITHDRAW_RELAYER.mainnet }, { relayer_account: "4519129d35447942d92ef046ffa52af0430fb06b95b59936d7173290a6972756", fee_recipient: "fees.unrlzd.near" });
  assert.equal(typeof d.handoff, "function");
  assert.equal(typeof withdrawHandoff(page), "function");
  // the testnet release on this build names no relayer: nothing offered there either
  assert.equal(withdrawHandoff(page, { network: "testnet" }), null);
  assert.deepEqual(await withdrawSettle(page), { outcomes: {} });
  assert.equal(listed, 1, "the settle pass lists the mainnet notes once");
  assert.equal(opened, 0, "neither the store nor the seed is opened");
});

// card wallet-withdraw-move-out: the settle pass's "unmatched" (a drift note left RESERVED) is shown on the form, in
// draft words, and drawn again at each tap's read
test("the settle pass's unmatched withdrawals are shown on the form; none, nothing shown", async () => {
  let n = 1;
  const f = drawn({ unmatched: () => n });
  const notice = () => f.form.find((e) => e.dataset.notice === "unmatched");
  assert.ok(notice(), "one unmatched withdrawal: the notice is drawn");
  assert.equal(notice()!.hidden, false);
  assert.equal(notice()!.dataset.draftCopy, "unmatched");
  assert.equal(notice()!.textContent, WITHDRAW_WORDS.unmatched);
  n = 0;
  f.type("to", "alice.near");
  f.type("amount", "5");
  await settle();
  await f.tap();
  assert.equal(notice()!.hidden, true, "read again at the tap: none now");
  const none = drawn();
  assert.equal(none.form.find((e) => e.dataset.notice === "unmatched")?.hidden ?? true, true);
});

// card withdraw-form-shows-what-you-can-send: above what the note can send, the line names what can be sent, as the
// pool's form does (its kept nearest-amounts words, "Try 0.5 SOL"), with the vault's asset; Insufficient only when
// nothing can be sent.
test("an amount above what can be sent is what can be sent (card withdraw-max-means-all); Insufficient when nothing can", async () => {
  const r = await evaluate("alice.near", "50", ctx);
  assert.deepEqual(r.amount, { ok: true, amount: 9_880_000n, parts: oneNote(9_880_000n) });
  assert.equal(refusalWords("insufficient", undefined, 9_880_000n), "Try 9.88 USDC");
  const none = await evaluate("alice.near", "50", { ...ctx, notes: [] });
  assert.deepEqual(none.amount, { ok: false, code: "insufficient" });
  assert.equal(refusalWords("insufficient"), "Insufficient");
});

// card cash-withdraws-everything-to-any-chain: Cash goes out whole. Max names the whole of Cash less a fee per note and
// fills the amount; the tap hands over one withdrawal per note, and each is a step drawn with its amount and its state.
test("Max is the whole of Cash: a tap fills it, Withdraw hands over one withdrawal per note, each drawn as a step", async () => {
  const f = drawn({
    cash: async () => [{ id: "a", value: 10_000_000n }, { id: "b", value: 5_000_000n }],
    end: (step) => {
      step(0, "sending");
      step(0, "arrived");
      step(1, "sending");
      step(1, "expired");
      return { kind: "expired" };
    },
  });
  await settle();
  const max = f.form.find((e) => e.dataset.action === "sendable")!;
  assert.equal(max.textContent, "Max 14.76 USDC", "9.88 + 4.88");
  assert.equal(max.dataset.value, "14760000");
  f.type("to", "alice.near");
  max.fire("click");
  await settle();
  assert.equal(f.form.find((e) => e.dataset.input === "amount")!.value, "14.76");
  assert.equal(f.form.dataset.state, "ready");
  await f.tap();
  assert.deepEqual(f.handed, [
    { recipient: "alice.near", amount: 14_760_000n, parts: [{ noteId: "a", part: 9_880_000n, chunk: 10_000_000n }, { noteId: "b", part: 4_880_000n, chunk: 5_000_000n }] },
  ]);
  const steps = f.form.find((e) => e.dataset.steps === "cash-withdraw")!;
  assert.equal(steps.hidden, false);
  assert.deepEqual(steps.children.map((li) => [li.children[0]!.textContent, li.dataset.stepState, li.children[1]!.textContent, li.children[1]!.dataset.draftCopy]), [
    ["9.88 USDC", "arrived", "Sent", "step-sent"],
    ["4.88 USDC", "expired", "Back in Cash", "step-back"],
  ]);
  assert.equal(f.form.dataset.outcome, "expired");
});

test("an amount no plan sends is the nearest one that can be at or below it, never a Try line", async () => {
  const f = drawn();
  f.type("to", "alice.near");
  f.type("amount", "9.8");
  await settle();
  const line = f.form.find((e) => e.tag === "p" && e.dataset.for === "amount")!;
  assert.equal(line.hidden, true);
  assert.equal(line.dataset.refusal, undefined);
  assert.equal(f.go.disabled, false);
});

test("the tap hands over nothing when the notes changed since the plan was drawn", async () => {
  let cash = [{ id: "a", value: 10_000_000n }, { id: "b", value: 5_000_000n }];
  const f = drawn({ cash: async () => cash });
  f.type("to", "alice.near");
  f.type("amount", "12");
  await settle();
  assert.equal(f.form.dataset.state, "ready");
  cash = [{ id: "c", value: 10_000_000n }, { id: "b", value: 5_000_000n }];
  await f.tap();
  assert.deepEqual(f.handed, [], "a new plan is drawn for the next tap");
  assert.equal(f.form.dataset.state, "ready");
});

// Part B (card cash-withdraws-everything-to-any-chain): where Cash goes, NEAR first; on SIGN_HOST's build also Solana and
// Base, each with an address there, the plan the same
test("Cash goes out to NEAR alone for now: one chain, the chain row hidden, the hand-off names no other chain", async () => {
  // Solana and Base join with the carry of a refunded part back to Cash (cards v-binds-into-the-vault and
  // onward-refund-comes-back); until then no send may leave money under V that the app cannot move
  const f = drawn();
  const picks = f.form.findAll((e) => e.dataset.action === "chain");
  assert.deepEqual(picks.map((b) => [b.dataset.chain, b.textContent, b.getAttribute("aria-pressed")]), [["near", "NEAR", "true"]]);
  assert.equal(f.form.find((e) => e.dataset.row === "chains")!.hidden, true);
  assert.equal(f.form.dataset.chain, "near");
  f.type("to", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  f.type("amount", "5");
  await settle();
  assert.equal(f.form.dataset.state, "refused", "a Solana address is no NEAR account");
  f.type("to", "alice.near");
  await settle();
  await f.tap();
  assert.deepEqual(f.handed, [{ recipient: "alice.near", amount: 5_000_000n, parts: oneNote(5_000_000n) }]);
});

test("the chain is checked again at the tap: a pick changed since the check hands over nothing", async () => {
  const ev = await evaluate("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "5", { ...ctx, chain: "base" });
  assert.deepEqual(ev.ready, { recipient: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: 5_000_000n, parts: oneNote(5_000_000n), chain: "base" });
  assert.equal((await evaluate("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "5", ctx)).ready, null, "on NEAR an EVM address is no account");
  assert.equal((await evaluate("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "5", { ...ctx, chain: "base" })).ready, null);
});

// card withdraw-max-means-all: Max is an intent, not a number, and a typed amount Cash cannot pay exactly is the nearest
// payable amount at or below it, written in the box before the tap. No Try.
test("Max tapped, then the tap's re-read moves Max: a lower fee hands over the live Max; a higher one hands nothing over and the box follows for the next tap", async () => {
  let fee = 120_000n;
  const f = drawn({ cash: async () => [{ id: "a", value: 10_000_000n }, { id: "b", value: 5_000_000n }], fee: async () => fee });
  await settle();
  f.type("to", "alice.near");
  f.form.find((e) => e.dataset.action === "sendable")!.fire("click");
  await settle();
  assert.equal(f.form.dataset.state, "ready");
  fee = 100_000n;
  await f.tap();
  assert.equal(f.handed.length, 1, "a lower fee: the live Max goes");
  assert.equal((f.handed[0] as { amount: bigint }).amount, 14_800_000n);
  const g = drawn({ cash: async () => [{ id: "a", value: 10_000_000n }, { id: "b", value: 5_000_000n }], fee: async () => fee });
  await settle();
  g.type("to", "alice.near");
  g.form.find((e) => e.dataset.action === "sendable")!.fire("click");
  await settle();
  fee = 150_000n;
  await g.tap();
  assert.deepEqual(g.handed, [], "a higher fee than drawn: nothing handed over");
  assert.equal(g.form.find((e) => e.dataset.input === "amount")!.value, "14.7", "the box follows the live Max");
  assert.equal(g.form.dataset.state, "ready");
  await g.tap();
  assert.equal((g.handed[0] as { amount: bigint }).amount, 14_700_000n);
});

test("a typed amount Cash cannot pay exactly: the nearest payable at or below it, in the box before the tap, and handed over", async () => {
  const f = drawn();
  f.type("to", "alice.near");
  f.type("amount", "9.8");
  await settle();
  assert.equal(f.form.dataset.state, "ready");
  assert.equal(f.form.find((e) => e.tag === "p" && e.dataset.for === "amount")!.hidden, true, "no Try");
  assert.equal(f.form.find((e) => e.dataset.input === "amount")!.value, "9.639999");
  await f.tap();
  assert.deepEqual(f.handed, [{ recipient: "alice.near", amount: 9_639_999n, parts: oneNote(9_639_999n) }]);
  f.type("amount", "50");
  await settle();
  assert.equal(f.form.dataset.state, "ready");
  assert.equal(f.form.find((e) => e.dataset.input === "amount")!.value, "9.88", "above everything: everything");
});
