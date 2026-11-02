// The terminal runs only inside SIGN_HOST's shell: SIGN_HOST is the top window and frames APP_HOST, so the wallet's
// store is first-party on every engine (WebKit keys a framed page's storage by the top window's origin). A top-level
// visit to APP_HOST moves to SIGN_HOST with the same path and query before anything draws; the shell frames APP_HOST
// at that path. APP_HOST's frame-ancestors names SIGN_HOST only, so a framed terminal's parent is SIGN_HOST's shell.
// Framed, the app tells the shell its path and query on every move (the kit's nav), and the shell keeps them in the top
// window's address, so the address bar, a reload and a shared link follow the app.

import type { SignpageClient, SignpageOutcome } from "@blindfill/kit";

/** The shell's URL for a visit to APP_HOST at `loc`: SIGN_HOST's origin with the same path and query. */
export function shellUrl(signOrigin: string, loc: Pick<Location, "pathname" | "search">): string {
  return `${signOrigin}${loc.pathname}${loc.search}`;
}

/** True when the page is not framed. */
export const isTopLevel = (w: Pick<Window, "self" | "top">): boolean => w.top === w.self;

/**
 * Moves a top-level visit to the shell, replacing this entry in the history (Back does not return to a page that only
 * moves on). True when it moved: the caller draws nothing.
 */
export function moveToShell(w: Pick<Window, "self" | "top" | "location">, signOrigin: string): boolean {
  if (!isTopLevel(w)) return false;
  w.location.replace(shellUrl(signOrigin, w.location));
  return true;
}

/** The app's path and query: what the shell keeps in the top window's address. */
export const appPath = (loc: Pick<Location, "pathname" | "search">): string => `${loc.pathname}${loc.search}`;

/** Tells the shell where the app is now (nav). Not READY: the client answers signpage_down and posts nothing. */
export function tellShell(client: Pick<SignpageClient, "request">, loc: Pick<Location, "pathname" | "search">): Promise<SignpageOutcome<"nav">> {
  return client.request("nav", { path: appPath(loc) }).outcome;
}

/**
 * The update state's Reload: the shell reloads the top window, the shell and the app in it (a reload of this frame
 * alone would keep the old shell). When the shell does not, the frame alone reloads.
 */
export async function reloadAll(client: Pick<SignpageClient, "request">, loc: Pick<Location, "reload">): Promise<void> {
  const o = await client.request("reload", {}).outcome;
  if (!o.ok) loc.reload();
}
