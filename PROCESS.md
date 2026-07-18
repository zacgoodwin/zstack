## Estimation
It is directional only (you will not be held to its accuracy), but it must be reproducible: the same task estimated twice lands on the same number.

**Method:**

1. Estimate output tokens, the real work: thinking (xhigh is thinking-heavy, count it), code written, prose, and tool-call inputs.
2. Estimate input tokens: files read, tool results, and the context re-sent on every turn of an agentic loop. Volume is dominated by re-sent context, which is cache-read at roughly 0.1x, so price re-sent context at the cached rate and fresh reads at the full input rate.
3.  Make sure you estimate for each step in the process, not just the initial development. This is includes but is not limited to Code Review, QA, Subagent work, The planning, the execution, the merge, and the deployment. 
4. Multiply each bucket by its rate and sum. This is arithmetic, so compute it, do not eyeball it (deterministic space).
5. Round to the nearest $0.01.

**Model assumption:** price the estimate at the plan's recommended model (see "Model recommendation" below); when no recommendation exists (ad-hoc estimates outside the ticket flow), default to Opus 4.8 at `xhigh` effort. Reference prices per 1M tokens â verify current published rates before pricing a model not listed here.

- Fable 5: input $10.00, output $50.00, cached input reads ~$1.00
- Opus 4.8: input $5.00, output $25.00, cached input reads ~$0.50
- Sonnet 4.5: input $3.00, output $15.00, cached input reads ~$0.30
- Haiku 4.5: input $1.00, output $5.00, cached input reads ~$0.10

If these rates have not been updated in the last 14 days, check the current rates and update them if needed. 

**Buffer:** roughly +30% for a normal feature, +50% to +100% for a multi-ticket epic or unfamiliar code.

**Record it:** every ticket estimate is written to the ticket's Estimate field on the Projects board (a plain number = dollars, e.g. 3.75), the recommended model to the "Model" field and the recommended level of effort to the "Model Effort" field not just stated in the plan comment. 

**Model recommendation:** every ticket plan names the Claude model and the level of effort to execute with â the most cost-efficient model that finishes the ticket with a minimal number of issues. Cost efficiency includes rework: a cheaper model that produces bugs, review churn, or a second attempt costs more than the tier it saved, so when in doubt between two tiers, pick the higher one. Rules of thumb:

- **Haiku** â mechanical, tightly-specified, low-blast-radius work: renames, config/doc updates, small isolated fixes already pinned by existing tests.
- **Sonnet** â standard single-service features on familiar patterns, with a clear spec and a test harness that catches mistakes cheaply.
- **Opus** â cross-service or schema/engine/migration work, security-sensitive code, ambiguous specs, gnarly debugging, or anything where a botched attempt is expensive to unwind.
- **Fable** â the hardest tickets, where even Opus is likely to need a second attempt: epic-level architecture, subtle correctness-critical engine/allocation math, deep multi-service refactors, or debugging that has already defeated a lower tier. At 2x Opus pricing it earns its cost only when one clean pass replaces two.

State the recommendation and a one-line why next to the estimate in the plan comment; add the Model, Effort and Estimate into their respective fields. Add how much $ was consumed in doing this to the "Actual" field.


## The Dev Loop 

**Planning pass** (whenever issues sit in Agent Ready):

Global rules, if at any time a ticket becomes blocked by errors, dependencies or other issues move to "Blocked" Status. **DO NOT LET THE LOOP GET STUCK AND BURN USELESS TOKENS!** If a worker is stuck for more than 10 min in a particular state, check to make sure if it is still alive.  If it is not, stop it and move the ticket to "Skipped" status with a note. If you can not figure out what a ticket is about or what you should be doing, comment the confusion in the ticket and move it to "Skipped" status. All programming protocol should be in place. 

1. For each issue in "Ready" status, validate there is an implementation plan grounded in the actual code: files/line refs, steps, tests + evals, risks. If the ticket changes user experience, the plan names the `docs/user-guide/` pages it must update. The plan MUST contain a `### Acceptance Criteria` section: concrete cases (setup â action â expected outcome) derived from the ticket, written before any implementation exists. The implementing session makes those cases pass as written; weakening, deleting, or skipping a planned case is a spec question to raise on the PR, never a silent edit. If there are any clarifications needed from a human being, comment them and move the ticket the "Questions" status.
2. If the ticket is just missing field values or needs minor changes enter plan mode and add those things. 
3. If a ticket doesn't have an acceptable plan then Enter Plan Mode and propose the plan for building out the ticket. Break the tickets into consumable chunks that do not need more than 400K tokens of context to complete. Take each chunk, file it as a subtask and put the order to complete them in the ticket. Identify any gates or dependencies that exist, search the "Backlog" or "Ready" state for them, create tickets if they don't exist, clearly define the order to develop and pull in any dependent tickets into the ready state for continued analysis. All interconnected tickets should be linked to one another. Identify what model should be used for development and place it in the "Model" Field. Add the plan as a comment. Place any questions for a human being in the comment and move it to the "Questions" status. Take how much you have spent using the token math and add it to the value in the "Actual" field.
4. Estimate the ticket with the rules found in **Estimation** section of Claude.md

