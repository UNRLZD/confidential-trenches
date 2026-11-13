// src/main.ts's closed notice on another tab's sign out (card signing-layer-says-when-it-closes), booted top-level on
// test/main-dom.ts: a sheet shows over the kept frame, another tab signs out, the page reloads, and nothing is told
// before that reload (the app's document goes with it). Its own process: the sign out leaves the page signed out with
// its gate shut for good, as a real reload would.
//   node --test test/main-closed-notice-elsewhere.test.ts      (from packages/signpage)
import { answer, doc, notices, reloadCount, root, send, sendRaw, shown, told, until } from "./main-dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { WALLET_CHANNEL } from "@blindfill/wallet/store";
import { SIGNPAGE_KIT_VERSION } from "../../kit/src/signpage/messages.ts";

test("main.ts: another tab's sign out under a shown sheet reloads the page, and nothing is told before it", async () => {
  await import("../src/main.ts");
  doc.body.children.find((c) => c.tagName === "iframe")!.dispatchEvent(new Event("load"));
  sendRaw({ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION });
  await until("the page signed out", () => root()?.dataset.signin === "signed-out");
  const id = send({ type: "signin.open", way: "wallet", return_key: "portfolio" });
  assert.deepEqual((await answer(id))?.result, { pending: true, closes: true });
  await until("the choose sheet", () => shown() && root().dataset.signin === "choose");
  const before = reloadCount();
  const other = new BroadcastChannel(WALLET_CHANNEL);
  other.postMessage({ kind: "signout" });
  other.close();
  await until("a reload on another tab's sign out", () => reloadCount() > before);
  await told(id, 0, "a sign out in another tab");
  assert.deepEqual(notices(), []);
});
