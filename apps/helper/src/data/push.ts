/**
 * The live push channel (card market-data-push; markets paper D1 D-S9 "push", 7.1 row "every path, and the push
 * socket", H7 "Cross-origin reads"): GET /v1/market/push?chain=<chain>&token=<token>, upgraded to a WebSocket (RFC
 * 6455, the `ws` library), sends the token's trade tape, the GET /v1/market/trades body at its longest, first as it is
 * and then each time it changes. The tape is read from the same in-memory reads that route answers from
 * (data/solana/trades.ts, data/evm/swaps.ts), once a tick per token however many sockets watch it, so a socket costs
 * no upstream call the polled route would not.
 *
 * Who is upgraded: only a request whose Origin the server's one Origin check passes for the push origins (server.ts
 * originIn with PUSH_ORIGINS, APP_HOST alone). Any other, SIGN_HOST, a foreign one, "*", "null" and none at all, is
 * answered 403 before the handshake and makes the helper read nothing. A browser always sends Origin on a WebSocket
 * handshake (https://fetch.spec.whatwg.org/ "WebSocket", RFC 6455 4.1 item 8), so this is the gate a page on another
 * site meets; a client that is not a browser can write any header, so the data stays display only (D1: nothing pushed
 * is a signed value).
 *
 * Every input is hostile and bounded: the query is exactly one chain the helper reads and exactly one token the reads
 * know (their first answer is not a 404), a client holds at most PUSH_CLIENT_MAX sockets and opens at most its API
 * window's, the helper at most PUSH_MAX, a socket's own messages are ignored and capped at PUSH_IN_MAX bytes, in at
 * most PUSH_IN_FRAGMENTS pieces and PUSH_IN_CHUNKS reads held at once (else ws closes it 1008), one that cannot take its
 * frames (PUSH_BUFFER_MAX unsent) or answer a ping within PUSH_PING_MS is cut.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { DataAnswer } from "./solana/token.ts";

export const PUSH_PATH = "/v1/market/push";
/** How often each watched token's tape is read for a change [design: under D-S9's p50 0.95 s from the block]. */
export const PUSH_TICK_MS = 500;
/** Sockets the helper holds at once [design: a page opens one; 2,000 pages at once is far above the beta's load]. */
export const PUSH_MAX = 2_000;
/** Sockets one client holds at once [design: a few tabs of the terminal behind one address]. */
export const PUSH_CLIENT_MAX = 8;
/** Bytes a socket may leave unsent before it is cut [design: about 50 full tapes; a reader that slow is gone]. */
export const PUSH_BUFFER_MAX = 1_000_000;
/** The largest message the helper takes from a socket, which it then ignores [design: it reads none]. */
export const PUSH_IN_MAX = 1_024;
/** The frames one message may come in, past which ws closes the socket 1008 (ws 8.21.0 maxFragments, fix 2b2abd45: each
 *  held fragment costs the helper about 170 bytes for 7 sent) [design: the helper reads no message and a browser sends
 *  each as one frame; RFC 6455 5.4 lets a client split one, and 16 is far above any client's split of 1 KiB]. */
export const PUSH_IN_FRAGMENTS = 16;
/** The reads of a socket ws holds before they make a whole frame, past which it closes the socket 1008 (ws 8.21.0
 *  maxBufferedChunks: each held read of 1 byte costs the helper about 240 bytes) [design: a frame the helper takes is at
 *  most PUSH_IN_MAX + 14 bytes, two TCP segments at the 536-byte minimum (RFC 9293 3.7.1); 64 is far above that]. */
export const PUSH_IN_CHUNKS = 64;
/** The ping every socket answers within, else it is cut [design: under Caddy's and Cloudflare's idle cuts]. */
export const PUSH_PING_MS = 30_000;
/** The tape's length a socket is sent: the trades route's longest (data/solana/trades.ts TRADES_MAX). */
export const PUSH_TRADES = 50;

type Reader = { trades(token: string, limit: number): Promise<DataAnswer> };
export type PushDeps = {
  commit: string;
  /** The tape readers by chain: the server's swap reads. */
  readers: Readonly<Partial<Record<string, Reader>>>;
  /** Whether the request's Origin may be pushed to: the server's one Origin check (server.ts originIn). */
  allowed(req: IncomingMessage): boolean;
  /** The client's address, never logged (limits.ts clientOf). */
  client(req: IncomingMessage): string;
  /** The client's window: 0 to go on, else the seconds to wait (limits.ts clientWindow take). */
  take(client: string): number;
  tickMs?: number;
  pingMs?: number;
};
export type Push = { close(): void; size(): number };

type Group = { chain: string; token: string; sockets: Set<WebSocket>; rows: string | null; body: string | null; reading: boolean };

const attached = new WeakMap<Server, Push>();

/** Ends every push socket of `server` (1001, going away) at a stop, so its drain does not wait on them. */
export function closePush(server: Server): void {
  attached.get(server)?.close();
}

