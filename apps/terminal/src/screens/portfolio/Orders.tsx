import { Plate } from "./Portfolio.tsx";
import { W } from "./W.tsx";

// The Orders route (/orders, Portfolio's Orders segment on the phone; card app-orders-coming-soon): orders are out of
// the plan for now (owner 10 Nov, owner-decisions row "Order of the returned feature groups"), so the page is
// Portfolio's own empty state, its plate and `Coming soon`, for everyone, signed in or out. It reads nothing.
export function OrdersRoute() {
  return (
    <div className="pf pf-orders">
      <div className="empty" data-testid="orders-soon" data-place="orders">
        <Plate />
        <span><W id="soon" /></span>
      </div>
    </div>
  );
}
