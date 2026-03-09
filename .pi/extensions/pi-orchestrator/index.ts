import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type TaskStatus = "queued" | "running" | "completed" | "failed";
type TaskStage = "received" | "spec" | "implementation" | "review" | "validation" | "reporting" | "done" | "failed";
type RuntimeAgent = "spec-writer" | "codex-impl" | "amp-impl" | "reviewer" | "validator" | "reporter";
type HandoffTarget = Exclude<RuntimeAgent, "spec-writer">;
type FailureKind =
	| "subprocess_error"
	| "timeout"
	| "missing_handoff"
	| "invalid_transition"
	| "protocol_violation"
	| "max_loops_exceeded"
	| "tool_error"
	| "workflow_bug_reported"
	| "stopped";
type WidgetMode = "compact" | "handoff" | "prompt" | "result" | "history" | "stream";

type ReviewFinding = {
	severity: "P0" | "P1" | "P2" | "P3";
	title: string;
	description: string;
	file?: string;
	line?: number;
};

type VerificationItem = {
	command: string;
	outcome: "passed" | "failed" | "not_run";
	details: string;
};

type CiCheck = {
	name: string;
	status: "passed" | "failed" | "pending" | "not_run";
	details: string;
};

type ArtifactBag = {
	branch?: string;
	commits?: string[];
	pr_url?: string | null;
	changed_files?: string[];
	findings?: ReviewFinding[];
	issues?: string[];
	verification?: VerificationItem[];
	codex_session_id?: string | null;
	ci_checks?: CiCheck[];
	[key: string]: unknown;
};

type HandoffPayload = {
	toAgent: HandoffTarget;
	message: string;
	summary: string;
	artifacts?: ArtifactBag;
	reason?: string;
};

type FinishPayload = {
	outcome: "completed" | "failed";
	summary: string;
	report: string;
	artifacts?: ArtifactBag;
};

type WorkflowBugPayload = {
	summary: string;
	details: string;
	terminate: boolean;
};

type HandoffRecord = {
	at: string;
	fromAgent: RuntimeAgent;
	toAgent: HandoffTarget;
	summary: string;
	message: string;
	reason?: string;
	artifacts?: ArtifactBag;
};

type EventRecord =
	| {
			type: "task_started" | "task_resumed";
			at: string;
			taskId: string;
			repoPath: string;
			worktreePath?: string;
			worktreeBranch?: string;
	  }
	| {
			type: "agent_started";
			at: string;
			taskId: string;
			agent: RuntimeAgent;
			stage: TaskStage;
			promptPath: string;
	  }
	| {
			type: "agent_completed";
			at: string;
			taskId: string;
			agent: RuntimeAgent;
			stage: TaskStage;
			resultPath: string;
			durationMs: number;
			exitCode: number;
			toolSignals: number;
	  }
	| {
			type: "handoff";
			at: string;
			taskId: string;
			fromAgent: RuntimeAgent;
			toAgent: HandoffTarget;
			summary: string;
			reason?: string;
	  }
	| {
			type: "finish";
			at: string;
			taskId: string;
			agent: RuntimeAgent;
			outcome: "completed" | "failed";
			summary: string;
	  }
	| {
			type: "failure";
			at: string;
			taskId: string;
			agent?: RuntimeAgent;
			kind: FailureKind;
			details: string;
	  };

type TaskState = {
	id: string;
	title: string;
	originalTask: string;
	repoPath: string;
	worktreePath?: string;
	worktreeBranch?: string;
	status: TaskStatus;
	stage: TaskStage;
	createdAt: string;
	updatedAt: string;
	specPath?: string;
	liveLogPath?: string;
	liveStatePath?: string;
	traceDir?: string;
	reportJsonPath?: string;
	reportMarkdownPath?: string;
	eventLogPath?: string;
	progressPath?: string;
	promptDraftPath?: string;
	reviewLoops: number;
	validationLoops: number;
	maxReviewLoops: number;
	maxValidationLoops: number;
	handoffCount: number;
	currentAgent?: RuntimeAgent;
	routedAgent?: "codex-impl" | "amp-impl";
	lastHandoff?: HandoffRecord;
	handoffHistory: HandoffRecord[];
	failureKind?: FailureKind;
	failureDetails?: string;
	lastBranchName?: string;
	lastCommitShas?: string[];
	lastPrUrl?: string;
	lastPrFailureReason?: string;
	codexReviewSessionId?: string;
	blockingFindings: ReviewFinding[];
	validationIssues: string[];
	lastVerification?: VerificationItem[];
	lastCiChecks?: CiCheck[];
	lastArtifacts?: ArtifactBag;
	finalReport?: string;
	history: Array<{ at: string; stage: TaskStage; note: string }>;
	traceSeq?: number;
	activeAgentName?: string;
	activeAgentPurpose?: string;
	lastPromptPath?: string;
	lastResultPath?: string;
	lastDispatchPromptPath?: string;
	lastDispatchResultPath?: string;
	lastSubagentCommand?: string;
	lastStreamEvent?: string;
	streamEvents?: Array<{ at: string; agent: string; purpose: string; kind: string; text: string }>;
	widgetMode?: WidgetMode;
};

type AgentConfig = {
	name: RuntimeAgent;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	filePath: string;
};

type ToolSignal =
	| { kind: "handoff"; payload: HandoffPayload }
	| { kind: "finish"; payload: FinishPayload }
	| { kind: "workflow_bug"; payload: WorkflowBugPayload };

type SubagentRun = {
	ok: boolean;
	exitCode: number;
	stderr: string;
	finalAssistantText: string;
	fullAssistantText: string;
	eventCount: number;
	toolEventCount: number;
	deltaCount: number;
	durationMs: number;
	timedOut: boolean;
	stopRequested: boolean;
	toolSignals: ToolSignal[];
};

const WIDGET_MODES: WidgetMode[] = ["compact", "handoff", "prompt", "result", "history", "stream"];
const ORCHESTRATOR_EXTENSION_PATH = "/Users/nathanwang/Projects/personal-coding-agent/.pi/extensions/pi-orchestrator/index.ts";

function nowIso(): string {
	return new Date().toISOString();
}

function expandHome(input: string): string {
	if (!input.startsWith("~")) return input;
	const home = process.env.HOME;
	if (!home) return input;
	if (input === "~") return home;
	if (input.startsWith("~/")) return path.join(home, input.slice(2));
	return input;
}

function isGitRepoRoot(candidate: string): boolean {
	try {
		const stat = fs.statSync(candidate);
		if (!stat.isDirectory()) return false;
		return fs.existsSync(path.join(candidate, ".git"));
	} catch {
		return false;
	}
}

function resolveRepoPath(repoInput: string, cwd: string): string | undefined {
	if (!repoInput.trim()) return undefined;
	const expanded = expandHome(repoInput.trim());
	const resolved = path.resolve(cwd, expanded);
	return isGitRepoRoot(resolved) ? resolved : undefined;
}

function parseOrchestrateArgs(
	args: string,
	cwd: string,
): { repoPath?: string; taskInput?: string; error?: string } {
	const raw = args.trim();
	const divider = raw.indexOf(" -- ");
	if (divider === -1) {
		return { error: "Usage: /orchestrate <repo-path> -- <task description>" };
	}
	const repoInput = raw.slice(0, divider).trim();
	const taskInput = raw.slice(divider + 4).trim();
	if (!repoInput || !taskInput) {
		return { error: "Usage: /orchestrate <repo-path> -- <task description>" };
	}
	const repoPath = resolveRepoPath(repoInput, cwd);
	if (!repoPath) {
		return { error: `Repository path must point to a git repo root: ${repoInput}` };
	}
	return { repoPath, taskInput };
}

function getSubagentTimeoutMs(): number {
	const raw = process.env.PI_ORCHESTRATOR_SUBAGENT_TIMEOUT_MS;
	const parsed = raw ? Number(raw) : NaN;
	if (Number.isFinite(parsed) && parsed > 0) return parsed;
	return 15 * 60 * 1000;
}

function getSubagentRuntimeCwd(): string {
	const dir = path.join(os.tmpdir(), "pi-orchestrator-runtime");
	ensureDir(dir);
	return dir;
}

