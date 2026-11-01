import { Link } from "react-router";

// The desktop footer's page links, R5's words and order (design/proto/assets/app.js:381 at design-lock-r5); the rest of
// R5's footer (prices, connection, block, Verified) joins with the data it shows.
export function Footer() {
  return (
    <footer className="ft">
      <span className="links">
        <Link to="/terms">Terms</Link>
        <Link to="/privacy">Privacy</Link>
      </span>
    </footer>
  );
}
