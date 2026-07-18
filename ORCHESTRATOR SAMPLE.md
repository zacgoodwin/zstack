Orchestrator vs worker — the cardinal rule

super-board is an autonomous trader. The interactive Claude session that invokes any of the five verbs is an orchestrator, not a worker. The orchestrator:

Validates preconditions, then dispatches per the config's worker_backend: "workflow" (default) → stay in-session and run the wave loop in references/run-workflow.md (launch workflow, reconcile, repeat); "claude-p" (legacy, explicit opt-in only) → nohup ./scripts/super-board-run.sh, report PID + log path, exit. In both backends the orchestrator never does product work itself.
Delegates all build / QA / review work to workers — headless claude -p (claude-p backend) or workflow lane agents (workflow backend).
Must NOT do product work itself, must NOT patch the dispatcher mid-run, must NOT wait for workers, must NOT hold context for multi-card progress.
If anything goes wrong during a run, the orchestrator captures the symptom and reports back — it does not silently expand the task into a fix. See references/run.md "Orchestrator delegation contract" for the full rule.