function safeFilename(input: string): string {
	return input.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(filePath: string, data: unknown): void {
	ensureDir(path.dirname(filePath));
	const tmpPath = `${filePath}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
	fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, value: EventRecord): void {
	ensureDir(path.dirname(filePath));
	fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf-8");
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	if (!content.startsWith("---\n")) return { frontmatter: {}, body: content };
	const end = content.indexOf("\n---\n", 4);
	if (end === -1) return { frontmatter: {}, body: content };
	const raw = content.slice(4, end);
	const body = content.slice(end + 5);
	const frontmatter: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		frontmatter[key] = value;
	}
	return { frontmatter, body };
}

function loadProjectAgents(cwd: string): Map<string, AgentConfig> {
	const agentsDir = path.join(cwd, ".pi", "agents");
	const map = new Map<string, AgentConfig>();
	if (!fs.existsSync(agentsDir)) return map;
	for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const filePath = path.join(agentsDir, entry.name);
		const raw = fs.readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter(raw);
		if (!frontmatter.name) continue;
		const tools = frontmatter.tools
			?.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean);
		map.set(frontmatter.name, {
			name: frontmatter.name as RuntimeAgent,
			description: frontmatter.description ?? "",
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body.trim(),
			filePath,
		});
	}
	return map;
}

function getStageForAgent(agent: RuntimeAgent): TaskStage {
	switch (agent) {
		case "spec-writer":
			return "spec";
		case "codex-impl":
		case "amp-impl":
			return "implementation";
		case "reviewer":
			return "review";
		case "validator":
			return "validation";
		case "reporter":
			return "reporting";
	}
}

function allowedTargetsForAgent(agent: RuntimeAgent): HandoffTarget[] {
	switch (agent) {
		case "spec-writer":
			return ["codex-impl", "amp-impl"];
		case "codex-impl":
		case "amp-impl":
			return ["reviewer"];
		case "reviewer":
			return ["codex-impl", "amp-impl", "validator"];
		case "validator":
			return ["codex-impl", "amp-impl", "reporter"];
		case "reporter":
			return [];
	}
}

function parseArtifacts(value: unknown): ArtifactBag | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as ArtifactBag;
}

function parseHandoffPayload(args: Record<string, unknown>): HandoffPayload {
	return {
		toAgent: String(args.to_agent ?? "") as HandoffTarget,
		message: String(args.message ?? ""),
		summary: String(args.summary ?? ""),
		artifacts: parseArtifacts(args.artifacts),
		reason: args.reason ? String(args.reason) : undefined,
	};
}

function parseFinishPayload(args: Record<string, unknown>): FinishPayload {
	return {
		outcome: String(args.outcome ?? "") as FinishPayload["outcome"],
		summary: String(args.summary ?? ""),
		report: String(args.report ?? ""),
		artifacts: parseArtifacts(args.artifacts),
	};
}

function parseWorkflowBugPayload(args: Record<string, unknown>): WorkflowBugPayload {
	return {
		summary: String(args.summary ?? ""),
		details: String(args.details ?? ""),
		terminate: Boolean(args.terminate),
	};
}

function previewFile(filePath: string | undefined, maxLines: number, maxCharsPerLine = 140): string[] {
	if (!filePath || !fs.existsSync(filePath)) return [];
	try {
		return fs
			.readFileSync(filePath, "utf-8")
			.split("\n")
			.slice(0, maxLines)
			.map((line) => (line.length > maxCharsPerLine ? `${line.slice(0, maxCharsPerLine - 3)}...` : line));
	} catch {
		return [];
	}
}

function parseStreamEventsFromLiveLog(
	liveLogPath: string,
	limit: number,
): Array<{ at: string; agent: string; purpose: string; kind: string; text: string }> {
	if (!fs.existsSync(liveLogPath)) return [];
	try {
		const lines = fs.readFileSync(liveLogPath, "utf-8").split("\n").filter(Boolean);
		const out: Array<{ at: string; agent: string; purpose: string; kind: string; text: string }> = [];
		for (const line of lines) {
			const match = line.match(/^(\d{4}-\d{2}-\d{2}T[^ ]+)\s+\[stream:([a-zA-Z0-9._-]+):([a-zA-Z0-9._-]+)\]\s+([\s\S]+)$/);
			if (!match) continue;
			out.push({
				at: match[1],
				agent: match[2],
				purpose: "",
				kind: match[3],
				text: match[4].trim(),
			});
		}
		return out.slice(-limit);
	} catch {
		return [];
	}
}

function getLiveLogPath(cwd: string, state: TaskState): string {
	if (state.liveLogPath) return state.liveLogPath;
	const reportDir = path.join(cwd, ".pi", "reports");
	ensureDir(reportDir);
	state.liveLogPath = path.join(reportDir, `${safeFilename(state.id)}.live.log`);
	return state.liveLogPath;
}

function getLiveStatePath(cwd: string, state: TaskState): string {
	if (state.liveStatePath) return state.liveStatePath;
	const reportDir = path.join(cwd, ".pi", "reports");
	ensureDir(reportDir);
	state.liveStatePath = path.join(reportDir, `${safeFilename(state.id)}.state.json`);
	return state.liveStatePath;
}

function getTraceDir(cwd: string, state: TaskState): string {
	if (state.traceDir) return state.traceDir;
	const reportDir = path.join(cwd, ".pi", "reports");
	ensureDir(reportDir);
	state.traceDir = path.join(reportDir, `${safeFilename(state.id)}.trace`);
	ensureDir(state.traceDir);
	return state.traceDir;
}

function getEventLogPath(cwd: string, state: TaskState): string {
	if (state.eventLogPath) return state.eventLogPath;
	const reportDir = path.join(cwd, ".pi", "reports");
	ensureDir(reportDir);
	state.eventLogPath = path.join(reportDir, `${safeFilename(state.id)}.events.jsonl`);
	return state.eventLogPath;
}

function getProgressPath(cwd: string, state: TaskState): string {
	if (state.progressPath) return state.progressPath;
	const reportDir = path.join(cwd, ".pi", "reports");
	ensureDir(reportDir);
	state.progressPath = path.join(reportDir, `${safeFilename(state.id)}.progress.md`);
	if (!fs.existsSync(state.progressPath)) {
		fs.writeFileSync(state.progressPath, "# Progress\n\n", "utf-8");
	}
	return state.progressPath;
}

function readProgress(state: TaskState): string {
	const progressPath = getProgressPath(state.repoPath, state);
	return fs.existsSync(progressPath) ? fs.readFileSync(progressPath, "utf-8") : "# Progress\n\n";
}

function appendProgressEntry(state: TaskState, agent: RuntimeAgent, entry: string): void {
	const trimmed = entry.trim().replace(/\s+/g, " ");
	if (!trimmed) return;
	const progressPath = getProgressPath(state.repoPath, state);
	const line = `- ${agent}: ${trimmed.slice(0, 240)}\n`;
	fs.appendFileSync(progressPath, line, "utf-8");
}

function getPromptDraftPath(cwd: string, state: TaskState): string {
	if (state.promptDraftPath) return state.promptDraftPath;
	const reportDir = path.join(cwd, ".pi", "reports");
	ensureDir(reportDir);
	state.promptDraftPath = path.join(reportDir, `${safeFilename(state.id)}.prompt-draft.md`);
	return state.promptDraftPath;
}

function writePromptDraft(state: TaskState, content: string): string {
	const promptPath = getPromptDraftPath(state.repoPath, state);
	fs.writeFileSync(promptPath, content, "utf-8");
	return promptPath;
}

function readPromptDraft(state: TaskState): string {
	const promptPath = getPromptDraftPath(state.repoPath, state);
	return fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf-8") : "";
}

function getStopRequestPath(cwd: string, state: TaskState): string {
	const reportDir = path.join(cwd, ".pi", "reports");
	ensureDir(reportDir);
	return path.join(reportDir, `${safeFilename(state.id)}.stop`);
}

function hasStopRequest(cwd: string, state: TaskState): boolean {
	return fs.existsSync(getStopRequestPath(cwd, state));
}

function writeStopRequest(cwd: string, state: TaskState, reason: string): void {
	fs.writeFileSync(getStopRequestPath(cwd, state), `${reason}\n`, "utf-8");
}

function clearStopRequest(cwd: string, state: TaskState): void {
	const stopPath = getStopRequestPath(cwd, state);
	if (fs.existsSync(stopPath)) fs.unlinkSync(stopPath);
}

function appendHistory(state: TaskState, stage: TaskStage, note: string): void {
	state.stage = stage;
	state.updatedAt = nowIso();
	state.history.push({ at: state.updatedAt, stage, note });
}

function persistTask(pi: ExtensionAPI, state: TaskState): void {
	pi.appendEntry("pi-orchestrator-task", state);
	writeJsonAtomic(getLiveStatePath(state.repoPath, state), state);
}

function recordEvent(state: TaskState, event: EventRecord): void {
	appendJsonl(getEventLogPath(state.repoPath, state), event);
}

function refreshLiveUi(ctx: ExtensionContext, state: TaskState): void {
	const th = ctx.ui.theme;
	const currentWidgetMode = readWidgetMode(state.repoPath, state.worktreePath, ctx.cwd);
	state.widgetMode = currentWidgetMode;
	const liveLogPath = getLiveLogPath(state.repoPath, state);
	if (!state.streamEvents || state.streamEvents.length === 0) {
		state.streamEvents = parseStreamEventsFromLiveLog(liveLogPath, 80);
	}
	const latest = state.history[state.history.length - 1];
	const statusColor = state.status === "completed" ? "success" : state.status === "failed" ? "error" : "accent";
	const header = [
		th.fg("accent", "Pi Orchestrator"),
		`${th.fg("muted", "Status")} ${th.fg(statusColor, state.status)}  ${th.fg("muted", "Stage")} ${th.fg("warning", state.stage)}`,
		`${th.fg("muted", "Agent")} ${th.fg("success", state.currentAgent ?? state.activeAgentName ?? "idle")}`,
		`${th.fg("muted", "Loops")} R ${state.reviewLoops}/${state.maxReviewLoops} | V ${state.validationLoops}/${state.maxValidationLoops}`,
		`${th.fg("muted", "Handoffs")} ${state.handoffCount}`,
	];
	const body: string[] = [];
	if (currentWidgetMode === "handoff") {
		const handoff = state.lastHandoff;
		body.push(
			th.fg("muted", "Latest handoff:"),
			`  ${handoff ? `${handoff.fromAgent} -> ${handoff.toAgent}` : "(none yet)"}`,
			`  ${handoff?.summary ?? ""}`,
			...(handoff?.message ? handoff.message.split("\n").slice(0, 6).map((line) => `  ${line}`) : []),
		);
	} else if (currentWidgetMode === "prompt") {
		body.push(...buildPanelPreview("Prompt", state.lastPromptPath, 6, th));
	} else if (currentWidgetMode === "result") {
		body.push(...buildPanelPreview("Result", state.lastResultPath, 6, th));
	} else if (currentWidgetMode === "history") {
		body.push(
			th.fg("muted", "History:"),
			...state.history.slice(-8).map((entry) => `${th.fg("dim", entry.at)} ${th.fg("warning", `[${entry.stage}]`)} ${entry.note}`),
		);
	} else if (currentWidgetMode === "stream") {
		body.push(
			th.fg("muted", "Agent stream:"),
			...(state.streamEvents ?? []).slice(-8).map((event) => `${th.fg("dim", event.at.slice(11, 19))} ${th.fg("success", `[${event.agent}]`)} ${th.fg("warning", event.kind)} ${event.text}`),
		);
	} else {
		body.push(
			`${th.fg("muted", "Current")} ${state.currentAgent ?? "idle"}`,
			`${th.fg("muted", "Last note")} ${latest?.note ?? "(none)"}`,
			`${th.fg("muted", "Failure")} ${state.failureKind ? `${state.failureKind}: ${state.failureDetails ?? ""}` : "none"}`,
			`${th.fg("muted", "Last handoff")} ${state.lastHandoff ? `${state.lastHandoff.fromAgent} -> ${state.lastHandoff.toAgent}` : "(none)"}`,
		);
	}
	ctx.ui.setStatus(
		"pi-orchestrator",
		`${th.fg(statusColor, `Task ${state.id}`)} ${th.fg("muted", `${state.status} ${state.stage}${latest ? ` | ${latest.note}` : ""}`)}`,
	);
	ctx.ui.setWidget("pi-orchestrator-progress", [...header, "", ...body]);
	ctx.ui.setWidget("pi-orchestrator-actions", [th.fg("muted", `Quick: /orchestrate-log ${state.id} | /orchestrate-trace ${state.id} | /orchestrate-tail ${state.id}`)], {
		placement: "belowEditor",
	});
}

function buildPanelPreview(
	title: string,
	filePath: string | undefined,
	lines: number,
	th: ExtensionContext["ui"]["theme"],
): string[] {
	const out: string[] = [];
	out.push(th.fg("muted", `${title}:`));
	out.push(`  ${th.fg("accent", filePath ?? "(none)")}`);
	if (filePath) {
		for (const line of previewFile(filePath, lines, 110)) out.push(`  ${line}`);
	}
	return out;
}

function recordProgress(pi: ExtensionAPI, ctx: ExtensionContext, state: TaskState, stage: TaskStage, note: string): void {
	appendHistory(state, stage, note);
	persistTask(pi, state);
	fs.appendFileSync(getLiveLogPath(state.repoPath, state), `${state.updatedAt} [${stage}] ${note}\n`, "utf-8");
	refreshLiveUi(ctx, state);
}

function parseWidgetMode(raw: string | undefined): WidgetMode | undefined {
	if (!raw) return undefined;
	const mode = raw.trim().toLowerCase() as WidgetMode;
	return WIDGET_MODES.includes(mode) ? mode : undefined;
}

function getWidgetModePath(repoPath: string): string {
	const reportDir = path.join(repoPath, ".pi", "reports");
	ensureDir(reportDir);
	return path.join(reportDir, "orchestrator-widget-mode.txt");
}

function readWidgetMode(repoPath: string, worktreePath?: string, fallbackCwd?: string): WidgetMode {
	const envMode = parseWidgetMode(process.env.PI_ORCHESTRATOR_WIDGET_MODE);
	if (envMode) return envMode;
	for (const base of [repoPath, worktreePath, fallbackCwd].filter((value): value is string => Boolean(value))) {
		try {
			const raw = fs.readFileSync(getWidgetModePath(base), "utf-8");
			const parsed = parseWidgetMode(raw);
			if (parsed) return parsed;
		} catch {
			// ignore
		}
	}
	return "compact";
}

function writeWidgetMode(mode: WidgetMode, repoPaths: string[]): void {
	process.env.PI_ORCHESTRATOR_WIDGET_MODE = mode;
	for (const repoPath of repoPaths) {
		fs.writeFileSync(getWidgetModePath(repoPath), `${mode}\n`, "utf-8");
	}
}

async function ensureTaskWorktree(pi: ExtensionAPI, state: TaskState): Promise<void> {
	const worktreesRoot = path.join(state.repoPath, ".pi", "worktrees");
	ensureDir(worktreesRoot);
	if (!state.worktreePath) state.worktreePath = path.join(worktreesRoot, safeFilename(state.id));
	if (!state.worktreeBranch) state.worktreeBranch = `pi/${safeFilename(state.id).slice(0, 52)}`;
	const existingGit = path.join(state.worktreePath, ".git");
	if (!fs.existsSync(existingGit)) {
		ensureDir(path.dirname(state.worktreePath));
		const addResult = await pi.exec("git", ["-C", state.repoPath, "worktree", "add", "-b", state.worktreeBranch, state.worktreePath, "HEAD"], {
			timeout: 120_000,
		});
		if (addResult.code !== 0) {
			const retry = await pi.exec("git", ["-C", state.repoPath, "worktree", "add", state.worktreePath, state.worktreeBranch], {
				timeout: 120_000,
			});
			if (retry.code !== 0) {
				throw new Error(`Failed to create worktree: ${addResult.stderr || retry.stderr || "unknown git error"}`);
			}
		}
	}
	const branchResult = await pi.exec("git", ["-C", state.worktreePath, "branch", "--show-current"], { timeout: 10_000 });
	if (branchResult.code === 0 && branchResult.stdout.trim()) {
		state.worktreeBranch = branchResult.stdout.trim();
	}
}

function validateToolSignal(fromAgent: RuntimeAgent, signal: ToolSignal): string | undefined {
	if (signal.kind === "handoff") {
		const { toAgent, message, summary } = signal.payload;
		if (!allowedTargetsForAgent(fromAgent).includes(toAgent)) {
			return `Invalid handoff target "${toAgent}" from ${fromAgent}`;
		}
		if (!message.trim()) return "Handoff message is required";
		if (!summary.trim()) return "Handoff summary is required";
		return undefined;
	}
	if (signal.kind === "workflow_bug") {
		if (!signal.payload.summary.trim()) return "Workflow bug summary is required";
		if (!signal.payload.details.trim()) return "Workflow bug details are required";
		return undefined;
	}
	const { outcome, summary, report } = signal.payload;
	if (fromAgent !== "reviewer" && fromAgent !== "validator" && fromAgent !== "reporter") {
		return `Agent ${fromAgent} cannot finish the workflow`;
	}
	if (outcome !== "completed" && outcome !== "failed") return `Invalid finish outcome "${outcome}"`;
	if (!summary.trim()) return "Finish summary is required";
	if (!report.trim()) return "Finish report is required";
	if (fromAgent === "reviewer" && outcome === "completed") {
		return `${fromAgent} cannot complete the workflow directly`;
	}
	return undefined;
}

function resolveToolSignal(
	fromAgent: RuntimeAgent,
	signals: ToolSignal[],
): { signal?: ToolSignal; warning?: string; error?: string } {
	if (signals.length === 0) {
		return { error: `Agent ${fromAgent} exited without handoff or finish` };
	}
	const validSignals: ToolSignal[] = [];
	for (const signal of signals) {
		const validationError = validateToolSignal(fromAgent, signal);
		if (!validationError) validSignals.push(signal);
	}
	if (validSignals.length === 0) {
		return { error: `Agent ${fromAgent} emitted only invalid terminal tool signals` };
	}
	const preferredKind = fromAgent === "reporter" ? "finish" : "handoff";
	const preferredSignal = validSignals.find((signal) => signal.kind === preferredKind);
	const signal = preferredSignal ?? validSignals[0];
	if (validSignals.length > 1 || signals.length > 1) {
		return {
			signal,
			warning: `Agent ${fromAgent} emitted multiple terminal tool signals; using ${signal.kind} and ignoring the rest`,
		};
	}
	return { signal };
}

function applyArtifactsToState(state: TaskState, artifacts: ArtifactBag | undefined): void {
	if (!artifacts) return;
	state.lastArtifacts = artifacts;
	if (artifacts.branch) {
		state.lastBranchName = String(artifacts.branch);
	}
	if (Array.isArray(artifacts.commits)) {
		state.lastCommitShas = artifacts.commits.map((value) => String(value));
	}
	if ("pr_url" in artifacts) {
		state.lastPrUrl = artifacts.pr_url ? String(artifacts.pr_url) : undefined;
	}
	if (Array.isArray(artifacts.findings)) {
		state.blockingFindings = artifacts.findings;
	}
	if (Array.isArray(artifacts.issues)) {
		state.validationIssues = artifacts.issues.map((issue) => String(issue));
	}
	if (Array.isArray(artifacts.verification)) {
		state.lastVerification = artifacts.verification as VerificationItem[];
	}
	if (Array.isArray(artifacts.ci_checks)) {
		state.lastCiChecks = artifacts.ci_checks as CiCheck[];
	}
	if ("codex_session_id" in artifacts) {
		state.codexReviewSessionId = artifacts.codex_session_id ? String(artifacts.codex_session_id) : undefined;
	}
}

function buildSpecMarkdown(state: TaskState, handoff: HandoffRecord): string {
	return [
		`# Spec: ${state.title}`,
		"",
		`- Task ID: ${state.id}`,
		`- Created: ${state.createdAt}`,
		`- Updated: ${state.updatedAt}`,
		`- Repository Root: ${state.repoPath}`,
		`- Worktree Path: ${state.worktreePath ?? "n/a"}`,
		`- Worktree Branch: ${state.worktreeBranch ?? "n/a"}`,
		`- Routed Implementation Agent: ${handoff.toAgent}`,
		`- Summary: ${handoff.summary}`,
		"",
		"## Handoff Message",
		handoff.message,
		"",
	].join("\n");
}

