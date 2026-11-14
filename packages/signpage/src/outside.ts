// An outside app on SIGN_HOST (card signpage-answers-outside-apps): any app built on @blindfill/kit makes a private buy
// through this page the way the terminal does, by the web-wallet popup pattern (the kit's popup mode).
//
// - The app opens SIGN_HOST's /connect in a popup from the user's own tap (window.open). This page there frames nothing:
//   the app stays at its own address, and this address shows only this page's own screens (connect, Confirm). The
//   /connect path alone answers with Cross-Origin-Opener-Policy unsafe-none (packages/signpage/public/_headers), so the
//   popup keeps its opener; frame-ancestors 'none' holds there as on every path.
// - The one peer is window.opener (src/shell.ts popup). The origin shown is the one the browser checked on the opener's
//   message (e.origin), never a name or field the app sends. It must pass outsideOrigin: https, or http on localhost and
//   127.0.0.1 for a developer's own build; never SIGN_HOST's own origin, never an opaque one.
// - Before the user's Allow on the connect sheet nothing is answered: no state, balance, position or address. Allow binds
//   the session to that exact origin, posted to with that targetOrigin only. Nothing is remembered: a new popup asks again.
// - Connect and every Confirm stay in this one document: no nav, no reload, no other route (a route serving COOP
//   same-origin would cut the opener).
// - The app may ask only OUTSIDE_KINDS: the state, sign-in, the deposit kinds, withdraw.open with the app's given, and
//   the pool buy and sell with their previews (an app asks, the user confirms: the wallet standard). Each buy and sell
//   waits for the user's Confirm on a sheet naming the origin and what it does (outsideKinds); Cancel refuses it
//   not_allowed. The deposit kinds sign nothing for the app: the quote hands back a deposit address funded from outside,
//   and what lands there goes only into this account's own vault. withdraw.open is taken only as the app's given (`to`
//   with `amount` or `max`, no `from_id`: outsideWithdraw), drawn as the page's own withdraw Confirm (src/withdraw/form.ts
//   given) under the origin: the address whole, the amount checked, a max resolved to its amount before Confirm is
//   offered. The typed form and a held deposit's way out stay refused. Every other kind (moves, orders, the words,
//   sign-out, nav, reload) is refused.
// - APP_HOST's path (every path but /connect) is not changed by any of this.
import type { SignpageKind } from "../../kit/src/signpage/messages.ts";
import type { ApiHost, HostAnswer, HostRefusal, Running } from "./api.ts";

/** The one path where SIGN_HOST answers an outside app, as the popup it opened. */
export const CONNECT_PATH = "/connect";

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

/** True when `origin` (a MessageEvent's, as the browser gives it) may be shown on the connect sheet and allowed. */
export function outsideOrigin(origin: string, self: string): boolean {
  if (typeof origin !== "string" || origin === "null" || origin === self) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  // an origin and nothing else: the browser's serialization, no path, credentials, query or fragment
  if (u.origin !== origin) return false;
  return u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname));
}

/** The kinds an outside app may ask, answered as for APP_HOST once allowed (state and hello are the API's own). */
export const OUTSIDE_KINDS: readonly SignpageKind[] = Object.freeze([
  "signin.open",
  "deposit.assets",
  "deposit.dry",
  "deposit.quote",
  "deposit.confirm",
  "withdraw.open",
  "pool.buy.dry",
  "pool.sell.dry",
  "pool.buy",
  "pool.sell",
] as const);
/** Of those, the ones that spend: each waits for the user's Confirm. */
export const CONFIRMED_KINDS = Object.freeze(["pool.buy", "pool.sell"] as const);
export type ConfirmedKind = (typeof CONFIRMED_KINDS)[number];

type Kinds = NonNullable<ApiHost["kinds"]>;

/**
 * withdraw.open from an outside app (params as the kit's schema passed them): only the app's given, `to` with `amount` or
 * `max`, and never `from_id`. The page draws it as its own withdraw Confirm, so the user reads where it goes and how much
 * before anything is signed; anything else is refused.
 */
export function outsideWithdraw(p: Record<string, unknown>): boolean {
  if (Object.hasOwn(p, "from_id") || typeof p.to !== "string" || p.to === "") return false;
  return typeof p.amount === "string" || p.max === true;
}
type Answer = HostAnswer<SignpageKind> | HostRefusal | null;

/**
 * `kinds` cut to OUTSIDE_KINDS, each kind of CONFIRMED_KINDS run only after `confirm` says yes for that request (its
 * kind, params and id): a no is not_allowed, and the kind's own answer follows a yes as it would come for APP_HOST.
 */
export function outsideKinds(kinds: Kinds, confirm: (kind: ConfirmedKind, params: Record<string, unknown>, id: string) => Promise<boolean>): Kinds {
  const out: Record<string, unknown> = {};
  for (const k of OUTSIDE_KINDS) {
    const run = Object.hasOwn(kinds, k) ? (kinds[k] as Kinds[SignpageKind]) : undefined;
    if (!run) continue;
    if (k === "withdraw.open") {
      out[k] = (params: Record<string, unknown>, ctx: Parameters<NonNullable<Kinds[SignpageKind]>>[1]) => (outsideWithdraw(params) ? (run as (p: Record<string, unknown>, c: typeof ctx) => unknown)(params, ctx) : null);
      continue;
    }
    if (!(CONFIRMED_KINDS as readonly string[]).includes(k)) {
      out[k] = run;
      continue;
    }
    out[k] = (params: Record<string, unknown>, ctx: Parameters<NonNullable<Kinds[SignpageKind]>>[1]): Running<SignpageKind> => {
      let end: Answer = { error: "not_allowed" };
      const after = (async () => {
        if (!(await confirm(k as ConfirmedKind, params, ctx.id).catch(() => false))) return;
        const got = (run as (p: Record<string, unknown>, c: typeof ctx) => Answer | Running<SignpageKind> | { after: Promise<unknown>; answer(): Answer })(params, ctx);
        if (got !== null && "after" in got) {
          await got.after.catch(() => {});
          end = got.answer();
        } else end = got;
      })();
      return { running: true, after, answer: () => end };
    };
  }
  return out as Kinds;
}

/** A Confirm's title for a request's kind. */
export const CONFIRM_TITLE: Readonly<Record<ConfirmedKind, string>> = Object.freeze({ "pool.buy": "Buy", "pool.sell": "Sell" });

/** The lines a Confirm shows for a request (params as the kit's schema passed them), under the app's origin: label, value. */
export function confirmLines(p: Record<string, unknown>, asset: (chain: string) => string): [string, string][] {
  const chain = String(p.chain);
  const lines: [string, string][] = [["Chain", chain], ["Token", String(p.token)]];
  if (typeof p.amount === "string") lines.push(["Amount", `${p.amount} ${asset(chain)}`.trim()]);
  if (typeof p.share_bps === "number") lines.push(["Share", `${p.share_bps / 100}%`]);
  lines.push(["Slippage", `${Number(p.slippage_bps) / 100}%`]);
  return lines;
}
