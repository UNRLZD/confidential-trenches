// The page scripts/focus-steal.e2e.mjs drives: SIGN_HOST's real shell (src/shell.ts) with one field on its sheet, as a
// typed screen's (the 12 words, a withdraw form's To). window.__open(typed) opens the sheet as src/main.ts does: on a
// typed open the field is made only once the frame is out (shell.whenOut), on any other at once. Never part of the
// signing page's build.
import { signedOutState } from "../src/api.ts";
import { mountShell } from "../src/shell.ts";

const shell = mountShell(document, { state: () => signedOutState() });
const field = (): void => {
  const to = document.createElement("input");
  to.id = "to";
  to.autocomplete = "off";
  shell.body.replaceChildren(to);
};
const w = window as unknown as { __shell: typeof shell; __open: (typed: boolean) => void };
w.__shell = shell;
w.__open = (typed) => {
  shell.open(typed);
  if (typed) shell.whenOut(field);
  else field();
};