function buildReportMarkdown(state: TaskState): string {
	return [
		`# Pi Orchestrator Report: ${state.title}`,
		"",
		`- Task ID: ${state.id}`,
		`- Final Status: ${state.status.toUpperCase()}`,
		`- Final Stage: ${state.stage}`,
		`- Repository Root: ${state.repoPath}`,
		`- Worktree Path: ${state.worktreePath ?? "n/a"}`,
		`- Worktree Branch: ${state.worktreeBranch ?? "n/a"}`,
		`- Progress File: ${state.progressPath ?? "n/a"}`,
		`- Current Agent: ${state.currentAgent ?? "n/a"}`,
		`- Branch: ${state.lastBranchName ?? "n/a"}`,
		`- Pull Request: ${state.lastPrUrl ?? "n/a"}`,
		`- Review Loops: ${state.reviewLoops}/${state.maxReviewLoops}`,
		`- Validation Loops: ${state.validationLoops}/${state.maxValidationLoops}`,
		`- Handoffs: ${state.handoffCount}`,
		"",
		"## Handoffs",
		...(state.handoffHistory.length > 0
			? state.handoffHistory.map((handoff) => `- ${handoff.at} | ${handoff.fromAgent} -> ${handoff.toAgent} | ${handoff.summary}`)
			: ["- None"]),
		"",
		"## Blocking Findings",
		...(state.blockingFindings.length > 0
			? state.blockingFindings.map((finding) => `- [${finding.severity}] ${finding.title}: ${finding.description}`)
			: ["- None"]),
		"",
		"## Validation Issues",
		...(state.validationIssues.length > 0 ? state.validationIssues.map((issue) => `- ${issue}`) : ["- None"]),
		"",
		"## Progress",
		readProgress(state),
		"",
		"## Final Report",
		state.finalReport?.trim() || "No final report captured.",
		"",
	].join("\n");
}

