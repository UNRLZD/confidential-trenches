import type { SigninWay } from "@blindfill/kit";
import { Fragment, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { RouteId } from "../../routes/routes.ts";
import { ROUTES } from "../../routes/routes.ts";
import { HopLine } from "./HopLine.tsx";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./Icon.tsx";
import { useBalance } from "../portfolio/source.tsx";
import { restoreModel, showRestore, signinWays, usd } from "./model.ts";
import type { RestoreModel } from "./model.ts";
import { useSigninSheet, useSigninSource } from "./source.tsx";
import { text, W } from "./Word.tsx";
import type { WordId } from "./words.ts";
import "./signin.css";

// The sign-in sheet (S2.1) and the restore screens (S19) inside it: a centred modal on desktop, a bottom sheet on the
// phone (09-design-brief S2; app.md FR-P1). Each way in hops to SIGN_HOST's top-level page with `signin.open` and that
// way (CH-011); the 12 words and the key ceremony live only there. A way the page refuses or does not answer shows
// HopLine under it (card app-hop-refused). After a sign-in that restores an account (Face ID or
// the 12 words, or the wallet way's "I already have one"), the sheet shows the `restore` operation from `state`:
// scanning with the balance growing, done, nothing found, or offline with Retry. A new account shows no sheet: the
// header goes to S1.3 with the Backup dot until the 12 words are saved.

const WAYS: Record<SigninWay, { word: WordId; icon: IconName }> = {
  passkey: { word: "usePasskey", icon: "key" },
  wallet: { word: "wallet", icon: "wallet" },
  words: { word: "recoveryCode", icon: "words" },
};

export const SHEET_ID = "signin";
export const controlOf = (way: SigninWay) => `signin-${way}`;
const routeOf = (pathname: string): RouteId => ROUTES.find((r) => r.path === pathname)?.id ?? "discover";

export function SigninSheet() {
  const src = useSigninSource();
  const { open, setOpen } = useSigninSheet();
  const { pathname } = useLocation();
  const state = src.snapshot.state;
  const r = restoreModel(state, useBalance(src.snapshot));
  const seen = useRef(new Set<string>());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  if (r && (r.kind === "scanning" || r.kind === "offline")) seen.current.add(r.id);
  const restoring = showRestore(r, seen.current, closed);
  const signedIn = state?.signed_in === true;
  const visible = restoring || (open && !signedIn);

  // signed in elsewhere (another tab, or the return) closes the ways in; the sheet's open flag goes with it
  useEffect(() => {
    if (signedIn && open) setOpen(false);
  }, [signedIn, open, setOpen]);

  useEffect(() => {
    if (!visible) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  });

  if (!visible) return null;
  function close() {
    if (restoring && r) setClosed(new Set([...closed, r.id]));
    setOpen(false);
  }

  return (
    <div className="sgn" data-sheet={SHEET_ID} data-state={restoring && r ? restoreState(r) : "S2.1"}>
      <div className="sgn-scrim" onClick={close} />
      <div className="sgn-box" role="dialog" aria-modal="true" aria-labelledby="sgn-title">
        <div className="grab">
          <i />
        </div>
        <div className="sgn-hd">
          <h2 id="sgn-title">{title(restoring ? r : null)}</h2>
          <button type="button" className="sgn-x" aria-label={text("close")} onClick={close}>
            <Icon name="x" size={14} stroke={1.4} />
          </button>
        </div>
        {restoring && r ? <Restore r={r} retry={src.restore} off={!src.moneyOn} /> : <Ways route={routeOf(pathname)} />}
      </div>
    </div>
  );
}

function title(r: RestoreModel | null) {
  if (!r) return <W id="signIn" />;
  if (r.kind === "nothing") return <W id="nothingFound" />;
  if (r.kind === "done") return <Icon name="check" size={18} stroke={1.5} />;
  return <W id="restoring" />;
}

const restoreState = (r: RestoreModel) => ({ scanning: "S19.1", done: "S19.3", nothing: "S19.4", offline: "S19.5" })[r.kind];

function Ways({ route }: { route: RouteId }) {
  const src = useSigninSource();
  const ways = signinWays(src.snapshot.state);
  const off = !src.moneyOn;
  return (
    <div className="sgn-ways">
      {ways.map((way, i) => {
        const control = controlOf(way);
        return (
          <Fragment key={way}>
            <button
              type="button"
              className={i === 0 ? "sgn-opt primary" : "sgn-opt"}
              data-way={way}
              data-control={control}
              disabled={off || src.locked !== null}
              aria-busy={src.locked === control}
              onClick={() => void src.hop("signin.open", { way }, { route, sheet: SHEET_ID, control, fields: {} })}
            >
              <span className="ic">
                <Icon name={WAYS[way].icon} size={18} stroke={1.2} />
              </span>
              <span className="tt">
                <W id={WAYS[way].word} />
              </span>
            </button>
            <HopLine control={control} />
          </Fragment>
        );
      })}
    </div>
  );
}

/** S19: the balance as the scan finds it, then done, nothing found, or offline with Retry (a new `restore`). */
function Restore({ r, retry, off }: { r: RestoreModel; retry: () => void; off: boolean }) {
  return (
    <div className="sgn-restore" data-restore={r.kind}>
      <div className={r.kind === "nothing" ? "rbal dim" : "rbal"} data-balance={usd(r.cents)}>
        {usd(r.cents)}
      </div>
      {r.kind === "scanning" && <div className="rbar" aria-hidden="true"><i /></div>}
      {r.kind === "offline" && (
        <div className="rline row">
          <span className="warn">
            <W id="offline" />
          </span>
          <button type="button" className="retry" disabled={off} onClick={retry}>
            <W id="retry" />
          </button>
        </div>
      )}
    </div>
  );
}
