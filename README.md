# personal-coding-agent

Pi.dev autonomous orchestrator setup for spec -> implement -> review/fix -> validation -> final report.
Reviewer agent is configured to own git integration: commit/push, CI status checks, and PR updates.
Spec generation, implementation, and review are dispatcher-based: Pi subagents call external `codex`/`amp` CLIs instead of directly doing those steps.

## Included

- Project-local extension: `.pi/extensions/pi-orchestrator/index.ts`
- Project-local role agents:
  - `.pi/agents/spec-writer.md`
  - `.pi/agents/codex-impl.md`
  - `.pi/agents/amp-impl.md`
  - `.pi/agents/reviewer.md`
  - `.pi/agents/validator.md`
  - `.pi/agents/reporter.md`

## Usage in Pi

1. Open this repo in `pi`.
2. Run `/reload` so project-local extensions/agents are loaded.
3. Start an autonomous task:
   - `/orchestrate <repo-path> -- <your full task>`
4. Check progress:
   - `/orchestrate-status`
   - `/orchestrate-log <task-id>`
   - `/orchestrate-trace <task-id>`
   - `/orchestrate-tail <task-id>`
   - `/orchestrate-widget <compact|spec|prompt|result|history|stream>`
   - live widget now shows:
     - spec file path + preview
     - active subagent + purpose
     - prompt file path + prompt preview
     - result file path
     - dispatched subagent command preview
     - real-time streamed events from delegated agents (`stream` mode)
5. Resume a failed/interrupted task:
   - `/orchestrate-resume <task-id>`
6. Stop a running task:
   - `/orchestrate-stop <task-id>`

## Local Web UI

Run a local React dashboard for the orchestrator:

1. Install frontend dependencies:
   - `npm install`
2. Start the local Vite app:
   - `npm run webui:dev`
3. Open:
   - `http://127.0.0.1:4173`

The dashboard reads task artifacts from `.pi/reports/` and `.pi/specs/`.
Running tasks are exposed via live snapshot files written to:
- `.pi/reports/<task-id>.state.json`
- `.pi/reports/<task-id>.progress.md`

## Outputs

- Central spec files: `.pi/specs/<task-id>.md`
- Final reports:
  - `.pi/reports/<task-id>.json`
  - `.pi/reports/<task-id>.state.json` (live task snapshot for local UI)
  - `.pi/reports/<task-id>.md`
  - `.pi/reports/<task-id>.live.log` (stage-by-stage plus stream events)
  - `.pi/reports/<task-id>.trace/` (exact subagent prompts/results + per-call meta)
- Per-task isolated worktrees:
  - `.pi/worktrees/<task-id>/`

## GitHub PR requirements

For automatic PR creation, ensure the environment has:
- `gh` installed
- authenticated session (`gh auth status` should pass)
- git remote configured and push access

## Dispatcher requirements

For delegated implementation/review to work:
- `codex` CLI must be installed and available in `PATH`
- `amp` CLI must be installed and available in `PATH`

Dispatcher prompt templates are stored in:
- `.pi/delegation-prompts/`
  - `codex-spec-dispatch.md`
  - `codex-implementation-dispatch.md`
  - `amp-implementation-dispatch.md`
  - `codex-review-dispatch.md`

The orchestrator is agent-directed:
- control flow comes from `handoff` and `finish` tool calls
- free-form prose is for humans, not routing
- dispatcher agents must delegate coding/review work to `codex` or `amp`, not implement directly
- stage agents use a narrow tool protocol:
  - `write_prompt`
  - `dispatch_coding_agent`
  - `append_progress`
  - `handoff`
  - `finish`
  - `report_bug_in_workflow`

Shared run context:
- `.pi/reports/<task-id>.progress.md` is the compact shared memory for the run
- it is passed into every stage-agent prompt
- it is also passed into delegated `codex` / `amp` prompts
- detailed transfer context still belongs in handoff messages

Review policy:
- P0/P1 findings are always blocking.
- P2/P3-only findings can be triaged by the implementation dispatcher, which may defer them and continue to validation.
- Max review iterations per task: 3.
- Reviewer attempts to reuse the same Codex review session (`codex_session_id`) for continuity.

Runtime prompt guardrails injected into every subagent system prompt:
- repository root path and active worktree path
- explicit instruction to work only in the active worktree path
- active branch name
- explicit instruction not to clone the repo again

Repository path handling:
- `repoPath` is required up front via `/orchestrate <repo-path> -- <task>`
- the path must resolve to a git repository root
- that path is written into task state and into the generated spec metadata
- all later stages read from task state, not transient cwd

Context continuity between agents:
- Spec text is passed directly into implementation/review/validation prompts.
- Review and validation also receive previous stage summaries.
- Reviewer can reuse a persistent `codex_session_id` for continuity across review loops.

## Runtime controls

- `PI_ORCHESTRATOR_SUBAGENT_TIMEOUT_MS` (optional):
  - max runtime per subagent call in milliseconds
  - default: `900000` (15 minutes)

## Main Agent Callback (optional)

Set env var `PI_MAIN_AGENT_WEBHOOK_URL` before starting `pi` to receive a final POST payload when a task completes.

## Model: MiniMax-M2.5

All orchestrator role agents are configured to use `MiniMax-M2.5`.

Configure the model provider in:
- `~/.pi/agent/models.json`

Example:

```json
{
  "providers": {
    "minimax": {
      "baseUrl": "https://api.minimax.io/v1",
      "api": "openai-completions",
      "apiKey": "MINIMAX_API_KEY",
      "models": [
        {
          "id": "MiniMax-M2.5",
          "name": "MiniMax M2.5",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 204800,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Set the API key in your shell before running `pi`:

```bash
export MINIMAX_API_KEY="your_minimax_api_key"
```
