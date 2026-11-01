// The return record of the same-tab hop to SIGN_HOST (app.md §2.1 item 5, A1.3 at app.md:1441; APU-01, app.md:1331).
// The five open kinds (the kit's OPEN_KINDS) run on SIGN_HOST's own top-level page: the app writes this record, posts
// the kind with its return key, and moves the same tab to SIGN_HOST with nothing in the URL. When the flow ends,
// SIGN_HOST sends the tab to the return path of that key (RETURN_KEYS, returnPath); the app reads the record once,
// deletes it, and draws the screen the user left: the route, the open sheet, its field values, the scroll and the
// tapped control (locked until the signing page answers again). The browser's Back from SIGN_HOST lands on the route
// itself, which restores the same way.
//
// Where it lives: sessionStorage, under HOP_RECORD. It is per tab, so a second tab of the app never reads or deletes
// another tab's hop (dead-end row 14, app.md:1203); it survives the same-tab round trip and a reload, which is all a
// hop needs; and it goes when the tab closes, so no record outlives the visit. It holds no secret and no money value
// beyond what the screen already shows: a route id, a sheet id, a control id, the screen's own non-secret field values
// (the screen passes them) and a scroll offset, with the time it was made.
//
// Every bad case lands on the default route (Discover, dead-end row 8, app.md:1197), never a half-filled control: no
// record, a garbled one, one older than HOP_TTL_MS, one for another kind's return, a return path edited by hand (any
// query, fragment or other path). The only navigation target this file ever yields is a path of the app's own route
// table (routes.ts), never a value read from storage or the URL.
import { SIGNPAGE_CLIENT_CODES } from "@blindfill/kit";
import type { OPEN_KINDS } from "@blindfill/kit";
import { ROUTES } from "../routes/routes.ts";
import type { RouteId } from "../routes/routes.ts";

export type OpenKind = (typeof OPEN_KINDS)[number];

/**
 * The return key of each open kind, the one extra field the kind carries (messages.ts `Open`). SIGN_HOST maps each to
 * the APP_HOST URL returnPath(key) from its release's fixed list; the app checks the key it lands on against the
 * record's kind, so a return for another kind restores nothing.
 */
export const RETURN_KEYS = {
  "signin.open": "signin",
  "backup.open": "backup",
  "export.open": "export",
  signout: "signout",
  "withdraw.open": "withdraw",
} as const satisfies Record<OpenKind, string>;

export const RETURN_PREFIX = "/return/";
export const returnPath = (key: string) => `${RETURN_PREFIX}${key}`;

/**
 * Why a hop did not leave for SIGN_HOST: "refused", the page's rule allows no such open (not_allowed), which a retry
 * cannot change; "silent", no answer within the kit's window for the kind (client_timeout) or no signing page to ask
 * (signpage_down), which a retry can mend once the page is READY again; "error", any other code (a store error), which
 * a retry can mend.
 */
export type HopWhy = "refused" | "error" | "silent";

export function hopWhy(code: string): HopWhy {
  if (code === "not_allowed") return "refused";
  if (code === SIGNPAGE_CLIENT_CODES.timeout || code === SIGNPAGE_CLIENT_CODES.down) return "silent";
  return "error";
}

/** The sessionStorage key of the one record. */
export const HOP_RECORD = "ct.return-hop";
/** A record older than this is ignored (SIGN_HOST's pending-flow record lasts as long, app.md §2.1 item 5 step 2). */
export const HOP_TTL_MS = 5 * 60_000;
/** Where every bad return lands. */
export const DEFAULT_ROUTE: RouteId = "discover";
export const DEFAULT_PATH = pathOf(DEFAULT_ROUTE);

/** The screen the user left. */
export interface HopView {
  route: RouteId;
  /** The open sheet's id, or null. */
  sheet: string | null;
  /** The tapped control's id: locked from the tap until the signing page answers again after the return. */
  control: string;
  /** The sheet's non-secret field values, as the screen shows them. */
  fields: Record<string, string>;
  /** window.scrollY when the control was tapped. */
  scroll: number;
}

export interface HopRecord extends HopView {
  v: 1;
  kind: OpenKind;
  return_key: string;
  /** Date.now() when written. */
  at: number;
}

export interface Landing {
  /** The route path to replace the URL with before the first render; null: stay on the URL loaded. */
  to: string | null;
  /** The screen to restore, or null. */
  view: HopView | null;
}

