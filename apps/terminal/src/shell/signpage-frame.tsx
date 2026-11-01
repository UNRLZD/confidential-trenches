import type { SignpageClient, SignpageClientSnapshot } from "@blindfill/kit";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { reloadAll } from "./in-shell.ts";
import "./signpage-frame.css";

// The terminal's link to SIGN_HOST: the kit's client in parent mode, started by start.tsx (the terminal runs framed in
// SIGN_HOST's shell, in-shell.ts). Every screen reads the client and its state from useSignpage(); money controls are
// on only while moneyOn is true. The down state is a fixed toast, so it moves nothing on the page (BAR-04), and its
// Retry asks the shell again. A signing page whose message API this build does not speak is the update state (CH-146):
// money off until a reload, which the shell does for the top window (the shell and the app in it).
// <html data-signpage="connecting|ready|down|update"> names the state for the browser tests and the live check.

/** SIGN_HOST's release URL: the shell's origin, the only one the client posts to and hears. */
export const SIGN_HOST_URL = "https://sign.confidential.unrealized.trade/";

// Draft words (the live UNRLZD terminal's signerDown and retry lines, auth/copy.ts:190-191).
const DOWN = "Couldn't load. Your funds are safe.";
const RETRY = "Retry";
// Draft words: CH-146's update state (app.md:1070 has no words yet).
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

/** `client` lives as long as the page (start.tsx made it before the first render); this only reads it. */
export function SignpageFrame({ client, children }: { client: SignpageClient; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState(() => client.snapshot());

  useEffect(() => {
    setSnapshot(client.snapshot());
    return client.subscribe(setSnapshot);
  }, [client]);

  useEffect(() => {
    document.documentElement.dataset.signpage = snapshot.status;
  }, [snapshot.status]);

  return (
    <Ctx.Provider value={{ client, snapshot, moneyOn: snapshot.status === "ready" }}>
      {children}
      {snapshot.status === "down" && (
        <div className="spdown" role="status">
          <span className="tt">{DOWN}</span>
          <button type="button" className="retry" onClick={() => client.retry()}>
            {RETRY}
          </button>
        </div>
      )}
      {snapshot.status === "update" && (
        <div className="spdown" role="status">
          <span className="tt">{UPDATE}</span>
          <button type="button" className="retry" onClick={() => void reloadAll(client, location)}>
            {RELOAD}
          </button>
        </div>
      )}
    </Ctx.Provider>
  );
}
