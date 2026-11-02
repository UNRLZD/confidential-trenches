// The /verify route (card app-verify-mount; 09-design-brief S18: a right drawer on desktop, opened from the footer's
// Verify link, a full page on phone). On each open it reads the vault live (live.ts) on the release's pair for the
// network this build names, and draws the Verify panel loading until that read ends. Close goes back, or home when
// the panel was the first page.
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { liveVerify } from "./live.ts";
import type { VerifyView } from "./model.ts";
import { buildNetwork, VERIFY_RELEASES } from "./release.ts";
import { Verify } from "./Verify.tsx";

export function VerifyRoute() {
  const [view, setView] = useState<VerifyView>({ state: "loading" });
  const navigate = useNavigate();
  const { key } = useLocation();
  useEffect(() => {
    const stop = new AbortController();
    void liveVerify(VERIFY_RELEASES[buildNetwork()], fetch, stop.signal).then((v) => stop.signal.aborted || setView(v));
    return () => stop.abort();
  }, []);
  return <Verify view={view} onClose={() => (key === "default" ? navigate("/") : navigate(-1))} />;
}