function saveFinalArtifacts(state: TaskState): void {
	const reportDir = path.join(state.repoPath, ".pi", "reports");
	ensureDir(reportDir);
	const jsonPath = path.join(reportDir, `${safeFilename(state.id)}.json`);
	const mdPath = path.join(reportDir, `${safeFilename(state.id)}.md`);
	fs.writeFileSync(jsonPath, JSON.stringify(state, null, 2), "utf-8");
	fs.writeFileSync(mdPath, buildReportMarkdown(state), "utf-8");
	state.reportJsonPath = jsonPath;
	state.reportMarkdownPath = mdPath;
}

type DispatchCodingResult = {
	ok: boolean;
	provider: "codex" | "amp";
	taskKind: "spec" | "implementation" | "review" | "validation";
	exitCode: number;
	timedOut: boolean;
	durationMs: number;
	finalAssistantText: string;
	fullAssistantText: string;
	stderr: string;
	sessionId?: string;
	promptPath: string;
	resultPath: string;
};

async function dispatchCodingRun(
	state: TaskState,
	agentName: RuntimeAgent,
	provider: "codex" | "amp",
	taskKind: "spec" | "implementation" | "review" | "validation",
	resumeSessionId?: string,
): Promise<DispatchCodingResult> {
	const promptBody = readPromptDraft(state).trim();
	if (!promptBody) {
		throw new Error("No prompt draft available. Call write_prompt before dispatch_coding_agent.");
	}
	const traceDir = getTraceDir(state.repoPath, state);
	const stem = `${Date.now()}-${safeFilename(agentName)}-${provider}-${taskKind}-dispatch`;
	const promptPath = path.join(traceDir, `${stem}.delegated.prompt.md`);
	const resultPath = path.join(traceDir, `${stem}.delegated.result.md`);
	const progress = readProgress(state);
	const fullPrompt = [
		`Repository root path: ${state.repoPath}`,
		`Active worktree path: ${state.worktreePath ?? state.repoPath}`,
		`Active git branch: ${state.worktreeBranch ?? "(unknown)"}`,
		"All edits and git actions must happen only in the active worktree path.",
		"Do not inspect or modify sibling repos or any other checkout on disk.",
		"",
		"Current run progress:",
		progress.trim(),
		"",
		"Task payload:",
		promptBody,
		"",
	].join("\n");
	fs.writeFileSync(promptPath, fullPrompt, "utf-8");
	state.lastDispatchPromptPath = promptPath;
	const started = Date.now();
	const timeoutMs = getSubagentTimeoutMs();
	const execArgs =
		provider === "codex"
			? resumeSessionId
				? ["exec", "resume", resumeSessionId, "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--json", "-",]
				: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--json", "-"]
			: ["--dangerously-allow-all", "-x", "--stream-json"];
	const command = provider === "codex" ? "codex" : "amp";
	const result = await new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
		const stdin = fs.readFileSync(promptPath, "utf-8");
		const child = spawn(command, execArgs, {
			cwd: state.worktreePath ?? state.repoPath,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5_000);
		}, timeoutMs);
		child.stdin.write(stdin);
		child.stdin.end();
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolve({ code: code ?? 1, stdout, stderr, timedOut });
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut });
		});
	});
	const output = result.stdout.trim();
	fs.writeFileSync(resultPath, output || result.stderr || "(empty)", "utf-8");
	state.lastDispatchResultPath = resultPath;
	let finalAssistantText = output;
	let sessionId: string | undefined;
	if (provider === "codex") {
		const chunks = output.split("\n").filter(Boolean);
		const messages: string[] = [];
		for (const line of chunks) {
			try {
				const event = JSON.parse(line) as Record<string, unknown>;
				if (event.type === "thread.started") sessionId = String(event.thread_id ?? "");
				if (event.type === "message_end") {
					const msg = event.message as Record<string, unknown> | undefined;
					const content = msg?.content as Array<Record<string, unknown>> | undefined;
					if (content) {
						const text = content.filter((item) => item.type === "text").map((item) => String(item.text ?? "")).join("\n").trim();
						if (text) messages.push(text);
					}
				}
			} catch {
				// ignore
			}
		}
		if (messages.length > 0) finalAssistantText = messages[messages.length - 1];
	}
	return {
		ok: result.code === 0 && !result.timedOut,
		provider,
		taskKind,
		exitCode: result.code,
		timedOut: result.timedOut,
		durationMs: Date.now() - started,
		finalAssistantText: finalAssistantText || "(empty)",
		fullAssistantText: output || "(empty)",
		stderr: result.stderr.trim(),
		sessionId,
		promptPath,
		resultPath,
	};
}

