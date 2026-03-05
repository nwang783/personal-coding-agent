# personal-coding-agent

Pi.dev autonomous orchestrator setup for spec -> implement -> review/fix -> validation -> final report.
Implementation agents are also configured to create GitHub PRs with `gh` when feasible.
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
   - `/orchestrate <your full task>`
4. Check progress:
   - `/orchestrate-status`
   - `/orchestrate-log <task-id>`
   - `/orchestrate-trace <task-id>`
   - `/orchestrate-widget <compact|spec|prompt|result|history>`
   - live widget now shows:
     - spec file path + preview
     - active subagent + purpose
     - prompt file path + prompt preview
     - result file path
5. Resume a failed/interrupted task:
   - `/orchestrate-resume <task-id>`

## Outputs

- Central spec files: `.pi/specs/<task-id>.md`
- Final reports:
  - `.pi/reports/<task-id>.json`
  - `.pi/reports/<task-id>.md`
  - `.pi/reports/<task-id>.live.log` (stage-by-stage live progress)
  - `.pi/reports/<task-id>.trace/` (exact subagent prompts/results)

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

The orchestrator accepts normal natural-language responses from delegated agents.
JSON is optional; when present it is used directly, otherwise the orchestrator parses structured sections heuristically.
For deterministic control flow, delegated agents should include a tiny `DECISION` block:
- `status: approved | needs_changes | failed | passed`
- `blocking: yes | no`
- `loop_back_to: implementation | review | validation | none`
- `pr_url: <url or empty>`
Then they can use normal English in `DETAILS`.

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
