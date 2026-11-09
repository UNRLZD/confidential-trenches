#!/usr/bin/env node
// Live check of card market-data-push: the helper's push socket (GET /v1/market/push, upgraded to a WebSocket,
// apps/helper/src/data/push.ts) sends live updates to APP_HOST's Origin only. It picks a token trading now from the
// helper's Solana 5-minute trending list (pickToken, Origin APP_HOST), then opens the socket for it with each Origin below, by a bare RFC 6455
// handshake over node:https (no WebSocket library, so the Origin header is exactly the one written here):
//   - APP_HOST: the handshake is answered 101 with the RFC 6455 accept key, and within FRAME_WAIT_MS the socket sends
//     a text frame that is the token's tape (JSON with a `trades` array whose rows have t_ms, side and tx), holding a
//     trade whenever the polled route held one for the token: the first frame is the tape as the helper holds it, and
//     the frames after it are its changes, so the check reads frames until one holds a trade or the wait ends;
//   - SIGN_HOST, https://example.com, "*", "null" and no Origin at all: each is answered 403 with no upgrade, no frame
//     and no Access-Control-Allow-Origin.
// After: helper
//   node scripts/live-checks/market-data-push.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const KEY = "market-data-push";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
export const PATH = "/v1/market/push";
/** Every Origin the socket must refuse; null is a handshake with no Origin header. */
export const REFUSED = [SIGN, "https://example.com", "*", "null", null];
/** How long APP_HOST's socket may take to send its first update [design: a cold token's first tape read, bounded]. */
export const FRAME_WAIT_MS = 20_000;
/** The longest first frame read [design: 50 rows of the tape are about 15 KB]. */
export const FRAME_MAX = 1_000_000;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Tokens of the 5-minute list asked for their tape before the socket is opened [design: within the API window]. */
export const PICK_MAX = 10;

/** A token trading now: of the first PICK_MAX of the helper's Solana 5-minute trending list, the first whose tape
 *  (GET /v1/market/trades) holds a trade, else the list's first; every read with Origin APP_HOST. `held`: the trades
 *  that route answered for it, so the socket is held to at least what the polled route serves. */
export async function pickToken(base = BASE, fetchFn = fetch) {
  const get = (path) => fetchFn(`${base}${path}`, { headers: { origin: APP }, signal: AbortSignal.timeout(20_000) });
  const r = await get("/v1/market/lists?chain=solana");
  if (r.status !== 200) throw new Error(`GET /v1/market/lists?chain=solana answered ${r.status}`);
  const rows = (await r.json())?.lists?.trending_5m;
  const tokens = (Array.isArray(rows) ? rows : []).slice(0, PICK_MAX).map((x) => x?.token).filter((t) => typeof t === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t));
  if (tokens.length === 0) throw new Error("the Solana 5-minute list names no token");
  for (const t of tokens) {
    const a = await get(`/v1/market/trades?chain=solana&token=${t}&limit=1`).catch(() => null);
    const n = a?.status === 200 ? (await a.json().catch(() => null))?.trades?.length : 0;
    if (n > 0) return { token: t, held: n };
  }
  return { token: tokens[0], held: 0 };
}

/** One handshake with `origin` (null: none): its status, the headers kept, and on a 101 the first text frame whose tape
 *  holds a trade, else the last one read in `waitMs` (`frames`: how many were read). */
