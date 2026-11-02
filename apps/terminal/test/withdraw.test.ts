// The withdraw progress on APP_HOST (card app-withdraw-entry; A1.7, app.md:1440; J6, app.md:371-399; S12.11, S12.12,
// S12.14, S12.15 at 09-design-brief S12): the kit's withdraw stages to S12 ids, table driven; which withdrawals the app
// follows from the signing page's `state.ops` (the ones running or new in this session, never an old finished one); the
// counter's zero; the tx link; and the one WORDS table.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Operation, WithdrawStage } from "@blindfill/kit";
import { close, current, EMPTY, observe, STAGE_VIEW, txLink } from "../src/screens/withdraw/model.ts";
import type { Watch } from "../src/screens/withdraw/model.ts";
import { DRAFTS, WORDS } from "../src/screens/withdraw/words.ts";

const NOW = Date.parse("2026-11-02T03:00:00Z");
const wd = (id: string, stage: WithdrawStage, txs: { chain: "solana" | "base" | "robinhood" | "near"; hash: string }[] = []): Operation => ({ id, kind: "withdraw", stage, txs });
const dep = (id: string): Operation => ({ id, kind: "deposit", stage: "done", txs: [] });
const run = (steps: [Operation[] | null, number][], w: Watch = EMPTY): Watch => steps.reduce((acc, [ops, t]) => observe(acc, ops, t), w);

test("every kit withdraw stage has its S12 state: Sending, Processing, Sent, Refunded, and stopped (CH-123)", () => {
  const want: Record<WithdrawStage, string> = { proving: "S12.11", submitted: "S12.11", in_transit: "S12.12", sent: "S12.14", refunded: "S12.15", stopped: "stopped" };
  assert.deepEqual(STAGE_VIEW, want);
});

test("nothing to show: no state yet, no withdrawal, or only other kinds", () => {
  assert.equal(current(run([[null, NOW]]), null, NOW), null);
  assert.equal(current(run([[[], NOW]]), [], NOW), null);
  const ops = [dep("d1")];
  assert.equal(current(run([[ops, NOW]]), ops, NOW), null);
});

test("an old finished withdrawal, already final at the first state of the session, is never drawn again", () => {
  for (const stage of ["sent", "refunded", "stopped"] as const) {
    const ops = [wd("w0", stage)];
    assert.equal(current(run([[ops, NOW]]), ops, NOW), null, stage);
  }
});

test("a withdrawal running at the first state (a reload mid-way) is followed through to its end", () => {
  const a = [wd("w1", "in_transit")];
  let w = run([[a, NOW]]);
  assert.equal(current(w, a, NOW + 4_000)?.view, "S12.12");
  const b = [wd("w1", "sent", [{ chain: "near", hash: "h1" }])];
  w = observe(w, b, NOW + 20_000);
  assert.equal(current(w, b, NOW + 20_000)?.view, "S12.14");
});

test("a new withdrawal goes Sending, Processing with the counter from when the app first saw it, then Sent", () => {
  let w = run([[[], NOW]]);
  const steps: [WithdrawStage, number, string, number | null][] = [
    ["proving", NOW + 1_000, "S12.11", null],
    ["submitted", NOW + 9_000, "S12.11", null],
    ["in_transit", NOW + 10_000, "S12.12", 9],
    ["in_transit", NOW + 14_500, "S12.12", 13],
    ["sent", NOW + 32_000, "S12.14", null],
  ];
  for (const [stage, t, view, counter] of steps) {
    const ops = [wd("w2", stage)];
    w = observe(w, ops, t);
    const c = current(w, ops, t);
    assert.equal(c?.view, view, stage);
    assert.equal(c?.counter ?? null, counter, `${stage} counter`);
  }
});

