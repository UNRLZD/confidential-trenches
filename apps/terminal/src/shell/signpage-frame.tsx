import { createSignpageClient } from "@blindfill/kit";
import type { SignpageClient, SignpageClientSnapshot } from "@blindfill/kit";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./signpage-frame.css";

// The terminal's one hidden iframe of SIGN_HOST (app.md §2.1 items 2-4; A1.2, app.md:1435), through the kit's client.
// Every screen reads the client and its state from useSignpage(); money controls are on only while moneyOn is true.
// The down state is a fixed toast, so it moves nothing on the page (BAR-04), and its Retry makes a fresh iframe. A
// signing page whose message API this build does not speak is the update state (CH-146): money off until a reload.
// <html data-signpage="connecting|ready|down|update"> names the state for the browser tests and the live check.

/** SIGN_HOST's release URL: the iframe's src, exactly (AX-06). */
export const SIGN_HOST_URL = "https://sign.confidential.unrealized.trade/";

// Draft words for the owner (the live UNRLZD terminal's signerDown and retry lines, auth/copy.ts:190-191).
const DOWN = "Couldn't load. Your funds are safe.";
const RETRY = "Retry";
// Draft words for the owner: CH-146's update state (app.md:1070 has no words yet).
const UPDATE = "New version";
const RELOAD = "Reload";

export interface SignpageView {
  client: SignpageClient | null;
  snapshot: SignpageClientSnapshot;
  /** Sign-in, deposit, buy, sell, orders and withdraw are on only when this is true: READY, the state known. */
  moneyOn: boolean;
}

const START: SignpageClientSnapshot = { status: "connecting", release: null, state: null, stale: false };
const Ctx = createContext<SignpageView>({ client: null, snapshot: START, moneyOn: false });

export const useSignpage = () => useContext(Ctx);

export function SignpageFrame({ children }: { children: ReactNode }) {
  const mount = useRef<HTMLDivElement>(null);
  const [client, setClient] = useState<SignpageClient | null>(null);
  const [snapshot, setSnapshot] = useState(START);

  useEffect(() => {
    const c = createSignpageClient({ url: SIGN_HOST_URL, host: { window, document, mount: mount.current! } });
    setClient(c);
    setSnapshot(c.snapshot());
    const off = c.subscribe(setSnapshot);
    return () => {
      off();
      c.destroy();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.signpage = snapshot.status;
  }, [snapshot.status]);

  return (
    <Ctx.Provider value={{ client, snapshot, moneyOn: snapshot.status === "ready" }}>
      <div ref={mount} className="spframe" />
      {children}
      {snapshot.status === "down" && (
        <div className="spdown" role="status">
          <span className="tt">{DOWN}</span>
          <button type="button" className="retry" onClick={() => client?.retry()}>
            {RETRY}
          </button>
        </div>
      )}
      {snapshot.status === "update" && (
        <div className="spdown" role="status">
          <span className="tt">{UPDATE}</span>
          <button type="button" className="retry" onClick={() => location.reload()}>
            {RELOAD}
          </button>
        </div>
      )}
    </Ctx.Provider>
  );
}
