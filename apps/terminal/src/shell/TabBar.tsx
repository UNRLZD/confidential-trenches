import { NavLink } from "react-router";

// The phone tab bar, R5's four tabs and icons (design/proto/assets/app.js:82-88 and :400-402 at design-lock-r5).
const TABS = [
  { to: "/", label: "Trenches", d: ["M3 17l5.5-5.5 4 4L21 7", "M15 7h6v6"] },
  { to: "/discover", label: "Discover", d: ["M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0", "M15.5 8.5l-2.2 4.8-4.8 2.2 2.2-4.8z"] },
  { to: "/portfolio", label: "Portfolio", d: ["M12 3a9 9 0 1 0 9 9h-9z", "M15 3.5a9 9 0 0 1 5.5 5.5H15z"] },
  { to: "/profile", label: "Account", d: ["M12 12a4 4 0 1 0 0-8a4 4 0 1 0 0 8", "M4.5 20c1.4-3.3 4.2-5 7.5-5s6.1 1.7 7.5 5"] },
] as const;

export function TabBar() {
  return (
    <nav className="tabbar">
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} end className={({ isActive }) => (isActive ? "tb4 on" : "tb4")}>
          <span className="pl">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {t.d.map((d) => (
                <path key={d} d={d} />
              ))}
            </svg>
          </span>
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
