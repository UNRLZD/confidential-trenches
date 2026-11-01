A card's live check: scripts/live-checks/<key>.mjs checks the card's end state on what is deployed, and runs after every deploy.
Its tests replay a recorded good answer, which must pass, and a recorded bad one, which must fail.
A card with nothing live puts `Live check: none (<reason>)` in its pull request body (scripts/ci/verify-gate.mjs).
