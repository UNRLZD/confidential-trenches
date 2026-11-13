// src/main.ts's closed notice for the open kinds that end with no layer shown (card signing-layer-says-when-it-closes,
// review P2-1), booted top-level on test/main-dom.ts: an answer that says closes: true is told exactly once, as a close
// tells it (the frame inert from the run's end, the notice PROTECT_MS later with the frame live again), on each ending
// the page reads from its own store after its answer went:
//   signin.open after another tab stored a seed (its broadcast not heard yet): the page lands signed in, no layer;
//   a step that throws before its layer (here the held op's read): the error, then the page reads its store again;
//   sign out with no seed at the read (another tab's sign out not heard yet): the page shows signed out, no layer.
// The open whose held op is missing is test/main-closed-notice.test.ts. Red before the review's fix: no notice for any.
//   node --test test/main-closed-notice-ends.test.ts      (from packages/signpage)
import { answer, doc, notices, root, send, sendRaw, shown, told, until } from "./main-dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openWalletStore } from "@blindfill/wallet/store";
import { SIGNPAGE_KIT_VERSION } from "../../kit/src/signpage/messages.ts";
import { PROTECT_MS } from "../src/guard.ts";

/** Runs `step` with every BroadcastChannel post dropped: another tab's write whose broadcast has not reached this page. */
async function unheard(step: () => Promise<void>): Promise<void> {
  const real = BroadcastChannel.prototype.postMessage;
  BroadcastChannel.prototype.postMessage = function () {};
  try {
    await step();
  } finally {
    BroadcastChannel.prototype.postMessage = real;
  }
}
/** Sends `kind`, checks its answer says closes, waits for the page to reach `state` with no layer, and gives the id. */
async function ended(kind: Record<string, unknown>, state: string): Promise<string> {
  const id = send(kind);
  assert.deepEqual((await answer(id))?.result, { pending: true, closes: true }, JSON.stringify(kind));
  await until(`the page ${state}`, () => root().dataset.signin === state);
  assert.equal(shown(), false, "no layer shown");
  return id;
}

test("main.ts: an open that ends with no layer (signed in meanwhile, a step that throws, no seed at the read) is told once, PROTECT_MS after its run, the frame live", async () => {
  await import("../src/main.ts");
  doc.body.children.find((c) => c.tagName === "iframe")!.dispatchEvent(new Event("load"));
  sendRaw({ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION });
  await until("the page signed out", () => root()?.dataset.signin === "signed-out");

  // another tab stores a seed; this page has not heard it: signin.open lands on that account, signed in, no layer
  await unheard(async () => {
    const other = await openWalletStore({});
    await other.insertSeed({ v: 1, entropy: new Uint8Array(16).fill(0x7f), source: "code", code_saved: true, created_ms: 1 });
    other.close();
  });
  const signedIn = await ended({ type: "signin.open", way: "wallet", return_key: "portfolio" }, "signed-in");
  await new Promise((r) => setTimeout(r, PROTECT_MS - 150));
  assert.deepEqual(notices(), [], "none within PROTECT_MS of the run's end");
  await told(signedIn, 1, "signin.open on a seed stored meanwhile");

  // a step that throws before its layer: the held op's read fails, the page shows the error and reads its store again
  const proto = (globalThis as unknown as { IDBObjectStore: { prototype: { getAllKeys: (...a: unknown[]) => unknown } } }).IDBObjectStore.prototype;
  const keys = proto.getAllKeys;
  let thrown = 0;
  let by = "";
  proto.getAllKeys = function (this: { name: string }, ...a: unknown[]) {
    if (this.name === "ops" && thrown === 0) {
      thrown++;
      by = new Error().stack ?? "";
      throw new Error("planted: the ops read fails");
    }
    return keys.apply(this, a);
  };
  try {
    const failed = send({ type: "withdraw.open", from_id: "cd".repeat(32), return_key: "portfolio" });
    assert.deepEqual((await answer(failed))?.result, { pending: true, closes: true });
    await until("the planted read failed", () => thrown === 1);
    assert.match(by, /heldOpFor/, "the read that failed is the open's own, before its layer");
    await until("the page signed in again", () => root().dataset.signin === "signed-in");
    assert.equal(shown(), false, "no layer shown");
    await told(failed, 1, "a step that threw before its layer");
  } finally {
    proto.getAllKeys = keys;
  }

  // another tab signs out; this page has not heard it: Sign out reads no seed and shows signed out, no layer
  await unheard(async () => {
    const other = await openWalletStore({});
    await other.signOut();
  });
  const noSeed = await ended({ type: "signout", return_key: "portfolio" }, "signed-out");
  await told(noSeed, 1, "sign out with no seed at the read");
  assert.equal(notices().length, 3, "three notices in all, one per open");
});