async function runSubagent(
	agent: AgentConfig,
	taskPrompt: string,
	taskId: string,
	repoRootPath: string,
	worktreePath: string,
	worktreeBranch: string | undefined,
	stopRequestPath: string,
	onStreamEvent?: (kind: string, text: string) => void,
): Promise<SubagentRun> {
	const args = ["--mode", "json", "-p", "--no-session"];
	args.push("--extension", ORCHESTRATOR_EXTENSION_PATH);
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	let promptFile: string | undefined;
	let timedOut = false;
	try {
		if (agent.systemPrompt.trim()) {
			const tempDir = path.join(repoRootPath, ".pi", "tmp");
			ensureDir(tempDir);
			promptFile = path.join(tempDir, `orchestrator-prompt-${safeFilename(agent.name)}-${Date.now()}.md`);
			const runtimeGuardrails = [
				"",
				"Runtime guardrails:",
				`- Repository root path: ${repoRootPath}`,
				`- Active worktree path: ${worktreePath}`,
				`- Active git branch: ${worktreeBranch ?? "(unknown)"}`,
				"- Always work in the active worktree path above.",
				"- Do not clone the repository again.",
				"- Do not create nested duplicate repos.",
				"- Use progress.md as compact shared memory for the run.",
				"- Keep progress.md entries minimal; handoff carries the detailed transfer context.",
				"- End your run by calling either handoff or finish exactly once.",
				"- handoff and finish are PI TOOLS, not shell commands.",
				"- Never use bash, which, ls, find, or grep to look for handoff or finish.",
				"- Do not say you are handing off unless you actually call the handoff tool.",
				"- Do not say the task is complete unless you actually call the finish tool.",
			].join("\n");
			fs.writeFileSync(promptFile, `${agent.systemPrompt}\n${runtimeGuardrails}\n`, "utf-8");
			args.push("--append-system-prompt", promptFile);
		}
		args.push(`Task: ${taskPrompt}`);
		const assistantChunks: string[] = [];
		const toolSignals: ToolSignal[] = [];
		const pendingToolArgs = new Map<string, { toolName: string; args: Record<string, unknown> }>();
		let finalAssistantText = "";
		let stderr = "";
		let eventCount = 0;
		let toolEventCount = 0;
		let deltaCount = 0;
		let pendingDelta = "";
		let stdoutBuffer = "";
		let stopRequested = false;
		const flushDelta = (): void => {
			const text = pendingDelta.trim();
			if (!text) return;
			pendingDelta = "";
			onStreamEvent?.("assistant_delta", text);
		};
		const parseLine = (line: string): void => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line) as Record<string, unknown>;
				const eventType = String(event.type ?? "");
				if (eventType && eventType !== "session") eventCount += 1;
				if (eventType === "message_update") {
					const assistantMessageEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
					if (assistantMessageEvent?.type === "text_delta") {
						const delta = String(assistantMessageEvent.delta ?? "");
						if (delta) {
							deltaCount += 1;
							pendingDelta += delta;
							if (pendingDelta.length >= 160 || pendingDelta.includes("\n")) flushDelta();
						}
					}
					return;
				}
				if (eventType === "tool_execution_start") {
					toolEventCount += 1;
					const toolCallId = String(event.toolCallId ?? `${String(event.toolName ?? "tool")}:${toolEventCount}`);
					const toolName = String(event.toolName ?? "");
					const toolArgs = (event.args ?? {}) as Record<string, unknown>;
					pendingToolArgs.set(toolCallId, { toolName, args: toolArgs });
					onStreamEvent?.("tool_start", `start ${toolName} ${JSON.stringify(toolArgs)}`.slice(0, 320));
					return;
				}
				if (eventType === "tool_execution_end") {
					toolEventCount += 1;
					const toolCallId = String(event.toolCallId ?? `${String(event.toolName ?? "tool")}:${toolEventCount}`);
					const pending = pendingToolArgs.get(toolCallId);
					const toolName = pending?.toolName ?? String(event.toolName ?? "");
					onStreamEvent?.(
						"tool_end",
						`end ${toolName} error=${Boolean(event.isError)} result=${JSON.stringify(event.result ?? "").slice(0, 220)}`,
					);
					if (!event.isError && pending) {
						if (toolName === "handoff") {
							toolSignals.push({ kind: "handoff", payload: parseHandoffPayload(pending.args) });
						}
						if (toolName === "finish") {
							toolSignals.push({ kind: "finish", payload: parseFinishPayload(pending.args) });
						}
						if (toolName === "report_bug_in_workflow") {
							toolSignals.push({ kind: "workflow_bug", payload: parseWorkflowBugPayload(pending.args) });
						}
					}
					pendingToolArgs.delete(toolCallId);
					return;
				}
				if (eventType === "auto_retry_start") {
					onStreamEvent?.(
						"retry",
						`auto retry ${String(event.attempt ?? "?")}/${String(event.maxAttempts ?? "?")} delay=${String(event.delayMs ?? "?")}ms`,
					);
					return;
				}
				if (eventType === "message_end") {
					const msg = event.message as Record<string, unknown> | undefined;
					if (!msg || msg.role !== "assistant") return;
					const content = msg.content as Array<Record<string, unknown>> | undefined;
					if (!content) return;
					const text = content.filter((item) => item.type === "text").map((item) => String(item.text ?? "")).join("\n").trim();
					if (text) {
						assistantChunks.push(text);
						finalAssistantText = text;
						onStreamEvent?.("assistant_message_end", text.slice(0, 320));
					}
				}
			} catch {
				// ignore non-JSON output
			}
		};
		const started = Date.now();
		const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
			const timeoutMs = getSubagentTimeoutMs();
			const child = spawn("pi", args, {
				cwd: getSubagentRuntimeCwd(),
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PI_ORCHESTRATOR_TASK_ID: taskId,
					PI_ORCHESTRATOR_ACTIVE_AGENT: agent.name,
					PI_ORCHESTRATOR_REPO_PATH: repoRootPath,
					PI_ORCHESTRATOR_WORKTREE_PATH: worktreePath,
				},
			});
			let done = false;
			const complete = (code: number, err: string): void => {
				if (done) return;
				done = true;
				resolve({ code, stderr: err });
			};
			const maybeStop = (): void => {
				if (stopRequested || !fs.existsSync(stopRequestPath)) return;
				stopRequested = true;
				onStreamEvent?.("stop_requested", "stop request received; terminating subagent");
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 5_000);
			};
			const timeout = setTimeout(() => {
				timedOut = true;
				onStreamEvent?.("timeout", `subagent exceeded timeout after ${Math.floor(timeoutMs / 1000)}s`);
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 5_000);
			}, timeoutMs);
			const stopPoll = setInterval(maybeStop, 1000);
			child.stdout.on("data", (chunk) => {
				maybeStop();
				stdoutBuffer += chunk.toString("utf-8");
				let idx = stdoutBuffer.indexOf("\n");
				while (idx !== -1) {
					const line = stdoutBuffer.slice(0, idx).trimEnd();
					stdoutBuffer = stdoutBuffer.slice(idx + 1);
					parseLine(line);
					idx = stdoutBuffer.indexOf("\n");
				}
			});
			child.stderr.on("data", (chunk) => {
				maybeStop();
				stderr += chunk.toString("utf-8");
			});
			child.on("error", (error) => {
				clearTimeout(timeout);
				clearInterval(stopPoll);
				complete(1, `${stderr}\n${error.message}`.trim());
			});
			child.on("close", (code) => {
				clearTimeout(timeout);
				clearInterval(stopPoll);
				if (stdoutBuffer.trim()) parseLine(stdoutBuffer.trim());
				flushDelta();
				complete(code ?? 1, stderr.trim());
			});
		});
		return {
			ok: result.code === 0,
			exitCode: result.code,
			stderr: result.stderr || stderr.trim(),
			finalAssistantText,
			fullAssistantText: assistantChunks.join("\n\n"),
			eventCount,
			toolEventCount,
			deltaCount,
			durationMs: Date.now() - started,
			timedOut,
			stopRequested,
			toolSignals,
		};
	} finally {
		if (promptFile && fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
	}
}

