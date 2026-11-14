// The welcome's fixture page (test/welcome/run.mjs): the welcome over a stand-in of the app's ground, with the shell's
// styles (fonts, tokens). ?f=force draws it whatever the store holds; ?f=auto draws it as the app does (shouldWelcome).
import { createRoot } from "react-dom/client";
import { Welcome } from "../../src/shell/Welcome.tsx";
import "../../src/shell/shell.css";

const f = new URLSearchParams(location.search).get("f");
createRoot(document.getElementById("root")!).render(
  <div className="shell" style={{ minHeight: "100dvh" }}>
    <Welcome force={f === "force"} />
  </div>,
);
