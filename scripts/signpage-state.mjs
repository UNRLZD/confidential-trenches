// Whether the kit's own client takes a state from SIGN_HOST, for the live checks that read one (signpage-shell,
// signpage-signin-kinds). The client runs as the terminal runs it inside SIGN_HOST's shell (parent mode, start.tsx), with
// a stand-in window: its handshake asks `state`, the state is posted back as the shell's answer, and it is taken when
// the client holds it and dropped nothing as the wrong shape. So a check judges a state by the kit's state schema itself
// (packages/kit/src/signpage/schema.ts, SIGNPAGE_RESULT_SCHEMAS.state), reached through the kit's public entry, and a
// key the page adds together with the kit (pools, release-9) never leaves a hand copy of the keys behind.
import { createSignpageClient } from "../packages/kit/src/index.ts";

const SIGN = "https://confidential.unrealized.trade";

/** @param {unknown} s a state as SIGN_HOST sent it @returns {boolean} the kit's client holds it as its state */
export function kitTakesState(s) {
  const heard = new Set();
  let asked = null;
  const parent = { postMessage: (m) => void (asked = m) };
  const win = { addEventListener: (t, f) => t === "message" && heard.add(f), removeEventListener: (_t, f) => heard.delete(f) };
  let client = null;
  try {
    client = createSignpageClient({ url: `${SIGN}/`, host: { window: win, document: null, mount: null, parent }, mode: "parent", retryMs: 0 });
    if (asked === null || typeof asked !== "object" || asked.type !== "state") return false;
    for (const f of heard) f({ origin: SIGN, source: parent, data: { v: 1, id: asked.id, ok: true, result: s } });
    return client.dropped().shape === 0 && client.snapshot().state !== null && JSON.stringify(client.snapshot().state) === JSON.stringify(s);
  } catch {
    return false;
  } finally {
    client?.destroy();
  }
}