/** A refusal written on the raw socket before any handshake: the status, X-Helper-Commit and Vary: Origin, no body. */
function refuse(socket: Duplex, commit: string, status: number, reason: string, extra = ""): void {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\nVary: Origin\r\nX-Helper-Commit: ${commit}\r\n${extra}\r\n`);
  socket.destroy();
}

/** The tape's rows as one string, so a change is seen whatever else the answer carries (its as_of_ms moves each read). */
function rowsOf(body: string): string | null {
  try {
    const t = (JSON.parse(body) as { trades?: unknown }).trades;
    return Array.isArray(t) ? JSON.stringify(t) : null;
  } catch {
    return null;
  }
}

export function attachPush(server: Server, deps: PushDeps): Push {
  const wss = new WebSocketServer({ noServer: true, maxPayload: PUSH_IN_MAX, maxFragments: PUSH_IN_FRAGMENTS, maxBufferedChunks: PUSH_IN_CHUNKS, perMessageDeflate: false, clientTracking: true });
  const groups = new Map<string, Group>();
  const perClient = new Map<string, number>();
  const alive = new WeakSet<WebSocket>();
  let pending = 0;

  const send = (ws: WebSocket, body: string) => {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > PUSH_BUFFER_MAX) return void ws.terminate();
    ws.send(body);
  };
  /** A read's answer: kept, and sent to every socket of the group, when it is a tape whose rows changed. */
  const apply = (g: Group, a: DataAnswer | null): void => {
    if (a === null || a.status !== 200) return;
    const rows = rowsOf(a.body);
    if (rows === null || rows === g.rows) return;
    g.rows = rows;
    g.body = a.body;
    for (const ws of g.sockets) send(ws, a.body);
  };
  const read = (g: Group): void => {
    const reader = deps.readers[g.chain];
    if (reader === undefined || g.reading) return;
    g.reading = true;
    void reader
      .trades(g.token, PUSH_TRADES)
      .catch(() => null)
      .then((a) => apply(g, a))
      .finally(() => (g.reading = false));
  };
  const tick = setInterval(() => {
    for (const g of groups.values()) read(g);
  }, deps.tickMs ?? PUSH_TICK_MS);
  tick.unref();
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, deps.pingMs ?? PUSH_PING_MS);
  ping.unref();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on("error", () => socket.destroy());
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://helper.invalid");
    } catch {
      return refuse(socket, deps.commit, 400, "Bad Request");
    }
    if (url.pathname !== PUSH_PATH || req.method !== "GET" || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") return refuse(socket, deps.commit, 404, "Not Found");
    // the Origin first: a refused one is answered before anything else is looked at or read
    if (!deps.allowed(req)) return refuse(socket, deps.commit, 403, "Forbidden");
    const client = deps.client(req);
    const wait = deps.take(client);
    if (wait > 0) return refuse(socket, deps.commit, 429, "Too Many Requests", `Retry-After: ${wait}\r\n`);
    if (wss.clients.size + pending >= PUSH_MAX || (perClient.get(client) ?? 0) >= PUSH_CLIENT_MAX) return refuse(socket, deps.commit, 503, "Service Unavailable", "Retry-After: 2\r\n");
    const chains = url.searchParams.getAll("chain");
    const tokens = url.searchParams.getAll("token");
    if (chains.length !== 1 || tokens.length !== 1 || !Object.hasOwn(deps.readers, chains[0]!) || tokens[0]!.length === 0 || tokens[0]!.length > 128) return refuse(socket, deps.commit, 404, "Not Found");
    const chain = chains[0]!;
    const token = tokens[0]!;
    const key = `${chain}\n${token}`;
    perClient.set(client, (perClient.get(client) ?? 0) + 1);
    pending++;
    const release = () => {
      const n = (perClient.get(client) ?? 1) - 1;
      if (n <= 0) perClient.delete(client);
      else perClient.set(client, n);
    };
    // the token's first read decides: one the reads do not know (404) is not upgraded; any other is, and is sent the
    // tape at once when one is held, else as soon as a read answers one. A token already watched needs no first read.
    const held = groups.get(key);
    const first = held !== undefined && held.body !== null ? Promise.resolve(null) : deps.readers[chain]!.trades(token, PUSH_TRADES).catch(() => null);
    void first.then((a) => {
      pending--;
      if (a !== null && a.status === 404) return (release(), refuse(socket, deps.commit, 404, "Not Found"));
      if (socket.destroyed) return release();
      wss.handleUpgrade(req, socket, head, (ws) => {
        const g: Group = groups.get(key) ?? { chain, token, sockets: new Set(), rows: null, body: null, reading: false };
        groups.set(key, g);
        g.sockets.add(ws);
        alive.add(ws);
        ws.on("pong", () => alive.add(ws));
        ws.on("message", () => undefined); // a socket's own messages are not read
        // ws closes a socket on its own error itself: its close frame with the error's code (1008 past PUSH_IN_FRAGMENTS or
        // PUSH_IN_CHUNKS, 1009 past PUSH_IN_MAX), then FIN, the peer's further bytes dropped unread, cut at its closeTimeout.
        // Cutting it here instead resets a peer still sending, and the reset can lose that close frame.
        ws.on("error", () => undefined);
        ws.on("close", () => {
          release();
          g.sockets.delete(ws);
          if (g.sockets.size === 0 && groups.get(key) === g) groups.delete(key);
        });
        if (g.body !== null) send(ws, g.body);
        apply(g, a);
      });
    });
  };
  server.on("upgrade", onUpgrade);

  const push: Push = {
    close() {
      clearInterval(tick);
      clearInterval(ping);
      server.off("upgrade", onUpgrade);
      for (const ws of wss.clients) ws.close(1001, "going away");
      // a socket that does not finish the closing handshake is cut so the drain does not wait on it
      setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
      }, 1_000).unref();
    },
    size: () => wss.clients.size,
  };
  attached.set(server, push);
  server.once("close", () => (clearInterval(tick), clearInterval(ping)));
  return push;
}
