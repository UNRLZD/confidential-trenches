// src/main.ts's Create when two tabs press it at once (card sign-in-restore-rides-out-a-held-server), booted top-level on
// test/main-dom.ts. The live check wallet-passkey-prf's race run, 4 runs of 4 since 13 Nov and again on release 167
// (16 Nov 22:33Z): tab B's passkey lands and stores its seed while Chrome refuses tab A's sheet (NotAllowedError), and
// tab A showed "Cancelled" beside an account already stored. Here the sheet stands in for both: while it is up the
// other tab stores its seed (the wallet's own insert-only signInPrf on the same store), then the sheet answers
// NotAllowedError. The page lands on the stored seed, signed in as the other tab's account, the seed unchanged.
//   node --test test/main-create-race.test.ts      (from packages/signpage)
import { doc, press, root, sendRaw, until } from "./main-dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openWalletStore } from "@blindfill/wallet/store";
import { signInPrf } from "../../wallet/src/signin/words.ts";
import { SIGNPAGE_KIT_VERSION } from "../../kit/src/signpage/messages.ts";

test("main.ts: Create refused by the browser while another tab stored its seed lands on that seed, signed in, never Cancelled", async () => {
  let stored: number | null = null;
  Object.defineProperty(globalThis.navigator, "credentials", {
    configurable: true,
    value: {
      create: async () => {
        // the other tab's passkey lands first: its seed stored, insert-only
        const s = await openWalletStore({});
        const l = await signInPrf(async () => s, new Uint8Array(16).fill(9));
        assert.equal(l.screen, "signed-in");
        stored = ((await s.get("meta", "seed")) as { created_ms: number }).created_ms;
        throw Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });
      },
      get: async () => null,
    },
  });
  await import("../src/main.ts");
  doc.body.children.find((c) => c.tagName === "iframe")!.dispatchEvent(new Event("load"));
  sendRaw({ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION });
  await until("the page signed out", () => root()?.dataset.signin === "signed-out");
  press("create");
  await until("Create ended", () => root()?.dataset.signin !== "signed-out" && root()?.dataset.signin !== "loading", 5000);
  assert.equal(root().dataset.signin, "signed-in");
  assert.match(root().dataset.account ?? "", /^[0-9a-f]{64}$/);
  // the other tab's seed is the one stored, never replaced
  const s = await openWalletStore({});
  assert.ok(stored !== null);
  const now = (await s.get("meta", "seed")) as { source: string; created_ms: number };
  assert.deepEqual([now.source, now.created_ms], ["prf", stored]);
});
