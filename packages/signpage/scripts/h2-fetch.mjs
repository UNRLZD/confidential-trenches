// A fetch for the devnet scripts that reads as a browser does (card sol-buy-reads-side-by-side): every request to an
// origin goes on one HTTP/2 connection to it, the reads sent at once side by side. Node's own fetch speaks HTTP/1.1 and
// opens a TLS socket for each read in flight, so a round of seven reads paid seven handshakes and its answers looked
// one after another (runs 1 and 2 of card pool-buy-filled-2s). Only what the scripts send: a method, headers, a string
// body and an abort signal; the answer a standard Response.
//   const fetch = h2Fetch(); ... fetch.close();
import http2 from "node:http2";

/** The fetch, and close() to end its connections (a script's end). */
export function h2Fetch() {
  const sessions = new Map();
  const session = (origin) => {
    let s = sessions.get(origin);
    if (s === undefined || s.closed || s.destroyed) {
      s = http2.connect(origin);
      // a connection that fails or ends is dropped, so the next request opens a new one
      const drop = () => sessions.get(origin) === s && sessions.delete(origin);
      s.on("error", drop);
      s.on("close", drop);
      s.on("goaway", drop);
      sessions.set(origin, s);
    }
    return s;
  };
  const fetch = (input, init = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(String(input));
      const signal = init.signal;
      if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
      const headers = { ":method": init.method ?? "GET", ":path": url.pathname + url.search };
      for (const [k, v] of new Headers(init.headers ?? {})) headers[k] = v;
      let req;
      try {
        req = session(url.origin).request(headers);
      } catch (e) {
        return reject(e);
      }
      const abort = () => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        reject(signal.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      const chunks = [];
      let head = null;
      req.on("response", (h) => (head = h));
      req.on("data", (d) => chunks.push(d));
      req.on("error", (e) => (signal?.removeEventListener("abort", abort), reject(e)));
      req.on("end", () => {
        signal?.removeEventListener("abort", abort);
        if (head === null) return reject(new Error("no answer"));
        const out = new Headers();
        for (const [k, v] of Object.entries(head)) if (!k.startsWith(":")) out.set(k, Array.isArray(v) ? v.join(", ") : String(v));
        const status = Number(head[":status"]);
        resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers: out }));
      });
      const b = init.body;
      if (b !== undefined && b !== null && typeof b !== "string" && !ArrayBuffer.isView(b)) return req.close(), reject(new TypeError("h2Fetch: a string or bytes body only"));
      req.end(b === undefined || b === null ? undefined : typeof b === "string" ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength));
    });
  fetch.close = () => {
    for (const s of sessions.values()) s.close();
    sessions.clear();
  };
  return fetch;
}
