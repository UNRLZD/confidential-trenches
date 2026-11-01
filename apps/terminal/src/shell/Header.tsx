import { Link, NavLink } from "react-router";
import { Logo } from "./Logo.tsx";

// The desktop top bar's pages, R5's labels (design/proto/assets/app.js:349 at design-lock-r5), each to its route.
// R5's "Copy trade" joins when its screen has a route.
const PAGES = [
  { to: "/", label: "Trenches" },
  { to: "/discover", label: "Discover" },
  { to: "/portfolio", label: "Portfolio" },
  { to: "/orders", label: "Orders" },
] as const;

const on = ({ isActive }: { isActive: boolean }) => (isActive ? "on" : undefined);

export function Header() {
  return (
    <header className="tb">
      <Link to="/" className="logo-link">
        <Logo />
      </Link>
      <nav className="nav">
        {PAGES.map((p) => (
          <NavLink key={p.to} to={p.to} end className={on}>
            {p.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}

// The phone header (R5 P.phHeader, app.js:393-399): the compact logo; its controls join with their screens.
export function PhoneHeader() {
  return (
    <header className="phh">
      <Link to="/" className="hit44 logo-link">
        <Logo phone />
      </Link>
    </header>
  );
}