async function runWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: TaskState,
	agents: Map<string, AgentConfig>,
): Promise<TaskState> {
	const getAgent = (name: RuntimeAgent): AgentConfig => {
		const agent = agents.get(name);
		if (!agent) throw new Error(`Missing required agent definition "${name}" in .pi/agents`);
		return agent;
	};
	const failTask = (kind: FailureKind, details: string, agent?: RuntimeAgent): TaskState => {
		state.status = "failed";
		state.stage = "failed";
		state.failureKind = kind;
		state.failureDetails = details;
		recordEvent(state, { type: "failure", at: nowIso(), taskId: state.id, agent, kind, details });
		recordProgress(pi, ctx, state, "failed", `${kind}: ${details}`);
		saveFinalArtifacts(state);
		persistTask(pi, state);
		return state;
	};
	const runAgent = async (agentName: RuntimeAgent, purpose: string, prompt: string): Promise<SubagentRun> => {
		const executionPath = state.worktreePath ?? state.repoPath;
		const progressText = readProgress(state);
		const contextualPrompt = [
			`Execution repository path: ${executionPath}`,
			`Repository root path: ${state.repoPath}`,
			`Execution git branch: ${state.worktreeBranch ?? "(unknown)"}`,
			`Progress file path: ${getProgressPath(state.repoPath, state)}`,
			`Current agent: ${agentName}`,
			`Current stage: ${getStageForAgent(agentName)}`,
			"",
			"Current run progress:",
			progressText.trim(),
			"",
			prompt,
		].join("\n");
		const seq = (state.traceSeq ?? 0) + 1;
		state.traceSeq = seq;
		const traceDir = getTraceDir(state.repoPath, state);
		const stem = `${String(seq).padStart(3, "0")}-${safeFilename(agentName)}-${safeFilename(purpose).slice(0, 48)}`;
		const promptPath = path.join(traceDir, `${stem}.prompt.md`);
		const resultPath = path.join(traceDir, `${stem}.result.md`);
		const metaPath = path.join(traceDir, `${stem}.meta.json`);
		fs.writeFileSync(promptPath, contextualPrompt, "utf-8");
		state.activeAgentName = agentName;
		state.activeAgentPurpose = purpose;
		state.currentAgent = agentName;
		state.lastPromptPath = promptPath;
		state.lastResultPath = undefined;
		const selectedAgent = getAgent(agentName);
		state.lastSubagentCommand = `pi --mode json -p --no-session${selectedAgent.model ? ` --model ${selectedAgent.model}` : ""}${selectedAgent.tools && selectedAgent.tools.length > 0 ? ` --tools ${selectedAgent.tools.join(",")}` : ""} --append-system-prompt <temp> "Task: ..."`;
		persistTask(pi, state);
		refreshLiveUi(ctx, state);
		recordProgress(pi, ctx, state, getStageForAgent(agentName), `Dispatching ${agentName} (${purpose})`);
		recordEvent(state, { type: "agent_started", at: nowIso(), taskId: state.id, agent: agentName, stage: getStageForAgent(agentName), promptPath });
		const started = Date.now();
		const heartbeat = setInterval(() => {
			const secs = Math.floor((Date.now() - started) / 1000);
			recordProgress(pi, ctx, state, getStageForAgent(agentName), `Waiting on ${agentName} (${purpose}) for ${secs}s`);
		}, 60_000);
		let lastUiRefreshMs = 0;
		const run = await runSubagent(
			selectedAgent,
			contextualPrompt,
			state.id,
			state.repoPath,
			executionPath,
			state.worktreeBranch,
			getStopRequestPath(state.repoPath, state),
			(kind, text) => {
				const at = nowIso();
				const normalizedText = text.replace(/\s+/g, " ").trim().slice(0, 260);
				const item = { at, agent: agentName, purpose, kind, text: normalizedText };
				const next = [...(state.streamEvents ?? []), item];
				state.streamEvents = next.slice(-80);
				state.lastStreamEvent = `[${agentName}] ${kind} ${normalizedText}`;
				fs.appendFileSync(getLiveLogPath(state.repoPath, state), `${at} [stream:${agentName}:${kind}] ${normalizedText}\n`, "utf-8");
				const now = Date.now();
				if (now - lastUiRefreshMs >= 1200) {
					lastUiRefreshMs = now;
					persistTask(pi, state);
					refreshLiveUi(ctx, state);
				}
			},
		).finally(() => {
			clearInterval(heartbeat);
		});
		const resultBody = [
			`# Agent Result: ${agentName}`,
			"",
			`- Purpose: ${purpose}`,
			`- Exit Code: ${run.exitCode}`,
			`- OK: ${run.ok}`,
			`- TimedOut: ${run.timedOut}`,
			`- DurationMs: ${run.durationMs}`,
			`- Event Count: ${run.eventCount}`,
			`- Delta Count: ${run.deltaCount}`,
			`- Tool Event Count: ${run.toolEventCount}`,
			`- Stop Requested: ${run.stopRequested}`,
			`- Tool Signals: ${run.toolSignals.length}`,
			"",
			"## Final Assistant Text",
			run.finalAssistantText || "(empty)",
			"",
			"## Full Assistant Text",
			run.fullAssistantText || "(empty)",
			"",
			"## Tool Signals",
			run.toolSignals.length > 0 ? JSON.stringify(run.toolSignals, null, 2) : "(none)",
			"",
			"## Stderr",
			run.stderr || "(empty)",
			"",
		].join("\n");
		fs.writeFileSync(resultPath, resultBody, "utf-8");
		fs.writeFileSync(
			metaPath,
			JSON.stringify(
				{
					taskId: state.id,
					agent: agentName,
					purpose,
					at: nowIso(),
					promptPath,
					resultPath,
					ok: run.ok,
					exitCode: run.exitCode,
					durationMs: run.durationMs,
					eventCount: run.eventCount,
					deltaCount: run.deltaCount,
					toolEventCount: run.toolEventCount,
					stopRequested: run.stopRequested,
					toolSignals: run.toolSignals,
					command: state.lastSubagentCommand,
				},
				null,
				2,
			),
			"utf-8",
		);
		state.lastResultPath = resultPath;
		state.activeAgentName = undefined;
		state.activeAgentPurpose = undefined;
		recordEvent(state, {
			type: "agent_completed",
			at: nowIso(),
			taskId: state.id,
			agent: agentName,
			stage: getStageForAgent(agentName),
			resultPath,
			durationMs: run.durationMs,
			exitCode: run.exitCode,
			toolSignals: run.toolSignals.length,
		});
		persistTask(pi, state);
		return run;
	};
	state.status = "running";
	persistTask(pi, state);
	refreshLiveUi(ctx, state);
	await ensureTaskWorktree(pi, state);
	clearStopRequest(state.repoPath, state);
	recordProgress(pi, ctx, state, "received", `Worktree ready at ${state.worktreePath} on branch ${state.worktreeBranch}`);
	recordEvent(state, {
		type: state.handoffCount > 0 ? "task_resumed" : "task_started",
		at: nowIso(),
		taskId: state.id,
		repoPath: state.repoPath,
		worktreePath: state.worktreePath,
		worktreeBranch: state.worktreeBranch,
	});
	let currentAgent = state.currentAgent ?? "spec-writer";
	let currentMessage =
		state.lastHandoff?.message ??
		[
			"You are the first stage in the orchestration chain.",
			"Create the implementation brief, choose codex-impl or amp-impl, and hand off to that implementer.",
			"",
			`Repository root path:\n${state.repoPath}`,
			`Worktree path:\n${state.worktreePath}`,
			`User task:\n${state.originalTask}`,
		].join("\n");
	let purpose = "agent-runtime";
	while (true) {
		if (hasStopRequest(state.repoPath, state)) {
			return failTask("stopped", "Stop requested by user", currentAgent);
		}
		if (currentAgent === "reviewer") {
			if (state.reviewLoops >= state.maxReviewLoops) return failTask("max_loops_exceeded", "Exceeded max review loops", currentAgent);
			state.reviewLoops += 1;
		}
		if (currentAgent === "validator") {
			if (state.validationLoops >= state.maxValidationLoops) return failTask("max_loops_exceeded", "Exceeded max validation loops", currentAgent);
			state.validationLoops += 1;
		}
		const run = await runAgent(currentAgent, purpose, currentMessage);
		if (run.stopRequested) {
			return failTask("stopped", "Stop requested by user", currentAgent);
		}
		if (!run.ok) {
			return failTask(run.timedOut ? "timeout" : "subprocess_error", run.stderr || `Agent ${currentAgent} failed`, currentAgent);
		}
		const resolvedSignal = resolveToolSignal(currentAgent, run.toolSignals);
		if (resolvedSignal.error) {
			return failTask("protocol_violation", resolvedSignal.error, currentAgent);
		}
		if (resolvedSignal.warning) {
			recordProgress(pi, ctx, state, getStageForAgent(currentAgent), resolvedSignal.warning);
		}
		const terminalSignal = resolvedSignal.signal!;
		if (terminalSignal.kind === "handoff") {
			const payload = terminalSignal.payload;
			const record: HandoffRecord = {
				at: nowIso(),
				fromAgent: currentAgent,
				toAgent: payload.toAgent,
				summary: payload.summary,
				message: payload.message,
				reason: payload.reason,
				artifacts: payload.artifacts,
			};
			state.handoffCount += 1;
			state.lastHandoff = record;
			state.handoffHistory.push(record);
			state.currentAgent = payload.toAgent;
			applyArtifactsToState(state, payload.artifacts);
			if (currentAgent === "spec-writer") {
				state.routedAgent = payload.toAgent === "amp-impl" ? "amp-impl" : "codex-impl";
				const specDir = path.join(state.repoPath, ".pi", "specs");
				ensureDir(specDir);
				const specPath = path.join(specDir, `${safeFilename(state.id)}.md`);
				fs.writeFileSync(specPath, buildSpecMarkdown(state, record), "utf-8");
				state.specPath = specPath;
			}
			recordEvent(state, {
				type: "handoff",
				at: record.at,
				taskId: state.id,
				fromAgent: currentAgent,
				toAgent: payload.toAgent,
				summary: payload.summary,
				reason: payload.reason,
			});
			recordProgress(pi, ctx, state, getStageForAgent(payload.toAgent), `${currentAgent} handed off to ${payload.toAgent}: ${payload.summary}`);
			currentMessage = payload.message;
			currentAgent = payload.toAgent;
			purpose = `${record.fromAgent}-handoff`;
			continue;
		}
		if (terminalSignal.kind === "workflow_bug") {
			const payload = terminalSignal.payload;
			recordProgress(pi, ctx, state, getStageForAgent(currentAgent), `workflow bug: ${payload.summary}`);
			if (payload.terminate) {
				return failTask("workflow_bug_reported", `${payload.summary}\n${payload.details}`, currentAgent);
			}
			return failTask("protocol_violation", `Non-terminal workflow bug report left run without next action: ${payload.summary}`, currentAgent);
		}
		const payload = terminalSignal.payload;
		applyArtifactsToState(state, payload.artifacts);
		state.finalReport = payload.report;
		state.currentAgent = currentAgent;
		state.status = payload.outcome === "completed" ? "completed" : "failed";
		state.stage = payload.outcome === "completed" ? "done" : "failed";
		recordEvent(state, {
			type: "finish",
			at: nowIso(),
			taskId: state.id,
			agent: currentAgent,
			outcome: payload.outcome,
			summary: payload.summary,
		});
		recordProgress(pi, ctx, state, state.stage, payload.summary);
		saveFinalArtifacts(state);
		persistTask(pi, state);
		return state;
	}
}

