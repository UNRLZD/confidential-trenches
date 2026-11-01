import stack1x from "./brand/ct-stack-1x.svg";
import stack1xCool from "./brand/ct-stack-1x-cool.svg";
import stack2x from "./brand/ct-stack-2x.svg";
import stack2xCool from "./brand/ct-stack-2x-cool.svg";
import stackPh from "./brand/ct-stack-phone-2x.svg";
import stackPhCool from "./brand/ct-stack-phone-2x-cool.svg";
import wm from "./brand/wordmark-dots-header-1x.svg";
import wmCool from "./brand/wordmark-dots-header-1x-cool.svg";

// "Confidential Trenches" by $UNRLZD (design round 15), as R5 draws it (design/proto/assets/app.js:340-347 at
// design-lock-r5): the stacked dot words, lit layer over cool layer, "by" as text and $UNRLZD as UNRLZD's dot wordmark.
const LABEL = "Confidential Trenches by $UNRLZD";

function Byline() {
  return (
    <span className="by" aria-hidden="true">
      <span>by</span>
      <span className="wm">
        <img src={wmCool} alt="" />
        <img src={wm} alt="" />
      </span>
    </span>
  );
}

export function Logo({ phone = false }: { phone?: boolean }) {
  const layers = phone
    ? [
        [stackPhCool, stackPhCool],
        [stackPh, stackPh],
      ]
    : [
        [stack1xCool, stack2xCool],
        [stack1x, stack2x],
      ];
  return (
    <span className={phone ? "ctlogo ph" : "ctlogo"} role="img" aria-label={LABEL}>
      <span className="dots">
        {layers.map(([one, two]) => (
          <picture key={one}>
            <source media="(min-resolution: 1.5dppx)" srcSet={two} />
            <img src={one} alt="" />
          </picture>
        ))}
      </span>
      <Byline />
    </span>
  );
}
