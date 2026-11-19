// src/main.ts's export.open (card signpage-backup-export; wallet.md §2.8 W:938, §2.9 rows 12 and W:975 at research
// ffcba5e), booted top-level on test/main-dom.ts, signed in on the published A.8 test seed (the all-zero entropy; never
// funded): export.open is refused not_allowed signed out, for an address this seed's records do not derive, for the
// seed's own key on a chain its record is not of, and for a chain outside the kit's; for the U_X a pool deposit op names
// it answers with no key, draws the export screen with no key on it, draws the key only at the user's own Show, puts it
// on the clipboard only at their own Copy, and every way off the screen drops it from the page (and empties the
// clipboard after a Copy). Every message the page posts to APP_HOST in the run is read: none carries the key, in any form.
//   node --test test/main-export.test.ts      (from packages/signpage)
import { answer, clip, doc, find, opened, posted, press, root, send, sendRaw, settle, shown, tap, tapSheet, until } from "./main-dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { readFileSync } from "node:fs";
import { SIGNPAGE_KIT_VERSION } from "../../kit/src/signpage/messages.ts";
import { depositId, entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore } from "@blindfill/wallet/store";

const A8 = JSON.parse(readFileSync(new URL("../../wallet/test/vectors/a8.json", import.meta.url), "utf8")) as { s: string; ids: { name: string; id?: string }[]; wallets: { name: string; address: string }[] };
const S = BigInt(`0x${A8.s}`);
const U_ID = A8.ids.find((x) => x.name === "U_{s,0}")!.id!;
const U_SOL = base58.encode(Buffer.from(U_ID, "hex"));
const W_SOL = A8.wallets.find((w) => w.name === "W_{sol,l,0}")!.address;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// every text and data value in the page, so a key anywhere in its DOM is found
type Node = { textContent: string; dataset: Record<string, string>; children: Node[] };
const allText = (el: Node): string => [el.textContent, ...Object.values(el.dataset), ...el.children.map(allText)].join("\n");
const keyOnScreen = () => find(root(), (x) => x.dataset.key !== undefined);