function summarizeState(state: TaskState): string {
	return [
		`Task ${state.id}: ${state.title}`,
		`Status: ${state.status}`,
		`Stage: ${state.stage}`,
		`Repo: ${state.repoPath}`,
		state.worktreePath ? `Worktree: ${state.worktreePath}` : undefined,
		state.worktreeBranch ? `Branch: ${state.worktreeBranch}` : undefined,
		state.currentAgent ? `Current agent: ${state.currentAgent}` : undefined,
		state.lastHandoff ? `Last handoff: ${state.lastHandoff.fromAgent} -> ${state.lastHandoff.toAgent}` : undefined,
		state.failureKind ? `Failure: ${state.failureKind} ${state.failureDetails ?? ""}` : undefined,
	].filter(Boolean).join("\n");
}

function loadPersistedTasks(ctx: ExtensionContext): Map<string, TaskState> {
	const entries = ctx.sessionManager.getEntries();
	const tasks = new Map<string, TaskState>();
	for (const entry of entries) {
		const e = entry as { type?: string; customType?: string; data?: TaskState };
		if (e.type !== "custom" || e.customType !== "pi-orchestrator-task" || !e.data?.id) continue;
		tasks.set(e.data.id, {
			...e.data,
			repoPath: e.data.repoPath ?? ctx.cwd,
			maxReviewLoops: e.data.maxReviewLoops ?? 3,
			maxValidationLoops: e.data.maxValidationLoops ?? 3,
			reviewLoops: e.data.reviewLoops ?? 0,
			validationLoops: e.data.validationLoops ?? 0,
			handoffCount: e.data.handoffCount ?? 0,
			handoffHistory: e.data.handoffHistory ?? [],
			blockingFindings: e.data.blockingFindings ?? [],
			validationIssues: e.data.validationIssues ?? [],
			widgetMode: e.data.widgetMode ?? readWidgetMode(e.data.repoPath ?? ctx.cwd, e.data.worktreePath, ctx.cwd),
		});
	}
	return tasks;
}

function loadTaskById(ctx: ExtensionContext, taskId: string): TaskState | undefined {
	return loadPersistedTasks(ctx).get(taskId);
}