export function handshake(base, token, origin, waitMs = FRAME_WAIT_MS) {
  const url = new URL(`${PATH}?chain=solana&token=${encodeURIComponent(token)}`, base);
  const key = randomBytes(16).toString("base64");
  const headers = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key };
  if (origin !== null) headers.Origin = origin;
  const keep = (h) => Object.fromEntries(["access-control-allow-origin", "sec-websocket-accept", "upgrade", "x-helper-commit"].filter((k) => h[k] !== undefined).map((k) => [k, h[k]]));
  return new Promise((ok, fail) => {
    const req = (url.protocol === "https:" ? https : http).request(url, { headers, timeout: 20_000 });
    req.on("timeout", () => req.destroy(new Error("no answer to the handshake in 20 s")));
    req.on("error", fail);
    req.on("response", (res) => {
      res.resume();
      ok({ origin, status: res.statusCode, headers: keep(res.headers), acceptOk: null, frame: null, frames: 0 });
    });
    req.on("upgrade", (res, socket, head) => {
      const acceptOk = res.headers["sec-websocket-accept"] === createHash("sha1").update(key + GUID).digest("base64");
      let buf = head;
      let last = null;
      let frames = 0;
      const done = (frame) => {
        clearTimeout(timer);
        socket.destroy();
        ok({ origin, status: res.statusCode, headers: keep(res.headers), acceptOk, frame, frames });
      };
      const timer = setTimeout(() => done(last), waitMs);
      const traded = (text) => {
        try {
          return JSON.parse(text)?.trades?.length > 0;
        } catch {
          return true; // not a tape: the judge says so
        }
      };
      const take = () => {
        // server frames are unmasked; control frames (ping, opcode 9) are skipped, the first text frame (opcode 1) kept
        while (buf.length >= 2) {
          let len = buf[1] & 0x7f;
          let at = 2;
          if (len === 126) [len, at] = buf.length < 4 ? [Infinity, 4] : [buf.readUInt16BE(2), 4];
          else if (len === 127) [len, at] = buf.length < 10 ? [Infinity, 10] : [Number(buf.readBigUInt64BE(2)), 10];
          if (len > FRAME_MAX) return done(`<frame of ${len} bytes>`);
          if (buf.length < at + len) return;
          const op = buf[0] & 0x0f;
          const text = buf.subarray(at, at + len).toString("utf8");
          buf = buf.subarray(at + len);
          if (op === 1) {
            frames++;
            last = text;
            if (traded(text)) return done(text);
          }
          if (op === 8) return done(last);
        }
      };
      socket.on("data", (d) => ((buf = Buffer.concat([buf, d])), take()));
      socket.on("error", () => done(last));
      take();
    });
    req.end();
  });
}

export async function read(base = BASE, fetchFn = fetch) {
  const { token, held } = await pickToken(base, fetchFn);
  const app = await handshake(base, token, APP);
  const refused = [];
  for (const o of REFUSED) refused.push(await handshake(base, token, o, 3_000));
  // the token's address is kept as `mint`: public, and a key named token reads as a secret to gitleaks' generic rule
  return { base, mint: token, held, app, refused };
}

const show = (v) => (v === undefined || v === null ? "absent" : JSON.stringify(v));
const ROW = (r) => r !== null && typeof r === "object" && Number.isSafeInteger(r.t_ms) && (r.side === "buy" || r.side === "sell") && typeof r.tx === "string" && r.tx.length > 0;

/** The check on one recorded run. */
export function judge({ held, app, refused }) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(app?.status === 101, `APP_HOST's handshake answered ${show(app?.status)}, 101`);
  say(app?.acceptOk === true, "APP_HOST's 101 carries the RFC 6455 accept key");
  let tape;
  try {
    tape = JSON.parse(app?.frame ?? "");
  } catch {
    tape = undefined;
  }
  const need = Number.isSafeInteger(held) && held > 0 ? 1 : 0;
  say(Array.isArray(tape?.trades) && tape.trades.length >= need && tape.trades.every(ROW), `APP_HOST received an update: ${Array.isArray(tape?.trades) ? `a tape of ${tape.trades.length} trades, frame ${app.frames}` : `no tape (${show(app?.frame === null ? null : String(app?.frame).slice(0, 60))})`}, rows of the shape, at least ${need} (GET /v1/market/trades held ${show(held)})`);
  const origins = new Set((refused ?? []).map((r) => r.origin));
  say(REFUSED.every((o) => origins.has(o)), `every refused Origin was tried (${REFUSED.map(show).join(", ")})`);
  for (const r of refused ?? []) {
    const who = r.origin === null ? "no Origin" : `Origin ${show(r.origin)}`;
    say(r.status === 403 && r.frame === null, `${who}: ${show(r.status)}${r.frame === null ? "" : " and an update"}, 403 and none`);
    say(r.headers?.["access-control-allow-origin"] === undefined, `${who}: Access-Control-Allow-Origin ${show(r.headers?.["access-control-allow-origin"])}`);
  }
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const answer = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, lines } = judge(answer);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${answer.base}, token ${answer.mint})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
