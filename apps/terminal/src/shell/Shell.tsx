import { Navigate, Route, Routes } from "react-router";
import { ROUTES } from "../routes/routes.ts";
import { Screen } from "../routes/Screen.tsx";
import { Footer } from "./Footer.tsx";
import { Header, PhoneHeader } from "./Header.tsx";
import { TabBar } from "./TabBar.tsx";

// The shell: the desktop top bar and footer, the phone header and tab bar, and one route per screen. Both forms are
// in the page and CSS shows one (shell.css), so nothing is swapped after the first paint.
export function Shell() {
  return (
    <div className="shell">
      <Header />
      <PhoneHeader />
      <Routes>
        {ROUTES.map((r) => (
          <Route key={r.id} path={r.path} element={<Screen id={r.id} />} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Footer />
      <TabBar />
    </div>
  );
}
