// The screens the APP_HOST frame must not sit under (src/shell.ts open(sealed), seal(): it leaves the document before
// they show, and comes back new at close): every screen with a field typed into (the 12 words, the withdraw forms' To and
// amount, the held deposit's account), so no key typed or pasted there can reach it; and the 12 words shown (backup),
// since a frame under them keeps the opening tap's activation for seconds and could put its own words on the clipboard
// over the user's Copy, or float a Picture-in-Picture window over them. A frame left in the page under a typed screen can
// take the keyboard's focus with focus() and no gesture (Chromium, Firefox and WebKit all allow it, inert does not stop
// it), and then reads what is typed or pasted, including a paste that carries the 12 words: none stays.
export const SEALED: ReadonlySet<string> = new Set(["words", "invalid-code", "withdraw", "pool-withdraw", "held", "backup"]);
