# Pi Orchestrator Extension

Autonomous dispatcher extension for Pi.dev:

1. `spec-writer` creates central spec.
2. Routes implementation to `codex-impl` or `amp-impl`.
3. `reviewer` enforces fix loop.
4. `validator` independently validates.
5. `reporter` generates final handoff report.

## Commands

- `/orchestrate <task>`
- `/orchestrate-status`
- `/orchestrate-resume <task-id>`

## Artifacts

- `.pi/specs/<task-id>.md`
- `.pi/reports/<task-id>.json`
- `.pi/reports/<task-id>.md`

## Optional callback

Set `PI_MAIN_AGENT_WEBHOOK_URL` to POST final run metadata to your main agent service.
