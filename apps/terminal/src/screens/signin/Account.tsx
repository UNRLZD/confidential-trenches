import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import type { RouteId } from "../../routes/routes.ts";
import { ROUTES } from "../../routes/routes.ts";
import { HopLine } from "./HopLine.tsx";
import { Icon } from "./Icon.tsx";
import { useBalance } from "../portfolio/source.tsx";
import { firstShape, hintOf, readHint, shapeOf, writeHint } from "./hint.ts";
import type { Hint } from "./hint.ts";
import { headerModel, usd } from "./model.ts";
import type { HeaderModel } from "./model.ts";
import { useDepositSheet } from "../deposit/source.tsx";
import { useSigninSheet, useSigninSource } from "./source.tsx";
import type { SigninSource } from "./source.tsx";
import { text, W } from "./Word.tsx";
import "./signin.css";

// The header's account states (S1.1-S1.4) and the account menu (S1.16), R5's top bar right cluster and phone header
// (design/proto/assets/app.js:349-362 and :393-396 at design-lock-r5; proto.css:110-116, :239-242). The Deposit button
// and the phone's green + open the shell's one deposit sheet (shell/DepositMount.tsx); they are on only while the signing
// page is READY.

const routeOf = (pathname: string): RouteId => ROUTES.find((r) => r.path === pathname)?.id ?? "discover";

function Balance({ m }: { m: HeaderModel }) {
  return m.kind === "loading" ? <span className="sk" data-balance="loading" /> : <span className="v" data-balance={usd(m.cents)}>{usd(m.cents)}</span>;
}

/** The desktop top bar's right cluster. */
/** The account side's shape (hint.ts, card app-header-first-paint-auth): the stored hint read in the first render,
 *  before the first paint (none: the reserved "in" box), kept while the state loads; then hint.ts shapeOf. The hint is
 *  written whenever a snapshot holds a state. */
export function useAccountShape(): Hint {
  const src = useSigninSource();
  const [first] = useState(() => firstShape(readHint()));
  const landed = hintOf(src.snapshot);
  useEffect(() => {
    if (landed) writeHint(landed);
  }, [landed]);
  return shapeOf(headerModel(src.snapshot).kind, first);
}

export function AccountCluster({ initialMenu = false }: { initialMenu?: boolean }) {
  const src = useSigninSource();
  const { setOpen } = useSigninSheet();
  const deposit = useDepositSheet();
  const m = headerModel(src.snapshot, useBalance(src.snapshot));
  const shape = useAccountShape();
  const [menu, setMenu] = useState(initialMenu);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => box.current && !box.current.contains(e.target as Node) && setMenu(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [menu]);
  // signed out closes the menu
  useEffect(() => {
    if (m.kind === "out") setMenu(false);
  }, [m.kind]);

  // The skeleton (S1.2), signed out (S1.1) and signed in (S1.3/S1.4) are three clusters, each its own key: when the
  // state lands the one drawn replaces the skeleton at the bar's end, so nothing on screen moves across it (BAR-04).
  // S1.2 where the hint says signed out: Sign in's own box, blank, so Sign in lands in it with nothing moving
  if (m.kind === "loading" && shape === "out")
    return (
      <div className="tbr" data-header="S1.2" key="loading-out">
        <span className="btn-signin sk" aria-hidden="true" style={{ width: "auto", height: 42, borderRadius: 11, display: "flex", alignItems: "center", color: "transparent" }}>
          <W id="signIn" />
        </span>
      </div>
    );
  if (m.kind === "out")
    return (
      <div className="tbr" data-header="S1.1" key="out">
        <button type="button" className="btn-signin" onClick={() => setOpen(true)}>
          <W id="signIn" />
        </button>
      </div>
    );
  return (
    <div className="tbr" data-header={m.kind === "loading" ? "S1.2" : m.kind === "empty" ? "S1.3" : "S1.4"} ref={box} key={m.kind === "loading" ? "loading" : "in"}>
      <div className="balblock">
        <Balance m={m} />
      </div>
      <button type="button" className="btn-dep" disabled={!src.moneyOn || m.kind === "loading"} data-action="deposit" onClick={() => deposit.setOpen(true)}>
        <W id="deposit" />
      </button>
      <button type="button" className={menu ? "acct open" : "acct"} aria-label={text("account")} aria-expanded={menu} disabled={m.kind === "loading"} onClick={() => setMenu(!menu)}>
        <span className="av">
          <Icon name="user" size={15} />
          {m.backupDot && <span className="dot" data-backup-dot />}
        </span>
        <Icon name="chevDown" size={12} />
      </button>
      {menu && <AccountMenu src={src} m={m} onDone={() => setMenu(false)} />}
    </div>
  );
}

