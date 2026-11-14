// The public repository, linked from the desktop footer's right end, the welcome's last slide and the deposit sheet's
// notice (owner ask, 14 Nov ~06:00Z: "the GH repo at the bottom right ... together with the links"; feedback is open
// there). Its mark is GitHub's own (Octicons mark-github, MIT, github.com/primer/octicons), drawn in currentColor.

export const REPO_URL = "https://github.com/UNRLZD/confidential-trenches";
/** Where feedback goes: the repository's issues. */
export const REPO_ISSUES_URL = `${REPO_URL}/issues`;

/** The main UNRLZD product's own channels, as its footer links them (owner 14 Nov 09:05Z: "others link like the main
 *  product"); each opens in a new tab. Marks: X's brand toolkit logo, Telegram's t_logo.svg, the main product's book. */
export const SOCIALS = [
  { id: "x", href: "https://x.com/UNRLZDtrade" },
  { id: "docs", href: "https://docs.unrealized.trade" },
  { id: "telegram", href: "https://t.me/UNRLZDtrade" },
] as const;

export function SocialMark({ id }: { id: (typeof SOCIALS)[number]["id"] }) {
  if (id === "docs")
    return (
      <svg viewBox="0 0 12 12" aria-hidden="true" className="socmark" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round">
        <path d="M6 3.3C5 2.4 3.6 2 1.8 2v7.2c1.8 0 3.2.4 4.2 1.3 1-.9 2.4-1.3 4.2-1.3V2C8.4 2 7 2.4 6 3.3z" />
        <path d="M6 3.3v7.2" />
      </svg>
    );
  if (id === "x")
    return (
      <svg viewBox="-136.2 -122.7 1472.4 1472.4" aria-hidden="true" className="socmark">
        <path d="M714.163 519.284L1160.89 0H1055.03L667.137 450.887L357.328 0H0L468.492 681.821L0 1226.37H105.866L515.491 750.218L842.672 1226.37H1200L714.137 519.284H714.163ZM569.165 687.828L521.697 619.934L144.011 79.6944H306.615L611.412 515.685L658.88 583.579L1055.08 1150.3H892.476L569.165 687.854V687.828Z" />
      </svg>
    );
  return (
    <svg viewBox="-12.8 -12.8 153.6 153.6" aria-hidden="true" className="socmark">
      <path fillRule="evenodd" d="M64 0a64 64 0 1 1 0 128a64 64 0 1 1 0-128Z M28.9700376,63.3244248 C47.6273373,55.1957357 60.0684594,49.8368063 66.2934036,47.2476366 C84.0668845,39.855031 87.7600616,38.5708563 90.1672227,38.528 C90.6966555,38.5191258 91.8804274,38.6503351 92.6472251,39.2725385 C93.294694,39.7979149 93.4728387,40.5076237 93.5580865,41.0057381 C93.6433345,41.5038525 93.7494885,42.63857 93.6651041,43.5252052 C92.7019529,53.6451182 88.5344133,78.2034783 86.4142057,89.5379542 C85.5170662,94.3339958 83.750571,95.9420841 82.0403991,96.0994568 C78.3237996,96.4414641 75.5015827,93.6432685 71.9018743,91.2836143 C66.2690414,87.5912212 63.0868492,85.2926952 57.6192095,81.6896017 C51.3004058,77.5256038 55.3966232,75.2369981 58.9976911,71.4967761 C59.9401076,70.5179421 76.3155302,55.6232293 76.6324771,54.2720454 C76.6721165,54.1030573 76.7089039,53.4731496 76.3346867,53.1405352 C75.9604695,52.8079208 75.4081573,52.921662 75.0095933,53.0121213 C74.444641,53.1403447 65.4461175,59.0880351 48.0140228,70.8551922 C45.4598218,72.6091037 43.1463059,73.4636682 41.0734751,73.4188859 C38.7883453,73.3695169 34.3926725,72.1268388 31.1249416,71.0646282 C27.1169366,69.7617838 23.931454,69.0729605 24.208838,66.8603276 C24.3533167,65.7078514 25.9403832,64.5292172 28.9700376,63.3244248 Z" />
    </svg>
  );
}

export function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="ghmark">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