**Develop:**

5. If there are any open questions or unknowns highlight them and move the ticket to "Questions" status. 
6. If there are comments from a human fold in the suggestions and rebuild the plan if it changed. **If his comments raise new questions, do not start.** Post them as `## Needs input â â¦`, move the ticket to "Questions" and stop. A ticket is only worked once every open question is answered.
7. Move every ticket in the work batch to **Building** up front, all at once, so the board shows the full committed queue. 
8. Complete them **one ticket at a time**; leverage worktree and to keep from agents stepping on each other. Order is my call, respecting dependencies. Ship the complete thing: tests + evals + docs in the same diff. If it will facilitate a better QA check and the work is related to one another, multiple tickets worth of work can exist in a single worktree. 
9. Any ticket changing what users see or do updates the affected `docs/user-guide/` pages in the same PR: prose, formula/step appendix when those surfaces change, and re-captured screenshots (`scripts/capture-user-guide.mjs`) when visuals move. Need input mid-flight: move the ticket back "Questions" and comment exactly what's needed.

**QA**
11. When development has concluded for a ticket move to "QA" and begin QA with the GStack /qa skill. Answer questions using your judgment. If a human is needed to make a judgment call, put the question as a comment into the ticket and move it to the "Questions" status. Make a note to the human to return the ticket back to the "QA" status when the question is answered. 
12. QA **one ticket at a time**; leverage worktree and to keep from agents stepping on each other. Order is my call, respecting dependencies. Have no more than 3 workers running at any given time.
14. If bugs are found send back to "Building" with notes on the issue and tell the orchestration the next ticket to work is the one that just arrived.
15. If on a second pass bugs are found or the builder is stuck on a bug, run the /investigate skill, put the findings in the ticket and send back to "Building" to be worked.
16. If on the third pass bugs are found, move to the "Blocked" status, note what was wrong, recommended next steps for the human to take and stop working the ticket. 
13. If a human answered a question, pick back up the ticket and continue work on it till it is ready for review.

**Review**
14. When QA is done open the PR, move to "Review" status. 
15. Review **one PR at a time**; this PR / Branch may contain multiple tickets. If it does then wait until all related tickets are in the "Review" step before beginning.
16. Run GStack /ship skill to begin a PR. Answer questions using your judgment. It reviews the diff in a FRESH headless context, blinded to the PR description and plan rationale; inputs are the ticket, the plan's `### Acceptance tests`, the diff, and a throwaway worktree of the head commit that it executes (typecheck + touched workspace tests). 
	- If configured run an Independent review using a second model
17. If a human is needed to make a judgment call, put the question as a comment into the ticket and move it to the "Questions" status. Make a note to the human to return the ticket back to the "Review" status when the question is answered. 

**Merge**
18. Once verified (typecheck, full suite, web build + full e2e where web changed, AND if configured an `## Independent review` run against the final head commit with every blocking finding fixed or explicitly waived with a reason in a PR comment; a new head commit means a new review run) run GStack /land-and-deploy. 
	- This should merge in dependency order. Stacked chains: merge the parent WITHOUT deleting its branch, retarget the child to main, merge, delete branches last (deleting a base branch closes dependent PRs). Resolve conflicts on the branch with the full gauntlet before merging. After the batch lands, re-validate merged main end to end.
20. After deployment, move the ticket to "Done" and post a completion-note with what shipped (behavior + key files/PR), which `### Acceptance tests` passed, and â called out explicitly â any **edges a human must validate**: behaviors that are intended-but-surprising, data-loss-ish, spec-ambiguous, or where a default was chosen. Give concrete "to check X, do Y, expect Z" steps for each edge so validation is fast.
19. **File a new ticket for every use case that surfaced during the work and needs a human's decision** (a gap, an out-of-scope affordance the plan flagged, a limitation a user will hit), add it to the board (Backlog), and link it in the completion-notes comment. Do this for every ticket entering "Done"; do not silently drop a surfaced use case.
20. Add the actual dollar amount spent that has not already been accounted for to the actual field and move it to the "Done" status, leaving the ticket open.
21. A human will review the open tickets in "Done" and close them. A bounced ticket (his comment says what's wrong) goes back to "Ready" as rework.