test("a new withdrawal first seen already final (the client was down while it ran) is still drawn: no dead end", () => {
  for (const [stage, view] of [["sent", "S12.14"], ["refunded", "S12.15"], ["stopped", "stopped"]] as const) {
    let w = run([[[wd("old", "sent")], NOW]]);
    w = observe(w, null, NOW + 1_000); // down: no state
    const ops = [wd("old", "sent"), wd("w3", stage)];
    w = observe(w, ops, NOW + 30_000);
    assert.equal(current(w, ops, NOW + 30_000)?.op.id, "w3", stage);
    assert.equal(current(w, ops, NOW + 30_000)?.view, view, stage);
  }
});

test("Done or the close drops that withdrawal; the next followed one shows; a closed one never comes back", () => {
  let w = run([[[], NOW]]);
  const ops = [wd("a", "sent"), wd("b", "in_transit")];
  w = observe(w, [wd("a", "in_transit")], NOW + 1_000);
  w = observe(w, ops, NOW + 2_000);
  assert.equal(current(w, ops, NOW + 2_000)?.op.id, "a", "the first seen shows first");
  w = close(w, "a");
  assert.equal(current(w, ops, NOW + 3_000)?.op.id, "b");
  assert.equal(current(w, ops, NOW + 3_000)?.counter, 1);
  w = observe(w, ops, NOW + 4_000);
  assert.equal(current(w, ops, NOW + 4_000)?.op.id, "b", "a stays closed");
  w = close(w, "b");
  assert.equal(current(w, ops, NOW + 5_000), null);
});

test("a withdrawal that leaves the state is no longer drawn", () => {
  let w = run([[[], NOW], [[wd("w4", "in_transit")], NOW + 1_000]]);
  w = observe(w, [], NOW + 2_000);
  assert.equal(current(w, [], NOW + 2_000), null);
});

test("the first state fixes the session's start once: a later state never makes a new withdrawal old", () => {
  let w = run([[[wd("w0", "sent")], NOW]]);
  w = observe(w, [wd("w0", "sent"), wd("w5", "sent")], NOW + 5_000);
  w = observe(w, [wd("w0", "sent"), wd("w5", "sent")], NOW + 6_000);
  assert.equal(current(w, [wd("w0", "sent"), wd("w5", "sent")], NOW + 6_000)?.op.id, "w5");
});

test("observe returns the same watch when nothing changed (no re-render loop)", () => {
  const ops = [wd("w6", "in_transit")];
  const w = run([[[], NOW], [ops, NOW + 1_000]]);
  assert.equal(observe(w, ops, NOW + 2_000), w);
  assert.equal(observe(w, null, NOW + 2_000), w);
});

test("the tx link: the last tx, on its chain's explorer (scripts/perf-table.mjs:40-43); none without a tx", () => {
  assert.equal(txLink([]), null);
  assert.equal(txLink([{ chain: "near", hash: "AbC" }, { chain: "solana", hash: "5xY" }]), "https://solscan.io/tx/5xY");
  assert.equal(txLink([{ chain: "near", hash: "AbC" }]), "https://nearblocks.io/txns/AbC");
  assert.equal(txLink([{ chain: "base", hash: "0x1" }]), "https://basescan.org/tx/0x1");
  assert.equal(txLink([{ chain: "robinhood", hash: "0x2" }]), "https://robinhoodchain.blockscout.com/tx/0x2");
  assert.equal(txLink([{ chain: "near", hash: "a/b?c" }]), "https://nearblocks.io/txns/a%2Fb%3Fc", "a hash is one path segment");
});

test("words: each with its source; no draft is left (owner 2 Nov 06:08Z, all approved)", () => {
  for (const [id, w] of Object.entries(WORDS)) {
    assert.ok(w.text.length > 0 && w.source.length > 0, id);
    assert.ok(!/[.!?]$/.test(w.text), `${id}: a label, not a sentence`);
  }
  assert.deepEqual([...DRAFTS], []);
  for (const k of ["withdraw", "deposit", "close", "processing"] as const) assert.equal(WORDS[k].draft, false, k);
});
