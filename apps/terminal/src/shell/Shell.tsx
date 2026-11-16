import type { SignpageClient } from "@blindfill/kit";
import { useEffect, useLayoutEffect } from "react";
import type { ComponentType } from "react";
import { Route, Routes, useLocation, useNavigationType } from "react-router";
import { ROUTES } from "../routes/routes.ts";
import type { RouteId } from "../routes/routes.ts";
import { Screen } from "../routes/Screen.tsx";
import { SigninSheet } from "../screens/signin/SigninSheet.tsx";
import { SigninSheetProvider } from "../screens/signin/source.tsx";
import { DepositSheetProvider } from "../screens/deposit/source.tsx";
import { DepositMount } from "./DepositMount.tsx";
import { WithdrawPickProvider } from "../screens/withdraw/WithdrawPick.tsx";
import { Footer } from "./Footer.tsx";
import { Header, PhoneHeader } from "./Header.tsx";
import { tellShell } from "./in-shell.ts";
import { ReturnHopProvider } from "./ReturnHop.tsx";
import { SignpageFrame, useSignpage } from "./signpage-frame.tsx";
import { TabBar } from "./TabBar.tsx";
import { Welcome } from "./Welcome.tsx";

// The shell: the desktop top bar and footer, the phone header and tab bar, and one route per screen. Both forms are
// in the page and CSS shows one (shell.css), so nothing is swapped after the first paint. SignpageFrame shares the
// signing page's client (parent mode, start.tsx) with the whole app; ReturnHopProvider opens SIGN_HOST's own screens in
// its shell; the one sign-in sheet (S2.1, S19) and the one deposit sheet with the withdraw progress (DepositMount.tsx)
// sit outside both header forms, so CSS hiding either never hides them. The welcome (Welcome.tsx) opens over all of it on
// a first visit.
// A path no route names draws the not-found state (routes/Screen.tsx), at the address the visitor opened.
// `screen` draws each route (the browser tests pass a probe screen; the app passes none). ShellAddress tells SIGN_HOST's
// shell the app's path and query on every move and whenever the client is READY again, so the top window's address
// follows the app.
export function Shell({ client, screen: S = Screen }: { client: SignpageClient; screen?: ComponentType<{ id: RouteId }> }) {
  return (
    <SignpageFrame client={client}>
      <ReturnHopProvider>
        <SigninSheetProvider>
          <DepositSheetProvider>
            <WithdrawPickProvider>
            <ShellAddress />
            <PageTop />
            <div className="shell">
              <Header />
              <PhoneHeader />
              <Routes>
                {ROUTES.map((r) => (
                  <Route key={r.path} path={r.path} element={<S id={r.id} />} />
                ))}
                <Route path="*" element={<S id="notfound" />} />
              </Routes>
              <Footer />
              <TabBar />
            </div>
            <SigninSheet />
            <DepositMount />
            <Welcome />
            </WithdrawPickProvider>
          </DepositSheetProvider>
        </SigninSheetProvider>
      </ReturnHopProvider>
    </SignpageFrame>
  );
}

function ShellAddress() {
  const { pathname, search } = useLocation();
  const { client, snapshot } = useSignpage();
  const ready = snapshot.status === "ready";
  useEffect(() => {
    if (client && ready) void tellShell(client, { pathname, search });
  }, [client, ready, pathname, search]);
  return null;
}

/** A move to another page opens it at its top: the window kept the last page's scroll, so a phone token page opened
 *  wherever Discover was scrolled (QA walk 16 Nov, item 4). Back and Forward (POP) leave the scroll to the browser and to
 *  the page (PhoneTrenches puts the list back where it was); a change of the query alone moves nothing. */
function PageTop() {
  const { pathname } = useLocation();
  const how = useNavigationType();
  useLayoutEffect(() => {
    if (how !== "POP") window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    // biome-ignore lint/correctness/useExhaustiveDependencies: on a new path only
  }, [pathname]);
  return null;
}
