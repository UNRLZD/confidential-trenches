import type { ComponentType } from "react";
import { Navigate, Route, Routes } from "react-router";
import { ROUTES } from "../routes/routes.ts";
import type { RouteId } from "../routes/routes.ts";
import { Screen } from "../routes/Screen.tsx";
import { SigninSheet } from "../screens/signin/SigninSheet.tsx";
import { SigninSheetProvider } from "../screens/signin/source.tsx";
import { Footer } from "./Footer.tsx";
import { Header, PhoneHeader } from "./Header.tsx";
import { ReturnHopProvider } from "./ReturnHop.tsx";
import { SignpageFrame } from "./signpage-frame.tsx";
import { TabBar } from "./TabBar.tsx";

// The shell: the desktop top bar and footer, the phone header and tab bar, and one route per screen. Both forms are
// in the page and CSS shows one (shell.css), so nothing is swapped after the first paint. SignpageFrame mounts the
// hidden iframe of SIGN_HOST once for the whole app; ReturnHopProvider runs the same-tab hop to SIGN_HOST and back;
// the one sign-in sheet (S2.1, S19) sits outside both header forms, so CSS hiding either never hides it.
// `screen` draws each route (the browser tests pass a probe screen; the app passes none).
export function Shell({ screen: S = Screen }: { screen?: ComponentType<{ id: RouteId }> }) {
  return (
    <SignpageFrame>
      <ReturnHopProvider>
        <SigninSheetProvider>
          <div className="shell">
            <Header />
            <PhoneHeader />
            <Routes>
              {ROUTES.map((r) => (
                <Route key={r.id} path={r.path} element={<S id={r.id} />} />
              ))}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            <Footer />
            <TabBar />
          </div>
          <SigninSheet />
        </SigninSheetProvider>
      </ReturnHopProvider>
    </SignpageFrame>
  );
}
