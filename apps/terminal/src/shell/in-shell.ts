// The terminal runs only inside SIGN_HOST's shell: SIGN_HOST is the top window and frames APP_HOST, so the wallet's
// store is first-party on every engine (WebKit keys a framed page's storage by the top window's origin). A top-level
// visit to APP_HOST moves to SIGN_HOST with the same path and query before anything draws; the shell frames APP_HOST
// at that path. APP_HOST's frame-ancestors names SIGN_HOST only, so a framed terminal's parent is SIGN_HOST's shell.

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
