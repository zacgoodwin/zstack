## Estimation
It is directional only (you will not be held to its accuracy), but it must be reproducible: the same task estimated twice lands on the same number.

**Method:**

1. Estimate output tokens, the real work: thinking (xhigh is thinking-heavy, count it), code written, prose, and tool-call inputs.
2. Estimate input tokens: files read, tool results, and the context re-sent on every turn of an agentic loop. Volume is dominated by re-sent context, which is cache-read at roughly 0.1x, so price re-sent context at the cached rate and fresh reads at the full input rate.
3.  Make sure you estimate for each step in the process, not just the initial development. This is includes but is not limited to Code Review, QA, Subagent work, The planning, the execution, the merge, and the deployment. 
4. Multiply each bucket by its rate and sum. This is arithmetic, so compute it, do not eyeball it (deterministic space).
5. Round to the nearest $0.01.

**Model assumption:** price the estimate at the plan's recommended model (see "Model recommendation" below); when no recommendation exists (ad-hoc estimates outside the ticket flow), default to Opus 4.8 at `xhigh` effort. Reference prices per 1M tokens — verify current published rates before pricing a model not listed here.

- Fable 5: input $10.00, output $50.00, cached input reads ~$1.00
- Opus 4.8: input $5.00, output $25.00, cached input reads ~$0.50
- Sonnet 4.5: input $3.00, output $15.00, cached input reads ~$0.30
- Haiku 4.5: input $1.00, output $5.00, cached input reads ~$0.10

If these rates have not been updated in the last 14 days, check the current rates and update them if needed. 

**Buffer:** roughly +30% for a normal feature, +50% to +100% for a multi-ticket epic or unfamiliar code.

**Record it:** every ticket estimate is written to the ticket's Estimate field on the Projects board (a plain number = dollars, e.g. 3.75), the recommended model to the "Model" field and the recommended level of effort to the "Model Effort" field not just stated in the plan comment. 

**Model recommendation:** every ticket plan names the Claude model and the level of effort to execute with — the most cost-efficient model that finishes the ticket with a minimal number of issues. Cost efficiency includes rework: a cheaper model that produces bugs, review churn, or a second attempt costs more than the tier it saved, so when in doubt between two tiers, pick the higher one. Rules of thumb:

- **Haiku** — mechanical, tightly-specified, low-blast-radius work: renames, config/doc updates, small isolated fixes already pinned by existing tests.
- **Sonnet** — standard single-service features on familiar patterns, with a clear spec and a test harness that catches mistakes cheaply.
- **Opus** — cross-service or schema/engine/migration work, security-sensitive code, ambiguous specs, gnarly debugging, or anything where a botched attempt is expensive to unwind.
- **Fable** — the hardest tickets, where even Opus is likely to need a second attempt: epic-level architecture, subtle correctness-critical engine/allocation math, deep multi-service refactors, or debugging that has already defeated a lower tier. At 2x Opus pricing it earns its cost only when one clean pass replaces two.

State the recommendation and a one-line why next to the estimate in the plan comment; add the Model, Effort and Estimate into their respective fields. Add how much $ was consumed in doing this to the "Actual" field.