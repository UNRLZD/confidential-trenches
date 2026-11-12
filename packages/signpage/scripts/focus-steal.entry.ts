// The page scripts/focus-steal.e2e.mjs drives: SIGN_HOST's real shell (src/shell.ts) with one field on its sheet, as the
// withdraw forms' To. The e2e opens and closes it by window.__shell. Never part of the signing page's build.
import { signedOutState } from "../src/api.ts";
import { mountShell } from "../src/shell.ts";

const shell = mountShell(document, { state: () => signedOutState() });
const to = document.createElement("input");
to.id = "to";
to.autocomplete = "off";
shell.body.append(to);
(window as unknown as { __shell: typeof shell }).__shell = shell;
