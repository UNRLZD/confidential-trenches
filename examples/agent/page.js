// The agent's own app page, served on localhost: it loads @blindfill/kit's client in popup mode, opens the signing page's
// /connect on a tap of Connect, and keeps each request's outcome and the latest state where the agent reads them.
import { createSignpageClient } from "@blindfill/kit";

const SIGN = "https://confidential.unrealized.trade/";
const w = window;
w.outcomes = {};
w.snap = null;
let client = null;

document.getElementById("connect").addEventListener("click", () => {
  client = createSignpageClient({
    url: SIGN,
    mode: "popup",
    host: { window, document, mount: document.body, open: (u) => window.open(u, "blindfill", "popup,width=440,height=760") },
  });
  client.subscribe((s) => {
    w.snap = JSON.parse(JSON.stringify({ status: s.status, stale: s.stale, state: s.state }));
  });
});

w.ask = (kind, params) => {
  const r = client.request(kind, params);
  r.outcome.then(
    (o) => (w.outcomes[r.id] = o),
    (e) => (w.outcomes[r.id] = { ok: false, error: { code: String(e?.message ?? e) } }),
  );
  return r.id;
};
