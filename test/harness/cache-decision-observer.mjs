// Harness extension for the cache warming check, loaded with `-e` next to the prefill extension. It
// writes each cache_warming_decision event that Pi emits to the file named by
// PREFILL_HARNESS_DECISION_LOG, with the action Pi chose, and returns nothing, so no decision changes.
// The record is the evidence that a decision reached the extension system; the warm request is
// evidence that it was carried out.
import { appendFileSync } from "node:fs";

export default function cacheDecisionObserver(pi) {
  pi.on("cache_warming_decision", (event) => {
    appendFileSync(
      process.env.PREFILL_HARNESS_DECISION_LOG,
      `${JSON.stringify({ observedAt: new Date().toISOString(), ...event })}\n`,
    );
  });
}
