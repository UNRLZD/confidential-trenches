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
const ctx: Parameters<typeof evaluate>[2] = { network: "mainnet", rpcs: [rpc(MAIN.fastnear[0]), rpc(MAIN.drpc)], available: 10_000_000n, fee: 120_000n };

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
  await refused("alice.near", "9.880001", "amount", "insufficient");
  await refused("alice.near", "5", "amount", "unread", { ...ctx, fee: null });
  // a refused address with a good amount is still refused: never ready
  await refused("intents.near", "1", "address", "intents");
  const ok = await v("alice.near", "9.88");
  assert.equal(ok.state, "ready");
  assert.deepEqual(ok.ready, { recipient: "alice.near", amount: 9_880_000n });
  assert.ok(Object.isFrozen(ok.ready));
  const implicit = await v(" " + "ab".repeat(32) + " ", "1");
  assert.deepEqual(implicit.ready, { recipient: "ab".repeat(32), amount: 1_000_000n });
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(CHECK_IDLE_MS + 60);

/** A drawn form whose RPCs answer from `exists` (an account's name -> it exists) and may be held by `gate`. */
function drawn(over: { available?: () => Promise<bigint>; fee?: () => Promise<bigint>; handoff?: boolean; end?: () => { kind: string; fee?: bigint } | void; unmatched?: () => number } = {}) {
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
    available: over.available ?? (async () => 10_000_000n),
    fee: over.fee ?? (async () => 120_000n),
    ...(over.handoff === false ? {} : { handoff: async (w: unknown, fee: bigint) => (handed.push(w), fees.push(fee), over.end?.()) }),
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
  assert.deepEqual(f.handed, [{ recipient: "alice.near", amount: 5_000_000n }]);
  const none = drawn({ handoff: false });
  none.type("to", "alice.near");
  none.type("amount", "5");
  await settle();
  assert.equal(none.form.dataset.state, "ready");
  assert.equal(none.go.disabled, true);
  assert.equal(none.go.dataset.pending, "withdraw-relay");
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
  const f = drawn({ available: async () => note });
  f.type("to", "alice.near");
  f.type("amount", "5");
  await settle();
  assert.equal(f.form.dataset.state, "ready");
  note = 4_000_000n;
  await f.tap();
  assert.deepEqual(f.handed, []);
  assert.equal(f.form.dataset.state, "refused");
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
  f.type("amount", "99"); // insufficient: the newer check reads at once
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
