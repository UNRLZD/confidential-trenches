import type { ComponentType } from "react";
import { DiscoverRoute } from "../screens/discover/Discover.tsx";
import { PhoneAccountMenu } from "../screens/signin/Account.tsx";
import { headerModel } from "../screens/signin/model.ts";
import { useSigninSheet, useSigninSource } from "../screens/signin/source.tsx";
import { W } from "../screens/signin/Word.tsx";
import { TokenRoute } from "../screens/token/TokenPage.tsx";
import { VerifyRoute } from "../screens/verify/VerifyRoute.tsx";
import { PortfolioMount } from "./PortfolioMount.tsx";
import type { RouteId } from "./routes.ts";

// The route map: the screen each route draws. No link or tab opens an empty main (card app-no-blank-pages): a page
// that needs an account draws the header's Sign in signed out; Verify draws over Trenches, opened directly or from the
// footer's pill. A route its card has not filled yet and no link reaches (Orders, the legal pages' cards) draws an
// empty main.

/** Signed out, the header's Sign in (S1.1, the same word and the same sheet) in place of a page that needs an account. */
function SignedOut() {
  const { setOpen } = useSigninSheet();
  return (
    <div className="signed-out" data-signed-out>
      <button type="button" className="btn-signin" onClick={() => setOpen(true)}>
        <W id="signIn" />
      </button>
    </div>
  );
}

/** A page that needs an account: Sign in while signed out, the page once signed in (nothing while the state loads). */
const needsAccount = (In: ComponentType | null): ComponentType =>
  function Gate() {
    const kind = headerModel(useSigninSource().snapshot).kind;
    if (kind === "out") return <SignedOut />;
    return In && kind !== "loading" ? <In /> : null;
  };

/** Verify's panel over the Trenches page, so the page behind it is never empty. */
function VerifyOverTrenches() {
  return (
    <>
      <TokenRoute />
      <VerifyRoute />
    </>
  );
}

const SCREENS: Partial<Record<RouteId, ComponentType>> = {
  token: TokenRoute,
  discover: DiscoverRoute,
  verify: VerifyOverTrenches,
  // the account rows (S1.16 at 390) for the phone's Account tab
  profile: needsAccount(PhoneAccountMenu),
  // Portfolio and Activity, each tap mounted (PortfolioMount.tsx)
  portfolio: needsAccount(PortfolioMount),
};

export function Screen({ id }: { id: RouteId }) {
  const S = SCREENS[id];
  return (
    <main className="screen" data-route={id}>
      {S && <S />}
    </main>
  );
}