/**
 * S1.16: the wallet label (CN-79) for a wallet account, Backup with its dot, Withdraw, Sync, Privacy and Sign out. Backup,
 * Withdraw and Sign out run on SIGN_HOST's top-level pages through the hop; Sync starts `restore` again (S19.6).
 */
export function AccountMenu({ src, m, onDone, phone = false }: { src: SigninSource; m: HeaderModel; onDone?: () => void; phone?: boolean }) {
  const { pathname } = useLocation();
  const route = routeOf(pathname);
  const off = !src.moneyOn;
  // the menu closes as the tab moves to SIGN_HOST; a hop that did not leave keeps it open with its line (HopLine)
  const go = (run: () => Promise<{ ok: boolean } | null>) => async () => {
    if ((await run())?.ok) onDone?.();
  };
  const view = (control: string) => ({ route, sheet: null, control, fields: {} });
  const row = (control: string, children: ReactNode, onClick: () => void, extra?: ReactNode) => (
    <>
      <button type="button" className="mrow" data-control={control} disabled={off || src.locked === control} onClick={onClick}>
        <span className="ml">{children}</span>
        {extra}
      </button>
      <HopLine control={control} />
    </>
  );
  return (
    <div className={phone ? "amenu ph" : "amenu"} role="menu" data-state="S1.16">
      {m.way === "wallet" && (
        <div className="mwho" data-wallet-label>
          <Icon name="wallet" size={15} />
          <W id="wallet" />
        </div>
      )}
      {row("acct-backup", <W id="backup" />, go(() => src.hop("backup.open", {}, view("acct-backup"))), m.backupDot ? <span className="mdot" data-backup-dot /> : null)}
      {row("acct-withdraw", <W id="withdraw" />, go(() => src.hop("withdraw.open", {}, view("acct-withdraw"))))}
      {row("acct-sync", <W id="sync" />, () => {
        src.restore();
        onDone?.();
      })}
      <Link className="mrow" to="/privacy" onClick={() => onDone?.()}>
        <span className="ml">
          <W id="privacy" />
        </span>
      </Link>
      <div className="mrule" />
      {row("acct-signout", <W id="signOut" />, go(() => src.hop("signout", {}, view("acct-signout"))))}
    </div>
  );
}

/** The phone header's right side: Sign in, or the balance pill with its green + (S4). */
export function PhoneAccount() {
  const src = useSigninSource();
  const { setOpen } = useSigninSheet();
  const deposit = useDepositSheet();
  const m = headerModel(src.snapshot, useBalance(src.snapshot));
  const shape = useAccountShape();
  // as on desktop: the skeleton, Sign in and the balance pill are each their own key, so one replaces another (BAR-04);
  // where the hint says signed out, the skeleton is Sign in's own box, blank
  if (m.kind === "loading" && shape === "out")
    return (
      <div className="tbr-ph" key="loading-out">
        <span className="hit44" data-header="S1.2" aria-hidden="true">
          <span className="signin" style={{ color: "transparent" }}>
            <W id="signIn" />
          </span>
        </span>
      </div>
    );
  if (m.kind === "out")
    return (
      <div className="tbr-ph" key="out">
        <button type="button" className="hit44" data-header="S1.1" onClick={() => setOpen(true)}>
          <span className="signin">
            <W id="signIn" />
          </span>
        </button>
      </div>
    );
  return (
    <div className="tbr-ph" key={m.kind === "loading" ? "loading" : "in"}>
      <button type="button" className="hit44" data-header={m.kind === "loading" ? "S1.2" : m.kind === "empty" ? "S1.3" : "S1.4"} data-action="deposit" disabled={!src.moneyOn || m.kind === "loading"} onClick={() => deposit.setOpen(true)}>
        <span className="balp">
          <Balance m={m} />
          <span className="plus">
            <Icon name="plus" size={16} stroke={1.7} />
          </span>
        </span>
      </button>
    </div>
  );
}

/** The phone's account rows (S1.16 at 390), for the Account tab. */
export function PhoneAccountMenu() {
  const src = useSigninSource();
  const m = headerModel(src.snapshot, useBalance(src.snapshot));
  if (m.kind === "out" || m.kind === "loading") return null;
  return <AccountMenu src={src} m={m} phone />;
}
