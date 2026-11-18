// src/main.ts's Use passkey beside another tab's Create, booted top-level on test/main-dom.ts: the restore path and a
// sheet that fails with an error other than NotAllowedError, the other paths test/main-create-race.test.ts's fix covers
// (signIn reads the store before it draws an end with no account). While the sheet is up the other tab stores its seed
// (the wallet's own insert-only signInPrf on the same store), then the sheet throws. The other tab's channel event is
// held until the page's step has ended, so the page lands on the stored seed from its own read, never on the event.
//   node --test test/main-use-race.test.ts      (from packages/signpage)
import { doc, press, root, sendRaw, until } from "./main-dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openWalletStore } from "@blindfill/wallet/store";
import { signInPrf } from "../../wallet/src/signin/words.ts";
import { SIGNPAGE_KIT_VERSION } from "../../kit/src/signpage/messages.ts";

// every BroadcastChannel post (the other tab's "seed written") held until released, then sent in order
const realPost = BroadcastChannel.prototype.postMessage;
let heldPosts: (() => void)[] | null = null;
BroadcastChannel.prototype.postMessage = function (this: BroadcastChannel, m: unknown) {
  if (heldPosts) heldPosts.push(() => realPost.call(this, m));
  else realPost.call(this, m);
};
const releasePosts = () => {
  const q = heldPosts ?? [];
  heldPosts = null;
  for (const send of q) send();
};

test("main.ts: Use passkey whose sheet fails while another tab stored its seed lands on that seed, signed in, never Error", async () => {
  let stored: number | null = null;
  Object.defineProperty(globalThis.navigator, "credentials", {
    configurable: true,
    value: {
      create: async () => null,
      get: async () => {
        // the other tab's passkey lands first: its seed stored, insert-only
        const s = await openWalletStore({});
        const l = await signInPrf(async () => s, new Uint8Array(16).fill(9));
        assert.equal(l.screen, "signed-in");
        stored = ((await s.get("meta", "seed")) as { created_ms: number }).created_ms;
        throw Object.assign(new Error("The operation is insecure."), { name: "SecurityError" });
      },
    },
  });
  await import("../src/main.ts");
  doc.body.children.find((c) => c.tagName === "iframe")!.dispatchEvent(new Event("load"));
  sendRaw({ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION });
  await until("the page signed out", () => root()?.dataset.signin === "signed-out");
  // every screen the page draws from the tap on, not only the one a poll happens to read
  const drawn: string[] = [];
  const r = root();
  r.dataset = new Proxy(r.dataset, { set: (t, k, v) => ((k === "signin" && drawn.push(v)), (t[k as string] = v), true) });
  heldPosts = [];
  press("use");
  await until("Use passkey ended", () => root()?.dataset.signin !== "signed-out" && root()?.dataset.signin !== "loading", 5000);
  const ended = root().dataset.signin;
  assert.ok((heldPosts?.length ?? 0) > 0, "the other tab's write posted on the channel");
  releasePosts();
  assert.deepEqual(drawn.filter((d) => ["cancelled", "no-prf", "error"].includes(d)), [], `drawn: ${drawn.join(" > ")}`);
  assert.equal(ended, "signed-in");
  assert.match(root().dataset.account ?? "", /^[0-9a-f]{64}$/);
  // the other tab's seed is the one stored, never replaced
  const s = await openWalletStore({});
  assert.ok(stored !== null);
  const now = (await s.get("meta", "seed")) as { source: string; created_ms: number };
  assert.deepEqual([now.source, now.created_ms], ["prf", stored]);
});