const ID = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_FIELDS = 16;
const MAX_VALUE = 256;
const MAX_RAW = 8_192;
const MAX_SCROLL = 10_000_000;
const KEYS = ["v", "kind", "return_key", "route", "sheet", "control", "fields", "scroll", "at"];

/** The path of a route of the app's table. */
export function pathOf(route: RouteId): string {
  return ROUTES.find((r) => r.id === route)!.path;
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const isKind = (v: unknown): v is OpenKind => typeof v === "string" && Object.hasOwn(RETURN_KEYS, v);

export function makeRecord(kind: OpenKind, view: HopView, at: number): HopRecord {
  return {
    v: 1,
    kind,
    return_key: RETURN_KEYS[kind],
    route: view.route,
    sheet: view.sheet,
    control: view.control,
    fields: { ...view.fields },
    scroll: view.scroll,
    at,
  };
}

/** The record if `raw` is exactly its shape and made within HOP_TTL_MS before `now`; null for anything else. */
export function parseRecord(raw: unknown, now: number): HopRecord | null {
  if (typeof raw !== "string" || raw.length > MAX_RAW) return null;
  let r: unknown;
  try {
    r = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlain(r)) return null;
  const keys = Object.keys(r);
  if (keys.length !== KEYS.length || !KEYS.every((k) => Object.hasOwn(r, k))) return null;
  if (r.v !== 1 || !isKind(r.kind) || r.return_key !== RETURN_KEYS[r.kind]) return null;
  const route = ROUTES.find((x) => x.id === r.route);
  if (!route) return null;
  if (!(r.sheet === null || (typeof r.sheet === "string" && ID.test(r.sheet)))) return null;
  if (typeof r.control !== "string" || !ID.test(r.control)) return null;
  const f = r.fields;
  if (!isPlain(f)) return null;
  const fk = Object.keys(f);
  if (fk.length > MAX_FIELDS || !fk.every((k) => ID.test(k) && typeof f[k] === "string" && (f[k] as string).length <= MAX_VALUE)) return null;
  if (typeof r.scroll !== "number" || !Number.isFinite(r.scroll) || r.scroll < 0 || r.scroll > MAX_SCROLL) return null;
  if (typeof r.at !== "number" || !Number.isFinite(r.at) || r.at > now || now - r.at > HOP_TTL_MS) return null;
  return {
    v: 1,
    kind: r.kind,
    return_key: RETURN_KEYS[r.kind],
    route: route.id,
    sheet: r.sheet as string | null,
    control: r.control,
    fields: Object.fromEntries(fk.map((k) => [k, f[k] as string])),
    scroll: r.scroll,
    at: r.at,
  };
}

/** Writes the one record, replacing any earlier one. */
export function writeRecord(store: Pick<Storage, "setItem">, rec: HopRecord): void {
  store.setItem(HOP_RECORD, JSON.stringify(rec));
}

/** Reads the record once and deletes it; null when there is none, it is bad, or the storage throws. */
export function takeRecord(store: Pick<Storage, "getItem" | "removeItem">, now: number): HopRecord | null {
  let raw: string | null = null;
  try {
    raw = store.getItem(HOP_RECORD);
    store.removeItem(HOP_RECORD);
  } catch {
    return null;
  }
  return parseRecord(raw, now);
}

const viewOf = (r: HopRecord): HopView => ({ route: r.route, sheet: r.sheet, control: r.control, fields: { ...r.fields }, scroll: r.scroll });

/**
 * Where a load goes and what it restores. A return path lands on the record's route when the record is for that key,
 * else on the default route; a load at the route the record left (Back from SIGN_HOST) restores it in place; any other
 * load stays where it is and restores nothing.
 */
export function land(url: { pathname: string; search: string; hash: string }, rec: HopRecord | null): Landing {
  const { pathname } = url;
  if (pathname === "/return" || pathname.startsWith(RETURN_PREFIX)) {
    const key = pathname.slice(RETURN_PREFIX.length);
    if (rec && url.search === "" && url.hash === "" && key === rec.return_key) return { to: pathOf(rec.route), view: viewOf(rec) };
    return { to: DEFAULT_PATH, view: null };
  }
  if (rec && pathname === pathOf(rec.route)) return { to: null, view: viewOf(rec) };
  return { to: null, view: null };
}
