// The faces the shell draws with (shell.css @font-face). Resolves when they are loaded, or after 1,000 ms (BAR-03's
// first content bound), so a font that fails never holds the screen back.
const FACES = ['400 13px "Schibsted Grotesk"', '500 13px "Schibsted Grotesk"', '600 13px "Schibsted Grotesk"', '400 13px "Chivo Mono"'];

export function fontsReady(): Promise<void> {
  const loaded = Promise.all(FACES.map((f) => document.fonts.load(f))).then(() => undefined, () => undefined);
  const cap = new Promise<void>((resolve) => setTimeout(resolve, 1000));
  return Promise.race([loaded, cap]);
}
