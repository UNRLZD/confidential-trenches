import { Link, NavLink } from "react-router";
import { AccountCluster, PhoneAccount } from "../screens/signin/Account.tsx";
import { Logo } from "./Logo.tsx";
import { ChainChip, SearchButton, SearchField } from "./Search.tsx";

// The desktop top bar's pages, R5's labels (design/proto/assets/app.js:349 at design-lock-r5), each to its route.
// R5's "Copy trade" and "Orders" join when their screens ship: no link opens an empty page (card app-no-blank-pages).
// After the nav, R5's search field (or under 1024 px its search button) and chain chip (Search.tsx), then the account.
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
      <SearchField />
      <SearchButton />
      <ChainChip />
      <AccountCluster />
    </header>
  );
}

// The phone header (R5 P.phHeader, app.js:393-399): the compact logo, the search button that opens the same search
// (Search.tsx) and the account side (Sign in or the balance pill); its other controls join with their screens.
export function PhoneHeader() {
  return (
    <header className="phh">
      <Link to="/" className="hit44 logo-link">
        <Logo phone />
      </Link>
      <SearchButton phone />
      <PhoneAccount />
    </header>
  );
}
