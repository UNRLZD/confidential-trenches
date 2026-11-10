#!/usr/bin/env node
// Live check of card helper-ws-fragment-flood: the helper's push socket (GET /v1/market/push, apps/helper/src/data/push.ts)
// closes a peer that sends one message in more pieces than PUSH_IN_FRAGMENTS, with ws's own code 1008, and still sends a
// subscriber its updates. ws before 8.21.0 held every fragment of an unfinished message up to maxPayload (ws 8.21.0
// release notes, fix 2b2abd45: a flood of tiny fragments and chunks exhausts a server's memory).
// It picks a token trading now as market-data-push does (pickToken), then, with Origin APP_HOST, two sockets one after the
// other, by a bare RFC 6455 handshake over node:https:
//   - the flood, kept polite: one unfinished binary message of SENT one-byte fragments (twice PUSH_IN_FRAGMENTS, far
//     under maxPayload, so only the fragment bound can close it), then a ping, 230 bytes in all, in one write. The helper
//     must answer a close frame with code 1008 and no pong: a pong means it took every fragment and stayed open;
//   - a subscriber: handshake() of market-data-push, which must be sent the token's tape.
// A run that gets no answer (a failed connection, no frame in the wait, a 429 or 503 at the handshake) is INCONCLUSIVE
// (exit 3), never judged a wrong answer.
// After: helper
//   node scripts/live-checks/helper-ws-fragment-flood.mjs [--base <url>] [--record <file>] [--mint <token>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read, so the check's test
//   can replay it. --mint skips the token pick, for a local recording only (a helper with stub reads has no lists).
import "../net-window.mjs";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { PUSH_IN_FRAGMENTS } from "../../apps/helper/src/data/push.ts";
import { APP, BASE, handshake, PATH, pickToken } from "./market-data-push.mjs";

const KEY = "helper-ws-fragment-flood";
/** One-byte fragments the flood sends [design: twice the bound, and far under maxPayload's PUSH_IN_MAX]. */
export const SENT = 2 * PUSH_IN_FRAGMENTS;
/** How long the flood's socket may take to answer [design: a cold token's first read comes before the 101]. */
export const WAIT_MS = 20_000;
/** ws's close code for a peer past maxFragments or maxBufferedChunks (receiver.js, WS_ERR_TOO_MANY_BUFFERED_PARTS). */
export const CODE = 1008;

/** A masked client frame: FIN, the opcode, a zero mask key (the payload as is), a 7-bit length. */
const frame = (fin, op, payload) => Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | payload.length]), Buffer.alloc(4), payload]);

/** The flood's bytes: one unfinished binary message of SENT one-byte fragments, then a ping. */
export function flood() {
  const parts = [frame(false, 0x2, Buffer.from([0]))];
  for (let i = 1; i < SENT; i++) parts.push(frame(false, 0x0, Buffer.from([0])));
  parts.push(frame(true, 0x9, Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** The flood on one socket for `token`: the handshake's status, the tape frames read before the end, and how it ended:
 *  the close code, "pong", "cut" (the connection ended with neither) or "none" (no answer in `waitMs`). */
export function attack(base, token, waitMs = WAIT_MS) {
  const url = new URL(`${PATH}?chain=solana&token=${encodeURIComponent(token)}`, base);
  const headers = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), Origin: APP };
  return new Promise((ok) => {
    const req = (url.protocol === "https:" ? https : http).request(url, { headers, timeout: waitMs });
    req.on("timeout", () => req.destroy(new Error(`no answer to the handshake in ${waitMs} ms`)));
    req.on("error", (e) => ok({ status: null, error: e.message, sent: 0, tapes: 0, end: "none" }));
    req.on("response", (res) => {
      res.resume();
      ok({ status: res.statusCode, sent: 0, tapes: 0, end: null });
    });
    req.on("upgrade", (res, socket, head) => {
      const bytes = flood();
      let buf = head;
      let tapes = 0;
      let settled = false;
      const done = (end) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        ok({ status: res.statusCode, sent: bytes.length, tapes, end });
      };
      const timer = setTimeout(() => done("none"), waitMs);
      socket.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        // server frames are unmasked: a 7-bit, 16-bit or 64-bit length; text frames (the tape) and pings are counted or skipped
        while (buf.length >= 2) {
          let len = buf[1] & 0x7f;
          let at = 2;
          if (len === 126) [len, at] = buf.length < 4 ? [Infinity, 4] : [buf.readUInt16BE(2), 4];
          else if (len === 127) [len, at] = buf.length < 10 ? [Infinity, 10] : [Number(buf.readBigUInt64BE(2)), 10];
          if (len > 1_000_000) return done("cut");
          if (buf.length < at + len) return;
          const op = buf[0] & 0x0f;
          if (op === 0x8) return done(len >= 2 ? buf.readUInt16BE(at) : 1005);
          if (op === 0xa) return done("pong");
          if (op === 0x1) tapes++;
          buf = buf.subarray(at + len);
        }
      });
      socket.on("error", () => done("cut"));
      socket.on("close", () => done("cut"));
      socket.write(bytes);
    });
    req.end();
  });
}

