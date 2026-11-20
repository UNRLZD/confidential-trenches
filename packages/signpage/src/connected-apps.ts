// The apps the user connected, listed on SIGN_HOST's /connect (card signpage-other-apps-connect): every origin kept in
// the approvals store (src/connections.ts, which lists bare origins only), each shown as it is with a Disconnect.
// Disconnect removes that origin's approval, and the row goes only once the remove's write has completed, so the list
// never drops an app the store still approves; a remove that fails keeps the row and says so in one line
// (DISCONNECT_FAILED). The session of the origin removed ends with it: src/api.ts reads the store before each request
// and each state push, so its next request is refused not_allowed with no wallet read and no state event follows
// (src/main.ts also clears what the page shows for it, through `removed`). With no origin kept the list draws nothing.
// DOM by createElement and textContent only, through the page's own factories (src/main.ts: its guarded button).
import type { Connections } from "./connections.ts";

export const CONNECTED_APPS_TITLE = "Connected apps";
export const DISCONNECT_LABEL = "Disconnect";
/** The one line a failed remove shows on its row. */
export const DISCONNECT_FAILED = "Disconnect failed";

export interface ConnectedAppsDeps {
  doc: Pick<Document, "createElement">;
  store: Pick<Connections, "list" | "remove">;
  /** An element holding `text` (src/main.ts outsideText). */
  text(tag: string, text: string): HTMLElement;
  /** The origin's line, drawn as the connect sheet draws it (src/main.ts originLine). */
  origin(text: string): HTMLElement;
  /** A button (src/main.ts button, guarded against a lined-up click). */
  button(action: string, label: string, onClick: () => void): HTMLElement;
  /** Called once an origin's approval is removed. */
  removed?(origin: string): void;
}

/** Draws the list into `el`; refresh() reads the store and draws it again (nothing when the read fails). */
export function connectedApps(el: HTMLElement, deps: ConnectedAppsDeps): { refresh(): Promise<void> } {
  // the rows the last draw holds; the title goes with the last one
  let rows = new Set<HTMLElement>();
  const row = (o: string): HTMLElement => {
    const r = deps.doc.createElement("div");
    r.dataset.origin = o;
    let busy = false;
    let failed: HTMLElement | null = null;
    const b = deps.button("disconnect", DISCONNECT_LABEL, () => {
      if (busy) return;
      busy = true;
      deps.store.remove(o).then(
        () => {
          r.remove();
          if (rows.delete(r) && rows.size === 0) el.replaceChildren();
          deps.removed?.(o);
        },
        () => {
          busy = false;
          if (failed === null) r.append((failed = deps.text("p", DISCONNECT_FAILED)));
        },
      );
    });
    r.append(deps.origin(o), b);
    return r;
  };
  return {
    async refresh() {
      let origins: string[];
      try {
        origins = await deps.store.list();
      } catch {
        origins = [];
      }
      rows = new Set(origins.map(row));
      el.replaceChildren(...(rows.size ? [deps.text("p", CONNECTED_APPS_TITLE), ...rows] : []));
    },
  };
}
