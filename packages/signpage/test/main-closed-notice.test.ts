// src/main.ts's closed notice (card signing-layer-says-when-it-closes), booted top-level on test/main-dom.ts (the
// minimal DOM of test/main-sheet.test.ts): every open kind that shows a layer over the kept frame is told, once, when
// that layer has closed, the frame live again, by every way it ends there (Cancel, Esc, the x, the scrim), and one that
// showed no layer as a close would tell it (the rest of those endings: test/main-closed-notice-ends.test.ts). None for an
// open the page refused once its sheet showed, one whose frame went under a typed screen (the
// 12 words' field, the backup that ends signed in: the app's document went with the frame), an app below kit 1.13 (its
// answer carries no closes either), and none before a sign out's reload, whose app document goes with the page.
// Red before this card: no open's answer carried closes and the page posted no notice.
//   node --test test/main-closed-notice.test.ts      (from packages/signpage)
import { answer, doc, esc, find, frameIn, holdDigest, notices, opened, press, reloadCount, root, send, sendRaw, settle, shown, tap, tapSheet, told, until } from "./main-dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SIGNPAGE_KIT_VERSION } from "../../kit/src/signpage/messages.ts";
import { PROTECT_MS } from "../src/guard.ts";

test("main.ts: each open whose layer showed over the kept frame is told once when it closed, by every way it ends, and one with no layer once; none for a refusal, a typed screen, an older kit or a reload", async () => {
  await import("../src/main.ts");
  doc.body.children.find((c) => c.tagName === "iframe")!.dispatchEvent(new Event("load"));
  sendRaw({ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION });
  await until("the page signed out", () => root()?.dataset.signin === "signed-out");

  // Cancel on the choose sheet: the answer says a notice comes; none while it shows or within PROTECT_MS of its close
  const a = send({ type: "signin.open", way: "wallet", return_key: "portfolio" });
  // refused once shown: a second open the frame sent before the sheet opened, decided while it shows (its request hash
  // held until then, as test/main-sheet.test.ts holds it), is refused, and is never told
  let release!: () => void;
  holdDigest(new Promise<void>((ok) => (release = ok)));
  const refused = send({ type: "signin.open", way: "passkey", return_key: "portfolio" });
  holdDigest(null);
  const aAnswer = await answer(a);
  assert.deepEqual(aAnswer, { v: 1, id: a, ok: true, result: { pending: true, closes: true } });
  await until("the choose sheet", () => shown() && root().dataset.signin === "choose");
  release();
  assert.deepEqual((await answer(refused))?.error, { code: "not_allowed" });
  await settle();
  assert.deepEqual(notices(), [], "none while the layer shows");
  press("cancel");
  await until("Cancel back to the app", () => !shown());
  await new Promise((r) => setTimeout(r, PROTECT_MS - 150));
  assert.deepEqual(notices(), [], "none while the frame is still inert after the close");
  await told(a, 1, "Cancel");
  assert.deepEqual(notices(refused), [], "the refused open is never told");

  // Esc, the x and the scrim on the passkey sheet (signed out: no field, the frame kept)
  for (const [how, leave] of [["Esc", esc], ["the x", () => tapSheet("close")], ["the scrim", () => tapSheet("scrim")]] as const) {
    const id = await opened({ type: "signin.open", way: "passkey", return_key: "portfolio" }, "signed-out");
    leave();
    await until(`${how} back to the app`, () => !shown());
    await told(id, 1, how);
  }

  // an app below kit 1.13: its answer has no closes and it is told nothing
  sendRaw({ v: 1, type: "hello", kit: "1.12" });
  const old = send({ type: "signin.open", way: "wallet", return_key: "portfolio" });
  assert.deepEqual((await answer(old))?.result, { pending: true }, "kit-v1.12 is sent the answer it reads");
  await until("the choose sheet", () => shown() && root().dataset.signin === "choose");
  press("cancel");
  await until("back to the app", () => !shown());
  await told(old, 0, "kit-v1.12");
  sendRaw({ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION });

  // a typed screen: the frame went in the open's task, and its document and lock with it; the new frame is told nothing
  const typed = await opened({ type: "signin.open", way: "words", return_key: "portfolio" }, "words");
  press("cancel");
  await until("back to the app", () => !shown());
  await until("a new frame", frameIn);
  await told(typed, 0, "the 12 words' field");

  // a new account: Create, the backup (typed), Saved, signed in: the layer ends on the result, under a frame taken out
  const made = await opened({ type: "signin.open", way: "passkey", return_key: "portfolio" }, "signed-out");
  tap("create");
  await until("the backup", () => root().dataset.signin === "backup" && !!find(root(), (x) => x.dataset.action === "saved"));
  press("saved");
  await until("signed in, back to the app", () => root().dataset.signin === "signed-in" && !shown());
  await until("a new frame", frameIn);
  await told(made, 0, "Saved on the backup");

  // no layer: a held deposit's way out for an id this page holds no op under goes back to the app with no screen, and is
  // told as a close would tell it (review P2-1: it was told nothing, so the app's lock waited on its own timer)
  const none = send({ type: "withdraw.open", from_id: "ab".repeat(32), return_key: "portfolio" });
  const noneA = await answer(none);
  assert.deepEqual(noneA?.result, { pending: true, closes: true }, `${JSON.stringify(noneA)} on ${root().dataset.signin}`);
  await settle();
  assert.equal(shown(), false, "no layer shown");
  await told(none, 1, "an open that showed no layer");

  // the reload ending of a sign out here, on the sign-out sheet (the frame kept): the page reloads, and nothing is told
  // before it (the app's document goes with the reload); another tab's sign out is test/main-closed-notice-elsewhere.test.ts
  const out = await opened({ type: "signout", return_key: "portfolio" }, "signout");
  const before = reloadCount();
  press("signout");
  await until("a reload on this tab's sign out", () => reloadCount() > before, 5000);
  await told(out, 0, "a sign out here");
  assert.equal(notices().length, 5, "five notices in all: Cancel, Esc, the x, the scrim, the open that showed no layer");
});
