import { Link, NavLink } from "react-router";
import { AccountCluster, PhoneAccount } from "../screens/signin/Account.tsx";
import { Logo } from "./Logo.tsx";

// The desktop top bar's pages, R5's labels (design/proto/assets/app.js:349 at design-lock-r5), each to its route.
// R5's "Copy trade" and "Orders" join when their screens ship: no link opens an empty page (card app-no-blank-pages).
const PAGES = [
  { to: "/", label: "Trenches" },
  { to: "/discover", label: "Discover" },
  { to: "/portfolio", label: "Portfolio" },
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
      <AccountCluster />
    </header>
  );
}

// The phone header (R5 P.phHeader, app.js:393-399): the compact logo and the account side (Sign in or the balance pill);
// its other controls join with their screens.
export function PhoneHeader() {
  return (
    <header className="phh">
      <Link to="/" className="hit44 logo-link">
        <Logo phone />
      </Link>
      <PhoneAccount />
    </header>
  );
}
