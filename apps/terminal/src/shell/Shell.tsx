import type { SignpageClient } from "@blindfill/kit";
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
// in the page and CSS shows one (shell.css), so nothing is swapped after the first paint. SignpageFrame shares the
// signing page's client (parent mode, start.tsx) with the whole app; ReturnHopProvider opens SIGN_HOST's own screens in
// its shell; the one sign-in sheet (S2.1, S19) sits outside both header forms, so CSS hiding either never hides it.
// `screen` draws each route (the browser tests pass a probe screen; the app passes none).
export function Shell({ client, screen: S = Screen }: { client: SignpageClient; screen?: ComponentType<{ id: RouteId }> }) {
  return (
    <SignpageFrame client={client}>
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