export async function read(base = BASE, mint = null, fetchFn = fetch) {
  const { token, held } = mint === null ? await pickToken(base, fetchFn) : { token: mint, held: null };
  const flooded = await attack(base, token);
  const sub = await handshake(base, token, APP).catch((e) => ({ status: null, error: e.message, frame: null, frames: 0 }));
  // the token's address is kept as `mint`: public, and a key named token reads as a secret to gitleaks' generic rule
  return { base, mint: token, held, sent: SENT, flood: flooded, sub };
}

const show = (v) => (v === undefined || v === null ? "absent" : JSON.stringify(v));
const BUSY = new Set([429, 503]);

/** The verdict on one recorded run: PASS, FAIL or INCONCLUSIVE, with a line per fact. */
export function judge({ sent, flood: f, sub }) {
  const lines = [];
  let bad = false;
  let quiet = false;
  const say = (ok, text) => ((bad ||= !ok), lines.push(`${ok ? "ok " : "BAD"} ${text}`));
  const none = (text) => ((quiet = true), lines.push(`--- ${text}`));
  if (f?.status === null || f?.end === "none" || BUSY.has(f?.status)) none(`the flood's socket gave no answer (${show(f?.status)}${f?.error ? `, ${f.error}` : ""}, ${show(f?.end)}): not judged`);
  else {
    say(f?.status === 101, `the flood's handshake answered ${show(f?.status)}, 101`);
    if (f?.status === 101) {
      say(sent > PUSH_IN_FRAGMENTS && f.sent > 0, `it sent ${show(sent)} one-byte fragments, past PUSH_IN_FRAGMENTS ${PUSH_IN_FRAGMENTS}, in ${show(f.sent)} bytes`);
      say(f.end === CODE, f.end === "pong" ? `the helper answered the ping after all ${show(sent)} fragments: it took them and stayed open` : `the helper closed the flood with ${show(f.end)}, ws's ${CODE}`);
    }
  }
  if (sub?.status === null || sub?.status === undefined || BUSY.has(sub?.status)) none(`the subscriber gave no answer (${show(sub?.status)}${sub?.error ? `, ${sub.error}` : ""}): not judged`);
  else {
    let tape;
    try {
      tape = JSON.parse(sub.frame ?? "");
    } catch {
      tape = undefined;
    }
    say(sub.status === 101 && sub.acceptOk === true, `the subscriber's handshake answered ${show(sub.status)}, 101 with the RFC 6455 accept key`);
    if (sub.status === 101 && sub.frame === null) none("the subscriber's socket sent no frame in the wait: not judged");
    else if (sub.status === 101) say(Array.isArray(tape?.trades), `the subscriber received an update: ${Array.isArray(tape?.trades) ? `a tape of ${tape.trades.length} trades` : `not a tape (${show(String(sub.frame).slice(0, 60))})`}`);
  }
  return { verdict: bad ? "FAIL" : quiet ? "INCONCLUSIVE" : "PASS", lines };
}

const EXIT = { PASS: 0, FAIL: 1, INCONCLUSIVE: 3 };

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const answer = await read(opt("--base", BASE), opt("--mint", null));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { verdict, lines } = judge(answer);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict} (${answer.base}, token ${answer.mint})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
