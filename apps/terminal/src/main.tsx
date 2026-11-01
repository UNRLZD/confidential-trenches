// The terminal's entry. Blindfill is reached only through the kit's public entry (CLAUDE.md, Rules for changes); the
// import below is what CI's terminal-uses-kit-entry rule reads (.dependency-cruiser.cjs, required).
import "@blindfill/kit";
import { start } from "./shell/start.tsx";

start();