function newTaskState(taskInput: string, repoPath: string): TaskState {
	const id = `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
	return {
		id,
		title: taskInput.length > 80 ? `${taskInput.slice(0, 77)}...` : taskInput,
		originalTask: taskInput,
		repoPath,
		status: "queued",
		stage: "received",
		createdAt: nowIso(),
		updatedAt: nowIso(),
		reviewLoops: 0,
		validationLoops: 0,
		maxReviewLoops: 3,
		maxValidationLoops: 3,
		handoffCount: 0,
		handoffHistory: [],
		blockingFindings: [],
		validationIssues: [],
		history: [],
		streamEvents: [],
	};
}

function loadToolTaskState(): TaskState {
	const repoPath = process.env.PI_ORCHESTRATOR_REPO_PATH;
	const taskId = process.env.PI_ORCHESTRATOR_TASK_ID;
	if (!repoPath || !taskId) {
		throw new Error("Missing orchestrator task context");
	}
	const statePath = path.join(repoPath, ".pi", "reports", `${safeFilename(taskId)}.state.json`);
	const raw = fs.readFileSync(statePath, "utf-8");
	return JSON.parse(raw) as TaskState;
}

function persistToolTaskState(state: TaskState): void {
	writeJsonAtomic(getLiveStatePath(state.repoPath, state), state);
}

export default function piOrchestratorExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "write_prompt",
		label: "write_prompt",
		description: "Write the full prompt that will be used for the delegated coding agent run.",
		promptSnippet: "Call write_prompt(prompt) before dispatch_coding_agent.",
		promptGuidelines: [
			"Use write_prompt to prepare the full delegated task prompt.",
			"Include the task-specific instructions only; the runtime will inject repo/worktree/progress context.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Full prompt body for the delegated coding run." }),
		}),
		async execute(_toolCallId: string, params: unknown) {
			const { prompt } = params as { prompt: string };
			const state = loadToolTaskState();
			const promptPath = writePromptDraft(state, prompt);
			persistToolTaskState(state);
			return {
				content: [{ type: "text", text: `Prompt saved to ${promptPath}` }],
				details: { action: "write_prompt", promptPath },
			};
		},
	});
	pi.registerTool({
		name: "dispatch_coding_agent",
		label: "dispatch_coding_agent",
		description: "Dispatch Codex or Amp against the active worktree using the current prompt draft.",
		promptSnippet: "Call dispatch_coding_agent(provider, task_kind, resume_session_id?) to run Codex/Amp in the active worktree.",
		promptGuidelines: [
			"dispatch_coding_agent is the only way to run delegated coding or review work.",
			"Do not use bash or file tools for implementation, review, or validation work.",
		],
		parameters: Type.Object({
			provider: Type.Union([Type.Literal("codex"), Type.Literal("amp")]),
			task_kind: Type.Union([
				Type.Literal("spec"),
				Type.Literal("implementation"),
				Type.Literal("review"),
				Type.Literal("validation"),
			]),
			resume_session_id: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId: string, params: unknown) {
			const activeAgent = process.env.PI_ORCHESTRATOR_ACTIVE_AGENT as RuntimeAgent | undefined;
			if (!activeAgent) throw new Error("dispatch_coding_agent is only available inside an orchestrator stage");
			const { provider, task_kind, resume_session_id } = params as {
				provider: "codex" | "amp";
				task_kind: "spec" | "implementation" | "review" | "validation";
				resume_session_id?: string;
			};
			const state = loadToolTaskState();
			const result = await dispatchCodingRun(state, activeAgent, provider, task_kind, resume_session_id);
			if (result.sessionId && task_kind === "review") {
				state.codexReviewSessionId = result.sessionId;
			}
			persistToolTaskState(state);
			return {
				content: [
					{
						type: "text",
						text: [
							`Delegated ${provider} ${task_kind} run ${result.ok ? "succeeded" : "failed"}.`,
							`Duration: ${result.durationMs}ms`,
							`Prompt: ${result.promptPath}`,
							`Result: ${result.resultPath}`,
							`Session: ${result.sessionId ?? "n/a"}`,
							"",
							"Final assistant text:",
							result.finalAssistantText,
						].join("\n"),
					},
				],
				details: {
					action: "dispatch_coding_agent",
					ok: result.ok,
					provider,
					taskKind: task_kind,
					durationMs: result.durationMs,
					promptPath: result.promptPath,
					resultPath: result.resultPath,
					sessionId: result.sessionId,
				},
			};
		},
	});
	pi.registerTool({
		name: "append_progress",
		label: "append_progress",
		description: "Append one short factual line to the shared progress.md ledger.",
		promptSnippet: "Call append_progress(entry) with one short line before handoff/finish.",
		promptGuidelines: [
			"Keep progress entries minimal.",
			"Do not duplicate the full handoff contents in progress.md.",
		],
		parameters: Type.Object({
			entry: Type.String({ description: "Short factual progress update." }),
		}),
		async execute(_toolCallId: string, params: unknown) {
			const activeAgent = process.env.PI_ORCHESTRATOR_ACTIVE_AGENT as RuntimeAgent | undefined;
			if (!activeAgent) throw new Error("append_progress is only available inside an orchestrator stage");
			const { entry } = params as { entry: string };
			const state = loadToolTaskState();
			appendProgressEntry(state, activeAgent, entry);
			persistToolTaskState(state);
			return {
				content: [{ type: "text", text: `Progress updated in ${getProgressPath(state.repoPath, state)}` }],
				details: { action: "append_progress" },
			};
		},
	});
	pi.registerTool({
		name: "handoff",
		label: "handoff",
		description: "Hand the orchestration task to the next stage agent.",
		promptSnippet: "Call handoff(to_agent, message, summary, artifacts?, reason?) exactly once to pass control to the next agent.",
		promptGuidelines: [
			"handoff is a custom Pi tool, not a shell command.",
			"Call handoff directly instead of writing prose that implies a handoff.",
			"Do not search the filesystem or PATH for handoff.",
		],
		parameters: Type.Object({
			to_agent: Type.Union([
				Type.Literal("codex-impl"),
				Type.Literal("amp-impl"),
				Type.Literal("reviewer"),
				Type.Literal("validator"),
				Type.Literal("reporter"),
			]),
			message: Type.String({ description: "Full handoff message for the next agent." }),
			summary: Type.String({ description: "Short summary for logs and UI." }),
			artifacts: Type.Optional(Type.Any()),
			reason: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId: string, params: unknown) {
			const { to_agent, summary } = params as {
				to_agent: HandoffTarget;
				summary: string;
			};
			return {
				content: [{ type: "text", text: `Handoff recorded for ${to_agent}: ${summary}` }],
				details: { action: "handoff" },
			};
		},
	});
	pi.registerTool({
		name: "finish",
		label: "finish",
		description: "Finish the orchestration run with a final report.",
		promptSnippet: "Call finish(outcome, summary, report, artifacts?) exactly once to terminate the workflow.",
		promptGuidelines: [
			"finish is a custom Pi tool, not a shell command.",
			"Call finish directly instead of only stating the task is done or failed in prose.",
			"Do not search the filesystem or PATH for finish.",
		],
		parameters: Type.Object({
			outcome: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
			summary: Type.String({ description: "Short final summary." }),
			report: Type.String({ description: "Final report body." }),
			artifacts: Type.Optional(Type.Any()),
		}),
		async execute(_toolCallId: string, params: unknown) {
			const { outcome, summary } = params as { outcome: "completed" | "failed"; summary: string };
			return {
				content: [{ type: "text", text: `Workflow ${outcome}: ${summary}` }],
				details: { action: "finish" },
			};
		},
	});
	pi.registerTool({
		name: "report_bug_in_workflow",
		label: "report_bug_in_workflow",
		description: "Report an orchestration/runtime bug rather than a bug in the target repository.",
		promptSnippet: "Call report_bug_in_workflow(summary, details, terminate?) when the workflow itself is broken.",
		promptGuidelines: [
			"Only use this for workflow/runtime issues, not repository bugs.",
			"Set terminate=true if the run cannot continue safely.",
		],
		parameters: Type.Object({
			summary: Type.String({ description: "Short workflow bug summary." }),
			details: Type.String({ description: "Detailed explanation of the workflow/runtime problem." }),
			terminate: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId: string, params: unknown) {
			const { summary, terminate } = params as { summary: string; terminate?: boolean };
			return {
				content: [{ type: "text", text: `Workflow bug reported${terminate ? " and marked terminal" : ""}: ${summary}` }],
				details: { action: "report_bug_in_workflow" },
			};
		},
	});
	pi.registerCommand("orchestrate", {
		description: "Start an agent-directed orchestration task",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parsedArgs = parseOrchestrateArgs(args, ctx.cwd);
			if (parsedArgs.error || !parsedArgs.repoPath || !parsedArgs.taskInput) {
				ctx.ui.notify(parsedArgs.error ?? "Usage: /orchestrate <repo-path> -- <task description>", "warning");
				return;
			}
			const { repoPath, taskInput } = parsedArgs;
			const tasks = loadPersistedTasks(ctx);
			const running = Array.from(tasks.values()).find((task) => task.status === "running");
			if (running) {
				ctx.ui.notify(`Task ${running.id} is already running. Use /orchestrate-status`, "warning");
				return;
			}
			const agents = loadProjectAgents(ctx.cwd);
			const required: RuntimeAgent[] = ["spec-writer", "codex-impl", "amp-impl", "reviewer", "validator", "reporter"];
			const missing = required.filter((name) => !agents.has(name));
			if (missing.length > 0) {
				ctx.ui.notify(`Missing required agents: ${missing.join(", ")}`, "error");
				return;
			}
			const state = newTaskState(taskInput, repoPath);
			recordProgress(pi, ctx, state, "received", "Task received");
			try {
				await runWorkflow(pi, ctx, state, agents);
				ctx.ui.notify(`Task ${state.id} ${state.status}`, state.status === "completed" ? "info" : "warning");
			} catch (error) {
				state.status = "failed";
				state.stage = "failed";
				state.failureKind = "subprocess_error";
				state.failureDetails = error instanceof Error ? error.message : String(error);
				recordProgress(pi, ctx, state, "failed", state.failureDetails);
				saveFinalArtifacts(state);
				persistTask(pi, state);
				ctx.ui.notify(`Task ${state.id} failed: ${state.failureDetails}`, "error");
			}
		},
	});
	pi.registerCommand("orchestrate-status", {
		description: "Show orchestrator task summary",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const tasks = Array.from(loadPersistedTasks(ctx).values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
			if (tasks.length === 0) {
				ctx.ui.notify("No orchestrator tasks found", "info");
				return;
			}
			const lines = tasks.slice(0, 10).map((task) => `${task.id} | ${task.status} | ${task.stage} | ${task.currentAgent ?? "idle"} | ${task.title}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
	pi.registerCommand("orchestrate-stop", {
		description: "Request stop for a running task: /orchestrate-stop <task-id>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const taskId = args.trim();
			if (!taskId) {
				ctx.ui.notify("Usage: /orchestrate-stop <task-id>", "warning");
				return;
			}
			const task = loadTaskById(ctx, taskId);
			if (!task) {
				ctx.ui.notify(`Task not found: ${taskId}`, "error");
				return;
			}
			writeStopRequest(task.repoPath, task, `Stop requested at ${nowIso()}`);
			recordProgress(pi, ctx, task, task.stage === "done" ? "done" : task.stage, "Stop requested by /orchestrate-stop");
			ctx.ui.notify(`Stop requested for ${taskId}`, "info");
		},
	});
	pi.registerCommand("orchestrate-widget", {
		description: "Set widget view mode: /orchestrate-widget <compact|handoff|prompt|result|history|stream>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const mode = args.trim().toLowerCase() as WidgetMode;
			if (!WIDGET_MODES.includes(mode)) {
				ctx.ui.notify("Usage: /orchestrate-widget <compact|handoff|prompt|result|history|stream>", "warning");
				return;
			}
			const repoPaths = new Set<string>([ctx.cwd]);
			for (const task of loadPersistedTasks(ctx).values()) {
				repoPaths.add(task.repoPath);
				if (task.worktreePath) repoPaths.add(task.worktreePath);
				task.widgetMode = mode;
			}
			writeWidgetMode(mode, Array.from(repoPaths));
			ctx.ui.notify(`Orchestrator widget mode: ${mode}`, "info");
		},
	});
	pi.registerCommand("orchestrate-log", {
		description: "Show detailed stage history for one task: /orchestrate-log <task-id>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const taskId = args.trim();
			if (!taskId) {
				ctx.ui.notify("Usage: /orchestrate-log <task-id>", "warning");
				return;
			}
			const task = loadTaskById(ctx, taskId);
			if (!task) {
				ctx.ui.notify(`Task not found: ${taskId}`, "error");
				return;
			}
			const lines = [
				summarizeState(task),
				"",
				...task.history.map((entry) => `${entry.at} | ${entry.stage} | ${entry.note}`),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
	pi.registerCommand("orchestrate-trace", {
		description: "Show prompt/response trace files: /orchestrate-trace <task-id>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const taskId = args.trim();
			if (!taskId) {
				ctx.ui.notify("Usage: /orchestrate-trace <task-id>", "warning");
				return;
			}
			const task = loadTaskById(ctx, taskId);
			if (!task) {
				ctx.ui.notify(`Task not found: ${taskId}`, "error");
				return;
			}
			const traceDir = task.traceDir ?? getTraceDir(task.repoPath, task);
			const files = fs.existsSync(traceDir)
				? fs.readdirSync(traceDir).filter((file) => file.endsWith(".prompt.md") || file.endsWith(".result.md") || file.endsWith(".meta.json"))
				: [];
			ctx.ui.notify(`Trace files for ${taskId}:\n${files.join("\n") || "(none yet)"}`, "info");
		},
	});
	pi.registerCommand("orchestrate-tail", {
		description: "Show the latest live stream log lines for one task: /orchestrate-tail <task-id>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const taskId = args.trim();
			if (!taskId) {
				ctx.ui.notify("Usage: /orchestrate-tail <task-id>", "warning");
				return;
			}
			const task = loadTaskById(ctx, taskId);
			if (!task) {
				ctx.ui.notify(`Task not found: ${taskId}`, "error");
				return;
			}
			const liveLogPath = task.liveLogPath ?? getLiveLogPath(task.repoPath, task);
			const tail = fs.existsSync(liveLogPath)
				? fs.readFileSync(liveLogPath, "utf-8").split("\n").filter(Boolean).slice(-80)
				: [];
			ctx.ui.notify(tail.join("\n") || "(no log yet)", "info");
		},
	});
	pi.registerCommand("orchestrate-resume", {
		description: "Resume a failed/interrupted task: /orchestrate-resume <task-id>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const taskId = args.trim();
			if (!taskId) {
				ctx.ui.notify("Usage: /orchestrate-resume <task-id>", "warning");
				return;
			}
			const task = loadTaskById(ctx, taskId);
			if (!task) {
				ctx.ui.notify(`Task not found: ${taskId}`, "error");
				return;
			}
			if (task.status === "completed") {
				ctx.ui.notify(`Task ${taskId} is already completed`, "info");
				return;
			}
			const agents = loadProjectAgents(ctx.cwd);
			recordProgress(pi, ctx, task, "received", "Task resumed by /orchestrate-resume");
			try {
				await runWorkflow(pi, ctx, task, agents);
					ctx.ui.notify(`Task ${task.id} ${task.status}`, "info");
			} catch (error) {
				task.status = "failed";
				task.stage = "failed";
				task.failureKind = "subprocess_error";
				task.failureDetails = error instanceof Error ? error.message : String(error);
				recordProgress(pi, ctx, task, "failed", task.failureDetails);
				saveFinalArtifacts(task);
				persistTask(pi, task);
				ctx.ui.notify(`Task ${task.id} failed: ${task.failureDetails}`, "error");
			}
		},
	});
}
