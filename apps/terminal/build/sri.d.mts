import type { Plugin } from "vite";
export function sha384(bytes: Uint8Array): string;
export function addIntegrity(html: string, read: (url: string) => Uint8Array, fonts?: string[]): string;
export function sri(): Plugin;
