// The open kinds (the kit's OPEN_KINDS): sign-in, backup, export, sign-out and withdraw run on SIGN_HOST's own screens.
// The terminal runs framed inside SIGN_HOST's shell, so an open kind's ok means the shell has drawn its screen over the
// app in place; nothing navigates and no record is kept, and the outcome arrives through the signing page's state
// events. This file holds the return key each kind still carries and why an open did not happen.
import { SIGNPAGE_CLIENT_CODES } from "@blindfill/kit";
import type { OPEN_KINDS } from "@blindfill/kit";
import type { RouteId } from "../routes/routes.ts";

export type OpenKind = (typeof OPEN_KINDS)[number];

/**
 * The return key of each open kind, the one extra field the kind carries (messages.ts `Open`; the kit's schema
 * requires it). The shell opens its screen in place and sends the tab nowhere, so the key names the kind and no URL.
 */
export const RETURN_KEYS = {
  "signin.open": "signin",
  "backup.open": "backup",
  "export.open": "export",
  signout: "signout",
  "withdraw.open": "withdraw",
} as const satisfies Record<OpenKind, string>;

/**
 * Why an open did not happen: "refused", the page's rule allows no such open (not_allowed), which a retry cannot
 * change; "silent", no answer within the kit's window for the kind (client_timeout) or no signing page to ask
 * (signpage_down), which a retry can mend once the page is READY again; "error", any other code (a store error), which
 * a retry can mend.
 */
export type HopWhy = "refused" | "error" | "silent";

export function hopWhy(code: string): HopWhy {
  if (code === "not_allowed") return "refused";
  if (code === SIGNPAGE_CLIENT_CODES.timeout || code === SIGNPAGE_CLIENT_CODES.down) return "silent";
  return "error";
}

/** The screen a control was tapped on. */
export interface HopView {
  route: RouteId;
  /** The open sheet's id, or null. */
  sheet: string | null;
  /** The tapped control's id: locked from the tap until the signing page answers. */
  control: string;
  /** The sheet's non-secret field values, as the screen shows them. */
  fields: Record<string, string>;
}
