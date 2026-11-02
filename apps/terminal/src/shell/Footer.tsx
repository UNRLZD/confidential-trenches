import { Link } from "react-router";
import { WORDS } from "../screens/verify/words.ts";

// The desktop footer's page links, R5's words and order (design/proto/assets/app.js:381 at design-lock-r5); the rest of
// R5's footer (prices, connection, block) joins with the data it shows. The Verify pill (09-design-brief S1.19, S18)
// opens the Verify panel; it names the panel, not a state (card app-verify-mount).
export function Footer() {
  return (
    <footer className="ft">
      <span className="links">
        <Link to="/terms">Terms</Link>
        <Link to="/privacy">Privacy</Link>
      </span>
      <Link to="/verify" className="pill" data-control="verify">{WORDS.title.text}</Link>
    </footer>
  );
}