test("main.ts: export.open shows one key of this seed only after the user's own Show, never sends it, and drops it on every way off", async () => {
  await import("../src/main.ts");
  doc.body.children.find((c) => c.tagName === "iframe")!.dispatchEvent(new Event("load"));
  sendRaw({ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION });
  await until("the page signed out", () => root()?.dataset.signin === "signed-out");

  // signed out: no seed, no wallet
  assert.deepEqual((await answer(send({ type: "export.open", chain: "solana", address: U_SOL, return_key: "portfolio" })))?.error, { code: "not_allowed" });

  // signed in on the A.8 words, typed
  await opened({ type: "signin.open", way: "words", return_key: "portfolio" }, "words");
  (find(doc.body, (e) => e.dataset.input === "words") as unknown as { value: string }).value = entropyToWords(new Uint8Array(16));
  tap("next");
  await until("signed in, back to the app", () => root().dataset.signin === "signed-in" && !shown(), 10_000);
  await settle();

  // the seed's own U_X before any record names it: no wallet of the page's records
  assert.deepEqual((await answer(send({ type: "export.open", chain: "solana", address: U_SOL, return_key: "portfolio" })))?.error, { code: "not_allowed" }, "no record yet");

  // a pool deposit op of U_{s,0} on Solana, ended with nothing left, as the page's follow writes it
  const st = await openWalletStore();
  await st.put("ops", "export-test-op", { kind: "pool_deposit", follow: { chain: "solana", s: S.toString(), i: 0, u: U_SOL, left: "0" }, stage: "in_pool", final: true, created_ms: 1 });

  for (const [chain, address, why] of [
    ["solana", "11111111111111111111111111111111", "a foreign address"],
    ["solana", W_SOL, "the seed's own W, which no record names"],
    ["near", U_ID, "U_{s,0}'s own key as a NEAR account: its record is Solana's"],
    ["base", U_SOL, "an address of another chain"],
  ] as const) {
    const a = await answer(send({ type: "export.open", chain, address, return_key: "portfolio" }));
    assert.deepEqual(a?.error, { code: "not_allowed" }, why);
    assert.equal(shown(), false, why);
  }
  // a chain outside the kit's: refused before the page reads anything
  const bad = await answer(send({ type: "export.open", chain: "ethereum", address: U_SOL, return_key: "portfolio" }));
  assert.equal(bad?.ok, false, "ethereum");
  assert.equal(shown(), false);

  // the key the standard derivation gives U_{s,0}, as Phantom imports it (the 32-byte seed, then the public key)
  const seed64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
  const u = depositId(seed64, S, 0);
  assert.equal(hex(ed25519.getPublicKey(u.secretKey)), U_ID);
  const KEY = base58.encode(new Uint8Array([...u.secretKey, ...u.publicKey]));
  const forms = [KEY, hex(u.secretKey), base58.encode(u.secretKey), Buffer.from(u.secretKey).toString("base64")];
  seed64.fill(0);

  // the wallet the op names: answered with no key, the screen drawn with none
  const id = await opened({ type: "export.open", chain: "solana", address: U_SOL, return_key: "portfolio" }, "export");
  assert.deepEqual((await answer(id))?.result, { pending: true, closes: true });
  await until("the export screen drawn", () => !!find(root(), (x) => x.dataset.action === "show"));
  const before = allText(root());
  assert.ok(before.includes("Solana") && before.includes(`${U_SOL.slice(0, 4)}…${U_SOL.slice(-4)}`), before);
  assert.equal(keyOnScreen(), undefined, "no key before Show");
  for (const f of forms) assert.ok(!allText(doc.body).includes(f), "no key in the page before Show");
  // no Cancel of its own: Done is its way back
  assert.equal(find(root(), (x) => x.dataset.action === "cancel"), undefined);

  // a click with no activation of the user's (a page's lined-up click) draws nothing
  tap("show");
  await settle();
  assert.equal(keyOnScreen(), undefined, "an untrusted click draws no key");

  // the user's own Show: the key drawn, in Phantom's form
  press("show");
  await until("the key drawn", () => keyOnScreen() !== undefined);
  assert.equal(keyOnScreen()!.textContent, KEY);
  assert.equal(find(root(), (x) => x.dataset.action === "show"), undefined);

  // Copy: on the clipboard only by the user's own tap
  const clipped = clip.length;
  tap("copy");
  await settle();
  assert.equal(clip.length, clipped, "an untrusted click copies nothing");
  press("copy");
  assert.equal(clip.at(-1), KEY);

  // Done: back to the app, the key out of the page, the clipboard written empty
  press("done");
  await until("back to the app", () => root().dataset.signin === "signed-in" && !shown());
  assert.equal(keyOnScreen(), undefined);
  for (const f of forms) assert.ok(!allText(doc.body).includes(f), "no key in the page after Done");
  assert.equal(clip.at(-1), "", "the clipboard written empty");

  // the x, with the key drawn: the key goes with the screen
  await until("the frame back", () => doc.body.children.some((c) => c.tagName === "iframe"), 5000);
  await settle();
  await opened({ type: "export.open", chain: "solana", address: U_SOL, return_key: "portfolio" }, "export");
  await until("the export screen drawn", () => !!find(root(), (x) => x.dataset.action === "show"));
  press("show");
  await until("the key drawn", () => keyOnScreen() !== undefined);
  tapSheet("close");
  await until("back to the app", () => root().dataset.signin === "signed-in" && !shown());
  for (const f of forms) assert.ok(!allText(doc.body).includes(f), "no key in the page after the x");

  // a second open finds the key gone: Show again is needed
  await until("the frame back", () => doc.body.children.some((c) => c.tagName === "iframe"), 5000);
  await settle();
  await opened({ type: "export.open", chain: "solana", address: U_SOL, return_key: "portfolio" }, "export");
  await until("the export screen drawn", () => !!find(root(), (x) => x.dataset.action === "show"));
  assert.equal(keyOnScreen(), undefined, "no key kept from the last open");
  press("done");
  await until("back to the app", () => !shown());
  await settle();

  // every message the page posted to APP_HOST in the run: none holds the key in any form, nor its secret half
  const wire = JSON.stringify(posted);
  assert.ok(posted.length > 0);
  for (const f of forms) assert.ok(!wire.includes(f), "a message to APP_HOST carries the key");
  u.secretKey.fill(0);
});
