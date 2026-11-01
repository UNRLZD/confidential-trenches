import { useEffect } from "react";
import { useReturnHop } from "../../shell/ReturnHop.tsx";
import type { HopWhy } from "../../shell/return-hop.ts";
import { useSignpage } from "../../shell/signpage-frame.tsx";
import { W } from "./Word.tsx";
import type { WordId } from "./words.ts";

// One line in place of a hop that did not leave for SIGN_HOST (card app-hop-refused): drawn under the tapped control,
// so a tap never ends in nothing. Retry opens the same kind again, and only where a retry can work: never for a
// refusal by the page's rule, and on only while the signing page is READY. No pop-up, no confirm, no toast. Closing
// the sheet or menu that holds it drops it.

const WORD: Record<HopWhy, WordId> = { refused: "hopRefused", error: "hopError", silent: "hopSilent" };

export function HopLine({ control }: { control: string }) {
  const { failed, dismiss } = useReturnHop();
  const { moneyOn } = useSignpage();
  useEffect(() => () => dismiss(control), [control, dismiss]);
  if (failed?.control !== control) return null;
  return (
    <div className="hopline" role="status" data-hop-failed={control} data-hop-why={failed.why}>
      <span className="warn">
        <W id={WORD[failed.why]} />
      </span>
      {failed.why !== "refused" && (
        <button type="button" className="retry" data-hop-retry disabled={!moneyOn} onClick={failed.retry}>
          <W id="retry" />
        </button>
      )}
    </div>
  );
}
