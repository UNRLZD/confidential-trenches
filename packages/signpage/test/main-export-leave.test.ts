// src/main.ts's export screen and backup screen, the review's fixes (card signpage-backup-export), booted top-level on
// test/main-dom.ts and signed in on the published A.8 test seed (never funded):
// - a record whose fields name an address the seed does not derive from them is no wallet: not_allowed (review 5b);
// - no key is derived between the open and the user's own Show, a lined-up click included (review 5a);
// - the drawn key and the 12 words are marked not to be translated (review 2);
// - Done, the x, the scrim and Esc tapped while Show still reads and derives win: the key is never drawn, the page goes
//   back to the app (review 1);
// - pagehide (a page the browser may keep for Back) takes the key or the 12 words out of the page at once, and the page
//   goes back to the app (review 3).
//   node --test test/main-export-leave.test.ts      (from packages/signpage)
import { answer, doc, esc, exportKeyCalls, find, opened, pageEvent, press, root, send, sendRaw, settle, shown, tap, tapSheet, until } from "./main-dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { readFileSync } from "node:fs";
import { SIGNPAGE_KIT_VERSION } from "../../kit/src/signpage/messages.ts";
import { entropyToWords } from "@blindfill/wallet/derive";
import { openWalletStore } from "@blindfill/wallet/store";

const A8 = JSON.parse(readFileSync(new URL("../../wallet/test/vectors/a8.json", import.meta.url), "utf8")) as { s: string; ids: { name: string; id?: string }[] };
const S = BigInt(`0x${A8.s}`);
const U_SOL = base58.encode(Buffer.from(A8.ids.find((x) => x.name === "U_{s,0}")!.id!, "hex"));
const OPEN = { type: "export.open", chain: "solana", address: U_SOL, return_key: "portfolio" };
type Node = { textContent: string; dataset: Record<string, string>; children: Node[]; attrs: Record<string, string>; className?: string };
const keyOnScreen = () => find(root(), (x) => x.dataset.key !== undefined) as unknown as Node | undefined;
const wordsOnScreen = () => find(root(), (x) => x.dataset.words !== undefined) as unknown as Node | undefined;
const back = (why: string) => until(`${why}: back to the app`, () => root().dataset.signin === "signed-in" && !shown(), 5000);
const frameBack = () => until("the frame back", () => doc.body.children.some((c) => c.tagName === "iframe"), 5000);
async function openExport(): Promise<void> {
  await frameBack();
  await settle();
  await opened(OPEN, "export");
  await until("the export screen drawn", () => !!find(root(), (x) => x.dataset.action === "show"));
}

test("main.ts: a record's word is no wallet, no key before Show, none translated, a leave during Show wins, pagehide drops what is drawn", async () => {
  await import("../src/main.ts");
  doc.body.children.find((c) => c.tagName === "iframe")!.dispatchEvent(new Event("load"));
  sendRaw({ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION });
  await until("the page signed out", () => root()?.dataset.signin === "signed-out");
  await opened({ type: "signin.open", way: "words", return_key: "portfolio" }, "words");
  (find(doc.body, (e) => e.dataset.input === "words") as unknown as { value: string }).value = entropyToWords(new Uint8Array(16));
  tap("next");
  await until("signed in, back to the app", () => root().dataset.signin === "signed-in" && !shown(), 10_000);
  await settle();
  const st = await openWalletStore();

  // review 5b: an op whose u names U_{s,0}'s address while its s and i derive another U: no wallet of this seed's
  await st.put("ops", "op-lies", { kind: "pool_deposit", follow: { chain: "solana", s: S.toString(), i: 5, u: U_SOL, left: "0" }, stage: "in_pool", final: true, created_ms: 1 });
  assert.deepEqual((await answer(send(OPEN)))?.error, { code: "not_allowed" }, "a record's own word for the address");
  assert.equal(shown(), false);
  assert.equal(exportKeyCalls(), 0);
  await st.put("ops", "op", { kind: "pool_deposit", follow: { chain: "solana", s: S.toString(), i: 0, u: U_SOL, left: "0" }, stage: "in_pool", final: true, created_ms: 2 });

  // review 5a: open, a lined-up click: no key derived, none in the page
  await openExport();
  await settle();
  tap("show");
  await settle();
  assert.equal(exportKeyCalls(), 0, "no key derived before the user's own Show");
  assert.equal(keyOnScreen(), undefined);
  press("show");
  await until("the key drawn", () => keyOnScreen() !== undefined);
  assert.equal(exportKeyCalls(), 1, "derived once, at Show");
  // review 2: the key is marked not to be translated
  assert.equal(keyOnScreen()!.className, "notranslate");
  assert.equal(keyOnScreen()!.attrs.translate, "no");
  press("done");
  await back("Done");

  // review 1: each way off, tapped while Show still reads the store and derives
  for (const [how, leave] of [["Done", () => press("done")], ["the x", () => tapSheet("close")], ["the scrim", () => tapSheet("scrim")], ["Esc", esc]] as const) {
    await openExport();
    const calls = exportKeyCalls();
    // every draw of the screen from here: a key drawn even for a moment is seen
    const r = root() as unknown as { replaceChildren: (...c: Node[]) => void };
    const draw = r.replaceChildren;
    let drewKey = false;
    r.replaceChildren = (...c: Node[]) => ((drewKey ||= c.some((x) => x.dataset?.key !== undefined)), draw.apply(r, c));
    press("show");
    leave();
    await back(how);
    await settle();
    r.replaceChildren = draw;
    assert.equal(drewKey, false, `${how}: the key never drawn after the leave`);
    assert.equal(keyOnScreen(), undefined, `${how}: no key drawn`);
    assert.equal(root().dataset.signin, "signed-in", how);
    assert.equal(shown(), false, how);
    assert.ok(exportKeyCalls() <= calls + 1, how);
  }

  // review 3: pagehide with the key drawn: out of the page in the same task, then back to the app
  await openExport();
  press("show");
  await until("the key drawn", () => keyOnScreen() !== undefined);
  pageEvent("pagehide");
  assert.equal(keyOnScreen(), undefined, "the key out at pagehide, in its task");
  await back("pagehide on the export");

  // the backup's 12 words: marked not to be translated, and out of the page at pagehide
  await frameBack();
  await settle();
  await opened({ type: "backup.open", return_key: "portfolio" }, "backup");
  await until("the 12 words drawn", () => wordsOnScreen() !== undefined);
  assert.equal(wordsOnScreen()!.className, "notranslate");
  assert.equal(wordsOnScreen()!.attrs.translate, "no");
  pageEvent("pagehide");
  assert.equal(wordsOnScreen(), undefined, "the 12 words out at pagehide, in its task");
  await back("pagehide on the backup");
  await settle();
  assert.equal(wordsOnScreen(), undefined);
});
