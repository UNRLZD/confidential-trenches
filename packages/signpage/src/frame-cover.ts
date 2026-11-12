// What the APP_HOST frame does under each screen of the sheet (src/shell.ts open(cover)):
// - sealed: out of the document before the screen's first field exists. The 12 words typed (words, invalid-code), the
//   12 words shown (backup: a frame under them keeps the opening tap's activation and could write the clipboard over the
//   user's Copy) and the held deposit's way out (held).
// - watched: the withdraw forms (To and the amount). The frame stays in the page under the sheet, dimmed, inert, out of
//   the tab order and the pointer's reach, so the user sees the app they came from. The first time it holds the
//   keyboard's focus (a frame calling focus() with no gesture, which Chromium, Firefox and WebKit all allow and inert
//   does not stop) it is taken out in that task and the focus goes back to the field that had it; it comes back only
//   when the sheet closes. The limit, measured: in Chromium a frame in its own process gets the keys typed between its
//   steal and this window's blur handler (one key at 390 in the harness, apps/terminal/test/e2e/signing-sheet/run.mjs),
//   one steal per open, a paste in that window included: the paste goes to the frame's document, and To gets nothing.
//   What that window can give is the app's already: the app that opened the form is told the withdraw's transactions in
//   its state (packages/kit/src/signpage/messages.ts:504, the op { kind: "withdraw", stage, txs }; the pool form's run
//   writes the same op with its Solana transactions, src/pool-testnet.ts, src/pool-withdraw.ts:376 and :395), so the To
//   address and the amount are public to it from the chain. The 12 words stay sealed: no key can reach the app there.
// - kept: every other screen. In the page under the sheet, inert, with its state.
export type Cover = "kept" | "watched" | "sealed";

export const SEALED: ReadonlySet<string> = new Set(["words", "invalid-code", "held", "backup"]);
export const WATCHED: ReadonlySet<string> = new Set(["withdraw", "pool-withdraw"]);

/** The frame's cover under the screen `state`. */
export function coverOf(state: string): Cover {
  return SEALED.has(state) ? "sealed" : WATCHED.has(state) ? "watched" : "kept";
}
