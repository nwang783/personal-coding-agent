import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

type TaskStatus = "queued" | "running" | "completed" | "failed";
type TaskStage =
	| "received"
	| "spec"
	| "implementation"
	| "review"
	| "fixing"
	| "validation"
	| "reporting"
	| "done"
	| "failed";

type ReviewFinding = {
	severity: "P0" | "P1" | "P2" | "P3";
	title: string;
	description: string;
	file?: string;
	line?: number;
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
	traceDir?: string;
	reportJsonPath?: string;
	reportMarkdownPath?: string;
	routedAgent?: "codex-impl" | "amp-impl";
	reviewLoops: number;
	validationLoops: number;
	maxReviewLoops: number;
	maxValidationLoops: number;
	lastImplSummary?: string;
	lastBranchName?: string;
	lastCommitShas?: string[];
	lastPrUrl?: string;
	lastPrFailureReason?: string;
	lastReviewSummary?: string;
	lastValidationSummary?: string;
	codexReviewSessionId?: string;
	blockingFindings: ReviewFinding[];
	validationIssues: string[];
	history: Array<{ at: string; stage: TaskStage; note: string }>;
	traceSeq?: number;
	activeAgentName?: string;
	activeAgentPurpose?: string;
	lastPromptPath?: string;
	lastResultPath?: string;
};

type AgentConfig = {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	filePath: string;
};

type SubagentRun = {
	ok: boolean;
	exitCode: number;
	stderr: string;
	finalAssistantText: string;
	fullAssistantText: string;
};

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

function deriveRepoPathFromTask(taskInput: string, fallbackCwd: string): string {
	const candidates = new Set<string>();
	const raw = taskInput.trim();

	for (const match of raw.matchAll(/\((~?\/[^)]+)\)/g)) {
		candidates.add(match[1]);
	}
	for (const match of raw.matchAll(/\b(~\/[^\s"')]+|\/[^\s"')]+)\b/g)) {
		candidates.add(match[1]);
	}

	for (const candidate of candidates) {
		const resolved = path.resolve(expandHome(candidate));
		if (isGitRepoRoot(resolved)) return resolved;
	}
	return fallbackCwd;
}

function getSubagentTimeoutMs(): number {
	const raw = process.env.PI_ORCHESTRATOR_SUBAGENT_TIMEOUT_MS;
	const parsed = raw ? Number(raw) : NaN;
	if (Number.isFinite(parsed) && parsed > 0) return parsed;
	// Default to 15 minutes per subagent call to avoid "silent hangs".
	return 15 * 60 * 1000;
}

function safeFilename(input: string): string {
	return input.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
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
			.map((t) => t.trim())
			.filter(Boolean);
		map.set(frontmatter.name, {
			name: frontmatter.name,
			description: frontmatter.description ?? "",
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body.trim(),
			filePath,
		});
	}
	return map;
}

function extractJsonObject(text: string): Record<string, unknown> | undefined {
	const fenced = text.match(/```json\s*([\s\S]*?)```/i);
	if (fenced) {
		try {
			return JSON.parse(fenced[1]);
		} catch {
			// fall through
		}
	}

	const firstBrace = text.indexOf("{");
	const lastBrace = text.lastIndexOf("}");
	if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return undefined;
	const candidate = text.slice(firstBrace, lastBrace + 1);
	try {
		return JSON.parse(candidate);
	} catch {
		return undefined;
	}
}

function extractSection(text: string, heading: string): string {
	const lines = text.split("\n");
	const headingRegex = new RegExp(`^\\s{0,3}#{1,6}\\s*${heading}\\s*$`, "i");
	const altHeadingRegex = new RegExp(`^\\s*${heading}\\s*:\\s*$`, "i");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (headingRegex.test(lines[i]) || altHeadingRegex.test(lines[i])) {
			start = i + 1;
			break;
		}
	}
	if (start === -1) return "";
	const out: string[] = [];
	for (let i = start; i < lines.length; i++) {
		if (/^\s{0,3}#{1,6}\s+/.test(lines[i])) break;
		if (/^\s*[A-Za-z][A-Za-z0-9 _-]{1,40}:\s*$/.test(lines[i])) break;
		out.push(lines[i]);
	}
	return out.join("\n").trim();
}

function extractBullets(section: string): string[] {
	if (!section) return [];
	return section
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => /^[-*]\s+/.test(l) || /^\d+\.\s+/.test(l))
		.map((l) => l.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim())
		.filter(Boolean);
}

function parseYesNo(text: string, positive: RegExp[], negative: RegExp[], defaultValue: boolean): boolean {
	const lower = text.toLowerCase();
	for (const re of negative) if (re.test(lower)) return false;
	for (const re of positive) if (re.test(lower)) return true;
	return defaultValue;
}

function parseDecisionBlock(text: string): Record<string, string> {
	const lines = text.split("\n");
	const out: Record<string, string> = {};
	let inDecision = false;
	for (const raw of lines) {
		const line = raw.trim();
		if (!inDecision) {
			if (/^decision\s*:/i.test(line)) {
				inDecision = true;
			}
			continue;
		}
		if (!line) continue;
		if (/^[A-Za-z][A-Za-z0-9 _-]{1,40}\s*:\s*$/.test(line) && !/^-/.test(line)) {
			break;
		}
		const item = line.replace(/^-\s*/, "");
		const idx = item.indexOf(":");
		if (idx === -1) continue;
		const key = item
			.slice(0, idx)
			.trim()
			.toLowerCase()
			.replace(/\s+/g, "_");
		const value = item.slice(idx + 1).trim();
		if (key && value) out[key] = value;
	}
	return out;
}

function normalizeSpecOutput(
	rawText: string,
	specJson: Record<string, unknown> | undefined,
	originalTask: string,
): {
	goal: string;
	constraints: string[];
	acceptanceCriteria: string[];
	complexitySignals: string[];
	implementationNotes: string[];
	implementationPhases: string[];
	phaseCompletionChecks: string[];
} {
	if (specJson) {
		return {
			goal: String(specJson.goal ?? originalTask),
			constraints: Array.isArray(specJson.constraints) ? specJson.constraints.map((x) => String(x)) : [],
			acceptanceCriteria: Array.isArray(specJson.acceptanceCriteria)
				? specJson.acceptanceCriteria.map((x) => String(x))
				: [],
			complexitySignals: Array.isArray(specJson.complexitySignals)
				? specJson.complexitySignals.map((x) => String(x))
				: [],
			implementationNotes: Array.isArray(specJson.implementationNotes)
				? specJson.implementationNotes.map((x) => String(x))
				: [],
			implementationPhases: Array.isArray(specJson.implementationPhases)
				? specJson.implementationPhases.map((x) => String(x))
				: [],
			phaseCompletionChecks: Array.isArray(specJson.phaseCompletionChecks)
				? specJson.phaseCompletionChecks.map((x) => String(x))
				: [],
		};
	}

	const goal =
		extractSection(rawText, "Goal").split("\n").find((x) => x.trim())?.trim() ??
		rawText.split("\n").find((x) => x.trim())?.trim() ??
		originalTask;
	const constraints = extractBullets(extractSection(rawText, "Constraints"));
	const acceptanceCriteria = extractBullets(extractSection(rawText, "Acceptance Criteria"));
	const complexitySignals = extractBullets(extractSection(rawText, "Complexity Signals"));
	const implementationNotes = extractBullets(extractSection(rawText, "Implementation Notes"));
	const implementationPhasesPrimary = extractBullets(extractSection(rawText, "Implementation Phases"));
	const implementationPhasesFallback = extractBullets(extractSection(rawText, "Phases"));
	const implementationPhases =
		implementationPhasesPrimary.length > 0 ? implementationPhasesPrimary : implementationPhasesFallback;
	const phaseCompletionChecksPrimary = extractBullets(extractSection(rawText, "Phase Completion Checks"));
	const phaseCompletionChecksFallback = extractBullets(extractSection(rawText, "Completion Checks"));
	const phaseCompletionChecks =
		phaseCompletionChecksPrimary.length > 0 ? phaseCompletionChecksPrimary : phaseCompletionChecksFallback;
	return {
		goal,
		constraints,
		acceptanceCriteria,
		complexitySignals,
		implementationNotes,
		implementationPhases,
		phaseCompletionChecks,
	};
}

function normalizeImplementationOutput(
	rawText: string,
	implJson: Record<string, unknown> | undefined,
): {
	implementationSummary: string;
	changedFiles: string[];
	testCommands: string[];
	testOutcomes: string[];
	unresolvedRisks: string[];
	branchName?: string;
	commitShas?: string[];
	prUrl?: string;
	prFailureReason?: string;
	decisionStatus?: string;
	decisionBlocking?: string;
	decisionLoopBackTo?: string;
} {
	if (implJson) {
		return {
			implementationSummary: String(implJson.implementationSummary ?? rawText),
			changedFiles: Array.isArray(implJson.changedFiles) ? implJson.changedFiles.map((x) => String(x)) : [],
			testCommands: Array.isArray(implJson.testCommands) ? implJson.testCommands.map((x) => String(x)) : [],
			testOutcomes: Array.isArray(implJson.testOutcomes) ? implJson.testOutcomes.map((x) => String(x)) : [],
			unresolvedRisks: Array.isArray(implJson.unresolvedRisks) ? implJson.unresolvedRisks.map((x) => String(x)) : [],
			branchName: implJson.branchName ? String(implJson.branchName) : undefined,
			commitShas: Array.isArray(implJson.commitShas) ? implJson.commitShas.map((x) => String(x)) : undefined,
			prUrl: implJson.prUrl ? String(implJson.prUrl) : undefined,
			prFailureReason: implJson.prFailureReason ? String(implJson.prFailureReason) : undefined,
			decisionStatus: implJson.decisionStatus ? String(implJson.decisionStatus) : undefined,
			decisionBlocking: implJson.decisionBlocking ? String(implJson.decisionBlocking) : undefined,
			decisionLoopBackTo: implJson.decisionLoopBackTo ? String(implJson.decisionLoopBackTo) : undefined,
		};
	}

	const decision = parseDecisionBlock(rawText);
	const prUrl = rawText.match(/https?:\/\/github\.com\/[^\s)]+\/pull\/\d+/i)?.[0];
	const branchName = rawText.match(/branch(?:\s*name)?\s*[:=-]\s*([A-Za-z0-9._/-]+)/i)?.[1];
	const commitShas = Array.from(new Set(rawText.match(/\b[0-9a-f]{7,40}\b/gi) ?? []));
	return {
		implementationSummary: rawText.trim() || "Implementation completed (unstructured response).",
		changedFiles: extractBullets(extractSection(rawText, "Changed Files")),
		testCommands: extractBullets(extractSection(rawText, "Test Commands")),
		testOutcomes: extractBullets(extractSection(rawText, "Test Outcomes")),
		unresolvedRisks: extractBullets(extractSection(rawText, "Unresolved Risks")),
		branchName: decision.branch || decision.branch_name || branchName,
		commitShas: commitShas.length > 0 ? commitShas : undefined,
		prUrl: decision.pr_url || prUrl,
		prFailureReason: decision.pr_failure_reason || extractSection(rawText, "PR Failure Reason") || undefined,
		decisionStatus: decision.status,
		decisionBlocking: decision.blocking,
		decisionLoopBackTo: decision.loop_back_to,
	};
}

function normalizeReviewOutput(
	rawText: string,
	reviewJson: Record<string, unknown> | undefined,
): {
	approved: boolean;
	blockingFindings: ReviewFinding[];
	fixInstructions: string;
	codexSessionId?: string;
	branchName?: string;
	commitShas?: string[];
	prUrl?: string;
	prFailureReason?: string;
} {
	if (reviewJson) {
		const blocking = Array.isArray(reviewJson.blockingFindings) ? reviewJson.blockingFindings : [];
		return {
			approved: Boolean(reviewJson.approved),
			blockingFindings: blocking.map((f) => {
				const finding = f as Record<string, unknown>;
				return {
					severity: (String(finding.severity ?? "P2").toUpperCase() as ReviewFinding["severity"]) ?? "P2",
					title: String(finding.title ?? "Untitled finding"),
					description: String(finding.description ?? ""),
					file: finding.file ? String(finding.file) : undefined,
					line: finding.line ? Number(finding.line) : undefined,
				};
			}),
			fixInstructions: String(reviewJson.fixInstructions ?? ""),
			codexSessionId: reviewJson.codexSessionId ? String(reviewJson.codexSessionId) : undefined,
			branchName: reviewJson.branchName ? String(reviewJson.branchName) : undefined,
			commitShas: Array.isArray(reviewJson.commitShas) ? reviewJson.commitShas.map((x) => String(x)) : undefined,
			prUrl: reviewJson.prUrl ? String(reviewJson.prUrl) : undefined,
			prFailureReason: reviewJson.prFailureReason ? String(reviewJson.prFailureReason) : undefined,
		};
	}

	const decision = parseDecisionBlock(rawText);
	const findings: ReviewFinding[] = [];
	const re = /(?:^|\n)\s*(?:[-*]|\d+\.)?\s*\[?(P[0-3])\]?\s*[:\-]\s*(.+)/gi;
	for (const match of rawText.matchAll(re)) {
		const sev = String(match[1]).toUpperCase() as ReviewFinding["severity"];
		const body = String(match[2]).trim();
		const [title, ...desc] = body.split(" - ");
		findings.push({
			severity: sev,
			title: title.slice(0, 120),
			description: desc.join(" - ") || body,
		});
	}
	const approved = parseYesNo(
		decision.status ?? rawText,
		[/\bapproved\b/i, /\bpasses?\b/i, /\bno (critical|blocking) issues?\b/i],
		[/\bnot approved\b/i, /\bfail(?:ed|s)?\b/i, /\bblocking\b/i],
		findings.length === 0,
	);
	const branchName = rawText.match(/branch(?:\s*name)?\s*[:=-]\s*([A-Za-z0-9._/-]+)/i)?.[1];
	const commitShas = Array.from(new Set(rawText.match(/\b[0-9a-f]{7,40}\b/gi) ?? []));
	const prUrl = rawText.match(/https?:\/\/github\.com\/[^\s)]+\/pull\/\d+/i)?.[0];
	const blockingFromDecision = parseYesNo(
		decision.blocking ?? "",
		[/\byes\b/i, /\btrue\b/i],
		[/\bno\b/i, /\bfalse\b/i],
		findings.some((f) => f.severity === "P0" || f.severity === "P1"),
	);
	return {
		approved: approved && !blockingFromDecision,
		blockingFindings: findings,
		fixInstructions: extractSection(rawText, "Fix Instructions") || rawText.trim(),
		codexSessionId: decision.codex_session_id || decision.review_session_id,
		branchName: decision.branch || decision.branch_name || branchName,
		commitShas: commitShas.length > 0 ? commitShas : undefined,
		prUrl: decision.pr_url || prUrl,
		prFailureReason: decision.pr_failure_reason || extractSection(rawText, "PR Failure Reason") || undefined,
	};
}

function normalizeValidationOutput(
	rawText: string,
	validationJson: Record<string, unknown> | undefined,
): {
	passed: boolean;
	issues: string[];
	remediation: string;
} {
	if (validationJson) {
		return {
			passed: Boolean(validationJson.passed),
			issues: Array.isArray(validationJson.issues) ? validationJson.issues.map((x) => String(x)) : [],
			remediation: String(validationJson.remediation ?? ""),
		};
	}
	const decision = parseDecisionBlock(rawText);
	return {
		passed: parseYesNo(
			decision.status ?? rawText,
			[/\bpassed\b/i, /\bvalidated\b/i, /\bapproved\b/i],
			[/\bfailed\b/i, /\bnot passed\b/i, /\bneeds_changes\b/i],
			false,
		),
		issues: extractBullets(extractSection(rawText, "Issues")),
		remediation: extractSection(rawText, "Remediation") || rawText.trim(),
	};
}

function renderSpecMarkdown(
	task: TaskState,
	specData: {
		goal: string;
		constraints: string[];
		acceptanceCriteria: string[];
		complexitySignals: string[];
		implementationNotes: string[];
		implementationPhases: string[];
		phaseCompletionChecks: string[];
	},
): string {
	const phases =
		specData.implementationPhases.length > 0
			? specData.implementationPhases
			: ["Phase 1: Foundation", "Phase 2: Implementation", "Phase 3: Verification and Handoff"];
	const checks =
		specData.phaseCompletionChecks.length > 0
			? specData.phaseCompletionChecks
			: [
					"Phase 1 artifacts created and wired (types/modules/hooks/interfaces).",
					"Phase 2 feature behavior implemented and integrated in target surfaces.",
					"Phase 3 tests pass and manual verification evidence is captured.",
				];
	return [
		`# Spec: ${task.title}`,
		"",
		`- Task ID: ${task.id}`,
		`- Created: ${task.createdAt}`,
		`- Updated: ${task.updatedAt}`,
		`- Repository Root: ${task.repoPath}`,
		`- Worktree Path: ${task.worktreePath ?? "n/a"}`,
		`- Worktree Branch: ${task.worktreeBranch ?? "n/a"}`,
		"",
		"## Goal",
		specData.goal,
		"",
		"## Constraints",
		...specData.constraints.map((x) => `- ${x}`),
		"",
		"## Acceptance Criteria",
		...specData.acceptanceCriteria.map((x) => `- ${x}`),
		"",
		"## Complexity Signals",
		...specData.complexitySignals.map((x) => `- ${x}`),
		"",
		"## Implementation Phases",
		...phases.map((x, i) => `${i + 1}. ${x}`),
		"",
		"## Phase Completion Checks",
		...checks.map((x) => `- [ ] ${x}`),
		"",
		"## Implementation Notes",
		...specData.implementationNotes.map((x) => `- ${x}`),
		"",
		"## Original Task",
		task.originalTask,
		"",
	].join("\n");
}

function heuristicRoute(taskText: string, specSignals: string[]): "codex-impl" | "amp-impl" {
	let score = 0;
	const lower = taskText.toLowerCase();
	const complexKeywords = [
		"complex",
		"architecture",
		"refactor",
		"migration",
		"multi",
		"integration",
		"distributed",
		"large",
		"cross-cutting",
	];
	for (const kw of complexKeywords) {
		if (lower.includes(kw)) score += 1;
	}
	score += Math.min(3, specSignals.length);
	if (taskText.length > 700) score += 1;
	return score >= 4 ? "amp-impl" : "codex-impl";
}

function summarizeState(state: TaskState): string {
	const topFinding = state.blockingFindings[0];
	return [
		`Task ${state.id}: ${state.title}`,
		`Status: ${state.status}`,
		`Stage: ${state.stage}`,
		`Repo: ${state.repoPath}`,
		state.worktreePath ? `Worktree: ${state.worktreePath}` : undefined,
		state.worktreeBranch ? `Worktree branch: ${state.worktreeBranch}` : undefined,
		`Review loops: ${state.reviewLoops}/${state.maxReviewLoops}`,
		`Validation loops: ${state.validationLoops}/${state.maxValidationLoops}`,
		state.routedAgent ? `Implementation agent: ${state.routedAgent}` : undefined,
		state.codexReviewSessionId ? `Codex review session: ${state.codexReviewSessionId}` : undefined,
		state.lastBranchName ? `Branch: ${state.lastBranchName}` : undefined,
		state.lastPrUrl ? `PR: ${state.lastPrUrl}` : undefined,
		state.lastPrFailureReason ? `PR status: ${state.lastPrFailureReason}` : undefined,
		topFinding ? `Top blocking finding: [${topFinding.severity}] ${topFinding.title}` : undefined,
		state.validationIssues[0] ? `Top validation issue: ${state.validationIssues[0]}` : undefined,
	].filter(Boolean).join("\n");
}

async function runSubagent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agent: AgentConfig,
	taskPrompt: string,
	runCwd: string,
	repoRootPath: string,
	worktreePath: string,
	worktreeBranch: string | undefined,
): Promise<SubagentRun> {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let promptFile: string | undefined;
	try {
		if (agent.systemPrompt.trim()) {
			const tempDir = path.join(ctx.cwd, ".pi", "tmp");
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
			].join("\n");
			fs.writeFileSync(promptFile, `${agent.systemPrompt}\n${runtimeGuardrails}\n`, "utf-8");
			args.push("--append-system-prompt", promptFile);
		}
		args.push(`Task: ${taskPrompt}`);

		const result = await pi.exec("pi", args, { timeout: getSubagentTimeoutMs(), cwd: runCwd });
		const assistantChunks: string[] = [];
		let finalAssistantText = "";

		for (const line of result.stdout.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as Record<string, unknown>;
				if (event.type !== "message_end") continue;
				const msg = event.message as Record<string, unknown> | undefined;
				if (!msg || msg.role !== "assistant") continue;
				const content = msg.content as Array<Record<string, unknown>> | undefined;
				if (!content) continue;
				const text = content
					.filter((c) => c.type === "text")
					.map((c) => String(c.text ?? ""))
					.join("\n")
					.trim();
				if (text) {
					assistantChunks.push(text);
					finalAssistantText = text;
				}
			} catch {
				// ignore line parse errors
			}
		}

		return {
			ok: result.code === 0,
			exitCode: result.code,
			stderr: result.stderr,
			finalAssistantText,
			fullAssistantText: assistantChunks.join("\n\n"),
		};
	} finally {
		if (promptFile && fs.existsSync(promptFile)) {
			fs.unlinkSync(promptFile);
		}
	}
}

async function ensureTaskWorktree(pi: ExtensionAPI, state: TaskState): Promise<void> {
	const worktreesRoot = path.join(state.repoPath, ".pi", "worktrees");
	ensureDir(worktreesRoot);

	if (!state.worktreePath) {
		state.worktreePath = path.join(worktreesRoot, safeFilename(state.id));
	}
	if (!state.worktreeBranch) {
		state.worktreeBranch = `pi/${safeFilename(state.id).slice(0, 52)}`;
	}

	const existingGit = path.join(state.worktreePath, ".git");
	if (!fs.existsSync(existingGit)) {
		ensureDir(path.dirname(state.worktreePath));
		// Create isolated branch/worktree for this task.
		const addResult = await pi.exec(
			"git",
			["-C", state.repoPath, "worktree", "add", "-b", state.worktreeBranch, state.worktreePath, "HEAD"],
			{ timeout: 120_000 },
		);
		if (addResult.code !== 0) {
			// Fallback for resumed tasks/branches that may already exist.
			const retry = await pi.exec(
				"git",
				["-C", state.repoPath, "worktree", "add", state.worktreePath, state.worktreeBranch],
				{ timeout: 120_000 },
			);
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

function appendHistory(state: TaskState, stage: TaskStage, note: string): void {
	state.stage = stage;
	state.updatedAt = nowIso();
	state.history.push({ at: state.updatedAt, stage, note });
}

function getLiveLogPath(cwd: string, state: TaskState): string {
	if (state.liveLogPath) return state.liveLogPath;
	const reportDir = path.join(cwd, ".pi", "reports");
	ensureDir(reportDir);
	state.liveLogPath = path.join(reportDir, `${safeFilename(state.id)}.live.log`);
	return state.liveLogPath;
}

function getTraceDir(cwd: string, state: TaskState): string {
	if (state.traceDir) return state.traceDir;
	const reportDir = path.join(cwd, ".pi", "reports");
	ensureDir(reportDir);
	state.traceDir = path.join(reportDir, `${safeFilename(state.id)}.trace`);
	ensureDir(state.traceDir);
	return state.traceDir;
}

function previewFile(filePath: string | undefined, maxLines: number, maxCharsPerLine = 140): string[] {
	if (!filePath || !fs.existsSync(filePath)) return [];
	try {
		return fs
			.readFileSync(filePath, "utf-8")
			.split("\n")
			slice(0, maxLines)
			map((line) => (line.length > maxCharsPerLine ? `${line.slice(0, maxCharsPerLine - 3)}...` : line));
	} catch {
		return [];
	}
}

type WidgetMode = "compact" | "spec" | "prompt" | "result" | "history";
let widgetMode: WidgetMode = "compact";

function shortenMiddle(input: string, max = 88): string {
	if (input.length <= max) return input;
	const keep = Math.max(8, Math.floor((max - 3) / 2));
	return `${input.slice(0, keep)}...${input.slice(input.length - keep)}`;
}

function buildPanelPreview(
	title: string,
	filePath: string | undefined,
	lines: number,
	th: ExtensionContext["ui"]["theme"],
): string[] {
	const out: string[] = [];
	out.push(th.fg("muted", `${title}:`));
	out.push(`  ${th.fg("accent", filePath ? shortenMiddle(filePath, 104) : "(none)")}`);
	if (filePath) {
		for (const line of previewFile(filePath, lines, 110)) out.push(`  ${line}`);
	}
	return out;
}

function refreshLiveUi(ctx: ExtensionContext, state: TaskState): void {
	const th = ctx.ui.theme;
	const latest = state.history[state.history.length - 1];
	const statusNote = latest ? ` | ${latest.note}` : "";
	const statusColor =
		state.status === "completed" ? "success" : state.status === "failed" ? "error" : "accent";
	ctx.ui.setStatus(
		"pi-orchestrator",
		`${th.fg(statusColor, `Task ${state.id}`)} ${th.fg("muted", `${state.status} ${state.stage}${statusNote}`)}`,
	);

	const header: string[] = [
		th.fg("accent", "Pi Orchestrator"),
		`${th.fg("muted", "Task")} ${th.fg("accent", state.id)}`,
		`${th.fg("muted", "Status")} ${th.fg(statusColor, state.status)}  ${th.fg("muted", "Stage")} ${th.fg("warning", state.stage)}`,
		`${th.fg("muted", "Loops")} R ${state.reviewLoops}/${state.maxReviewLoops} | V ${state.validationLoops}/${state.maxValidationLoops}`,
		`${th.fg("muted", "Repo")} ${th.fg("accent", shortenMiddle(state.worktreePath ?? state.repoPath, 96))}`,
		`${th.fg("muted", "Branch")} ${th.fg("accent", state.worktreeBranch ?? "(unknown)")}`,
		`${th.fg("muted", "Agent")} ${state.activeAgentName ? th.fg("success", state.activeAgentName) : th.fg("dim", "idle")} ${th.fg("dim", state.activeAgentPurpose ? `(${state.activeAgentPurpose})` : "")}`,
		`${th.fg("muted", "View")} ${th.fg("accent", widgetMode)} ${th.fg("dim", "(switch: /orchestrate-widget <compact|spec|prompt|result|history>)")}`,
	];

	const body: string[] = [];
	if (widgetMode === "compact") {
		const hist = state.history.slice(-4).map((h) => `${th.fg("dim", h.at.slice(11, 19))} ${th.fg("warning", `[${h.stage}]`)} ${h.note}`);
		body.push(
			`${th.fg("muted", "Spec")} ${th.fg("accent", shortenMiddle(state.specPath ?? "(none)", 92))}`,
			`${th.fg("muted", "Prompt")} ${th.fg("accent", shortenMiddle(state.lastPromptPath ?? "(none)", 90))}`,
			`${th.fg("muted", "Result")} ${th.fg("accent", shortenMiddle(state.lastResultPath ?? "(none)", 90))}`,
			th.fg("muted", "Recent"),
			...hist,
		);
	} else if (widgetMode === "spec") {
		body.push(...buildPanelPreview("Spec", state.specPath, 10, th));
	} else if (widgetMode === "prompt") {
		body.push(...buildPanelPreview("Prompt", state.lastPromptPath, 12, th));
	} else if (widgetMode === "result") {
		body.push(...buildPanelPreview("Result", state.lastResultPath, 12, th));
	} else {
		body.push(
			th.fg("muted", "History:"),
			...state.history.slice(-18).map((h) => `${th.fg("dim", h.at)} ${th.fg("warning", `[${h.stage}]`)} ${h.note}`),
		);
	}

	ctx.ui.setWidget("pi-orchestrator-progress", [...header, "", ...body]);
	const quickActions = [
		th.fg("muted", "Quick actions:"),
		"  /orchestrate-status",
		`  /orchestrate-log ${state.id}`,
		`  /orchestrate-trace ${state.id}`,
	];
	ctx.ui.setWidget("pi-orchestrator-actions", quickActions, { placement: "belowEditor" });
}

function recordProgress(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: TaskState,
	stage: TaskStage,
	note: string,
): void {
	appendHistory(state, stage, note);
	persistTask(pi, state);
	const liveLogPath = getLiveLogPath(state.repoPath, state);
	fs.appendFileSync(liveLogPath, `${state.updatedAt} [${stage}] ${note}\n`, "utf-8");
	refreshLiveUi(ctx, state);
}

function persistTask(pi: ExtensionAPI, state: TaskState): void {
	pi.appendEntry("pi-orchestrator-task", state);
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
		});
	}
	return tasks;
}

function loadTaskById(ctx: ExtensionContext, taskId: string): TaskState | undefined {
	return loadPersistedTasks(ctx).get(taskId);
}

function saveFinalArtifacts(cwd: string, state: TaskState, reportMarkdown: string): void {
	const reportDir = path.join(cwd, ".pi", "reports");
	ensureDir(reportDir);
	const jsonPath = path.join(reportDir, `${safeFilename(state.id)}.json`);
	const mdPath = path.join(reportDir, `${safeFilename(state.id)}.md`);
	fs.writeFileSync(jsonPath, JSON.stringify(state, null, 2), "utf-8");
	fs.writeFileSync(mdPath, reportMarkdown, "utf-8");
	state.reportJsonPath = jsonPath;
	state.reportMarkdownPath = mdPath;
}

function buildReportMarkdown(state: TaskState, reporterOutput: string): string {
	const lines = [
		`# Pi Orchestrator Report: ${state.title}`,
		"",
		`- Task ID: ${state.id}`,
		`- Final Status: ${state.status.toUpperCase()}`,
		`- Final Stage: ${state.stage}`,
		`- Repository Root: ${state.repoPath}`,
		`- Worktree Path: ${state.worktreePath ?? "n/a"}`,
		`- Worktree Branch: ${state.worktreeBranch ?? "n/a"}`,
		`- Routed Implementation Agent: ${state.routedAgent ?? "n/a"}`,
		`- Codex Review Session: ${state.codexReviewSessionId ?? "n/a"}`,
		`- Branch: ${state.lastBranchName ?? "n/a"}`,
		`- Pull Request: ${state.lastPrUrl ?? "n/a"}`,
		`- PR Failure Reason: ${state.lastPrFailureReason ?? "n/a"}`,
		`- Commits: ${state.lastCommitShas && state.lastCommitShas.length > 0 ? state.lastCommitShas.join(", ") : "n/a"}`,
		`- Review Loops: ${state.reviewLoops}/${state.maxReviewLoops}`,
		`- Validation Loops: ${state.validationLoops}/${state.maxValidationLoops}`,
		"",
		"## Stage History",
		...state.history.map((h) => `- ${h.at} | ${h.stage} | ${h.note}`),
		"",
		"## Blocking Findings",
		...(state.blockingFindings.length > 0
			? state.blockingFindings.map((f) => `- [${f.severity}] ${f.title}: ${f.description}`)
			: ["- None"]),
		"",
		"## Validation Issues",
		...(state.validationIssues.length > 0 ? state.validationIssues.map((x) => `- ${x}`) : ["- None"]),
		"",
		"## Reporter Output",
		reporterOutput.trim() || "No reporter output.",
		"",
	];
	return lines.join("\n");
}

async function sendReportToMainAgentWebhook(state: TaskState): Promise<void> {
	const webhook = process.env.PI_MAIN_AGENT_WEBHOOK_URL;
	if (!webhook) return;
	const payload = {
		taskId: state.id,
		title: state.title,
		status: state.status,
		stage: state.stage,
		reportJsonPath: state.reportJsonPath,
		reportMarkdownPath: state.reportMarkdownPath,
		summary: summarizeState(state),
	};

	await fetch(webhook, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
}

async function runWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: TaskState,
	agents: Map<string, AgentConfig>,
): Promise<TaskState> {
	const getAgent = (name: string): AgentConfig => {
		const agent = agents.get(name);
		if (!agent) {
			throw new Error(`Missing required agent definition "${name}" in .pi/agents`);
		}
		return agent;
	};

	const runAgent = async (agentName: string, purpose: string, prompt: string): Promise<SubagentRun> => {
		const executionPath = state.worktreePath ?? state.repoPath;
		const contextualPrompt = [
			`Execution repository path: ${executionPath}`,
			`Repository root path: ${state.repoPath}`,
			`Execution git branch: ${state.worktreeBranch ?? "(unknown)"}`,
			"Do not clone this repository again. Work only in the execution repository path above.",
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
		state.lastPromptPath = promptPath;
		state.lastResultPath = undefined;
		persistTask(pi, state);
		refreshLiveUi(ctx, state);
		recordProgress(pi, ctx, state, state.stage, `Dispatching ${agentName} (${purpose})`);

		const started = Date.now();
		const heartbeat = setInterval(() => {
			const secs = Math.floor((Date.now() - started) / 1000);
			recordProgress(pi, ctx, state, state.stage, `Waiting on ${agentName} (${purpose}) for ${secs}s`);
		}, 60_000);
		const run = await runSubagent(
			pi,
			ctx,
			getAgent(agentName),
			contextualPrompt,
			executionPath,
			state.repoPath,
			executionPath,
			state.worktreeBranch,
		).finally(() => {
			clearInterval(heartbeat);
		});

		const resultBody = [
			`# Agent Result: ${agentName}`,
			"",
			`- Purpose: ${purpose}`,
			`- Exit Code: ${run.exitCode}`,
			`- OK: ${run.ok}`,
			"",
			"## Final Assistant Text",
			run.finalAssistantText || "(empty)",
			"",
			"## Full Assistant Text",
			run.fullAssistantText || "(empty)",
			"",
			"## Stderr",
			run.stderr || "(empty)",
			"",
		].join("\n");
		fs.writeFileSync(resultPath, resultBody, "utf-8");
		state.lastResultPath = resultPath;
		state.activeAgentName = undefined;
		state.activeAgentPurpose = undefined;
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
				},
				null,
				2,
			),
			"utf-8",
		);
		persistTask(pi, state);
		return run;
	};

	state.status = "running";
	persistTask(pi, state);
	refreshLiveUi(ctx, state);
	await ensureTaskWorktree(pi, state);
	recordProgress(
		pi,
		ctx,
		state,
		"received",
		`Worktree ready at ${state.worktreePath} on branch ${state.worktreeBranch}`,
	);

	// 1) Spec stage
	if (state.specPath && !fs.existsSync(state.specPath)) {
		state.specPath = undefined;
	}
	if (!state.specPath) {
		recordProgress(pi, ctx, state, "spec", "Generating central spec");
		const specPrompt = [
			"Create the central implementation spec for this task.",
			"Include a DECISION block (status/blocking/loop_back_to/pr_url), then DETAILS in normal English.",
			"Preferred format: Goal, Constraints, Acceptance Criteria, Complexity Signals, Implementation Phases, Phase Completion Checks, Implementation Notes.",
			"The spec should be implementation-oriented and phase-driven, with clear completion checks.",
			"JSON is optional.",
			"",
			`Target repository root path:\n${state.repoPath}`,
			`User task:\n${state.originalTask}`,
		].join("\n");
		const specRun = await runAgent("spec-writer", "spec-generation", specPrompt);
		if (!specRun.ok) throw new Error(`Spec agent failed: ${specRun.stderr || "unknown error"}`);
		const specJson = extractJsonObject(specRun.finalAssistantText) ?? extractJsonObject(specRun.fullAssistantText);
		const specData = normalizeSpecOutput(specRun.finalAssistantText || specRun.fullAssistantText, specJson, state.originalTask);

		const specDir = path.join(state.repoPath, ".pi", "specs");
		ensureDir(specDir);
		const specPath = path.join(specDir, `${safeFilename(state.id)}.md`);
		fs.writeFileSync(specPath, renderSpecMarkdown(state, specData), "utf-8");
		state.specPath = specPath;
		state.routedAgent = heuristicRoute(state.originalTask, specData.complexitySignals);
		recordProgress(pi, ctx, state, "implementation", `Spec created and routed to ${state.routedAgent}`);
	}

	const specText = fs.readFileSync(state.specPath, "utf-8");
	if (!state.routedAgent) {
		state.routedAgent = heuristicRoute(state.originalTask, []);
		recordProgress(pi, ctx, state, "implementation", `Route recovered to ${state.routedAgent}`);
	}
	let iterationFeedback = "";

	// 2) Implementation + review loop
	let approved = false;
	while (!approved) {
		if (state.reviewLoops >= state.maxReviewLoops) {
			throw new Error("Exceeded max review/fix loops");
		}
		state.reviewLoops += 1;
		recordProgress(pi, ctx, state, "implementation", `Implementation attempt ${state.reviewLoops}`);

		const implPrompt = [
			"Implement this spec in the repository. Apply real file changes and run relevant local tests.",
			"Do not commit, push, or check CI in this step. The reviewer stage owns commit/push/CI.",
			"Include a DECISION block (status/blocking/loop_back_to/pr_url), then DETAILS in normal English.",
			"Preferred response sections: Implementation Summary, Changed Files, Test Commands, Test Outcomes, Unresolved Risks.",
			"JSON is optional.",
			"",
			`Spec:\n${specText}`,
			iterationFeedback ? `\nFeedback to address:\n${iterationFeedback}` : "",
		].join("\n");
		const implRun = await runAgent(state.routedAgent!, "implementation", implPrompt);
		if (!implRun.ok) {
			iterationFeedback = `Implementation agent failed with stderr:\n${implRun.stderr}\nRetry and stabilize changes.`;
			recordProgress(pi, ctx, state, "fixing", "Implementation subprocess failed; retrying with feedback");
			continue;
		}
		const implJson = extractJsonObject(implRun.finalAssistantText) ?? extractJsonObject(implRun.fullAssistantText);
		const implNormalized = normalizeImplementationOutput(implRun.finalAssistantText || implRun.fullAssistantText, implJson);
		state.lastImplSummary = implNormalized.implementationSummary;
		persistTask(pi, state);

		recordProgress(pi, ctx, state, "review", `Reviewing implementation attempt ${state.reviewLoops}`);

		const reviewPrompt = [
			"Review the implementation against the spec, focusing on bugs, security, regressions, and missing tests.",
			"Reviewer stage owns git integration: commit pending changes, push branch, open/update PR, and check CI status.",
			"Run only the CI checks needed for this repo and include a concise pass/fail summary.",
			"Include a DECISION block (status/blocking/loop_back_to/pr_url), then DETAILS in normal English.",
			"Preferred response sections: Approval, Blocking Findings (with severity), Non-blocking Findings, Fix Instructions, Branch / Commits / PR, CI Status.",
			"JSON is optional.",
			state.codexReviewSessionId
				? `Reuse Codex review session id: ${state.codexReviewSessionId} (use codex exec resume).`
				: "If starting a fresh Codex review session, return codex_session_id in DECISION block.",
			"",
			`Spec:\n${specText}`,
			`Implementation summary:\n${state.lastImplSummary ?? "(none)"}`,
			`Current branch (if known):\n${state.lastBranchName ?? state.worktreeBranch ?? "(unknown)"}`,
		].join("\n");
		const reviewRun = await runAgent("reviewer", "review", reviewPrompt);
		if (!reviewRun.ok) {
			iterationFeedback = `Review subprocess failed:\n${reviewRun.stderr}\nRe-run review after stabilizing.`;
			recordProgress(pi, ctx, state, "fixing", "Review subprocess failed; rerouting to implementation");
			continue;
		}
		const reviewJson = extractJsonObject(reviewRun.finalAssistantText) ?? extractJsonObject(reviewRun.fullAssistantText);
		const reviewNormalized = normalizeReviewOutput(reviewRun.finalAssistantText || reviewRun.fullAssistantText, reviewJson);
		state.blockingFindings = reviewNormalized.blockingFindings;
		if (reviewNormalized.codexSessionId) state.codexReviewSessionId = reviewNormalized.codexSessionId;
		state.lastBranchName = reviewNormalized.branchName ?? state.lastBranchName;
		state.lastCommitShas = reviewNormalized.commitShas ?? state.lastCommitShas;
		state.lastPrUrl = reviewNormalized.prUrl ?? state.lastPrUrl;
		state.lastPrFailureReason = reviewNormalized.prFailureReason ?? state.lastPrFailureReason;
		state.lastReviewSummary = reviewRun.finalAssistantText;
		const reviewerApproved = reviewNormalized.approved;
		const hasBlocking = state.blockingFindings.some((f) => f.severity === "P0" || f.severity === "P1");

		if (reviewerApproved && !hasBlocking) {
			approved = true;
			recordProgress(pi, ctx, state, "validation", "Review approved");
		} else {
			const onlyMinorFindings =
				state.blockingFindings.length > 0 &&
				state.blockingFindings.every((f) => f.severity === "P2" || f.severity === "P3");

			if (!hasBlocking && onlyMinorFindings) {
				recordProgress(
					pi,
					ctx,
					state,
					"review",
					`Review reported only minor findings on attempt ${state.reviewLoops}; requesting implementation triage`,
				);
				const triagePrompt = [
					"You are triaging non-blocking review findings.",
					"Decide whether to fix now or defer minor issues and continue to validation.",
					"Respond with DECISION + DETAILS.",
					"If deferring, set DECISION loop_back_to: validation and blocking: no.",
					"",
					`Review findings:\n${state.blockingFindings.map((f) => `- [${f.severity}] ${f.title}: ${f.description}`).join("\n")}`,
					`Review fix instructions:\n${reviewNormalized.fixInstructions || "(none)"}`,
				].join("\n");
				const triageRun = await runAgent(state.routedAgent!, "review-minor-triage", triagePrompt);
				if (triageRun.ok) {
					const triageNormalized = normalizeImplementationOutput(
						triageRun.finalAssistantText || triageRun.fullAssistantText,
						extractJsonObject(triageRun.finalAssistantText) ?? extractJsonObject(triageRun.fullAssistantText),
					);
					const triageLoop = (triageNormalized.decisionLoopBackTo ?? "").toLowerCase();
					const triageBlocking = (triageNormalized.decisionBlocking ?? "").toLowerCase();
					const triageStatus = (triageNormalized.decisionStatus ?? "").toLowerCase();
					const deferToValidation =
						(triageLoop === "validation" || triageStatus === "approved") &&
						!(triageBlocking === "yes" || triageBlocking === "true");
					if (deferToValidation) {
						approved = true;
						recordProgress(
							pi,
							ctx,
							state,
							"validation",
							"Implementation triage deferred minor findings; proceeding to validation",
						);
						continue;
					}
				}
			}

			const fixInstructions = reviewNormalized.fixInstructions || "Fix reviewer findings and rerun.";
			iterationFeedback = [
				`Review failed on attempt ${state.reviewLoops}.`,
				`Fix instructions: ${fixInstructions}`,
				`Findings:`,
				...state.blockingFindings.map((f) => `- [${f.severity}] ${f.title}: ${f.description}`),
			].join("\n");
			recordProgress(pi, ctx, state, "fixing", `Review requested fixes on attempt ${state.reviewLoops}`);
		}
	}

	// 3) Validation stage (independent agent)
	let validated = false;
	while (!validated) {
		if (state.validationLoops >= state.maxValidationLoops) {
			throw new Error("Exceeded max validation loops");
		}
		state.validationLoops += 1;
		recordProgress(pi, ctx, state, "validation", `Validation attempt ${state.validationLoops}`);

		const validationPrompt = [
			"Independently validate this task. Do not trust prior review blindly.",
			"Check acceptance criteria coverage, regression risk, and test evidence.",
			"Include a DECISION block (status/blocking/loop_back_to/pr_url), then DETAILS in normal English.",
			"Preferred response sections: Passed/Failed, Issues, Evidence, Remediation.",
			"JSON is optional.",
			"",
			`Spec:\n${specText}`,
			`Latest implementation summary:\n${state.lastImplSummary ?? "(none)"}`,
			`Latest review summary:\n${state.lastReviewSummary ?? "(none)"}`,
		].join("\n");
		const validationRun = await runAgent("validator", "validation", validationPrompt);
		if (!validationRun.ok) {
			iterationFeedback = `Validation subprocess failed:\n${validationRun.stderr}\nHarden implementation and rerun.`;
			recordProgress(pi, ctx, state, "fixing", "Validation subprocess failed; returning to implementation");
			continue;
		}
		const validationJson =
			extractJsonObject(validationRun.finalAssistantText) ?? extractJsonObject(validationRun.fullAssistantText);
		const validationNormalized = normalizeValidationOutput(
			validationRun.finalAssistantText || validationRun.fullAssistantText,
			validationJson,
		);
		const passed = validationNormalized.passed;
		state.validationIssues = validationNormalized.issues;
		state.lastValidationSummary = validationRun.finalAssistantText;
		persistTask(pi, state);

		if (passed) {
			validated = true;
			recordProgress(pi, ctx, state, "reporting", "Validation passed");
			break;
		}

		iterationFeedback = [
			"Validation failed. Address these issues before retry:",
			...state.validationIssues.map((x) => `- ${x}`),
			`Remediation hint: ${validationNormalized.remediation || "Fix issues and re-run validation."}`,
		].join("\n");
		recordProgress(pi, ctx, state, "fixing", `Validation requested fixes on attempt ${state.validationLoops}`);

		// Re-enter implementation/review loop for validation failures.
		approved = false;
		while (!approved) {
			if (state.reviewLoops >= state.maxReviewLoops) {
				throw new Error("Exceeded max review/fix loops during validation remediation");
			}
			state.reviewLoops += 1;
			recordProgress(
				pi,
				ctx,
				state,
				"implementation",
				`Validation remediation implementation attempt ${state.reviewLoops}`,
			);

			const remediationPrompt = [
				"Apply fixes required by validation failure.",
				"Do not commit, push, or check CI in this step. The reviewer stage owns commit/push/CI.",
				"Include a DECISION block (status/blocking/loop_back_to/pr_url), then DETAILS in normal English.",
				"Preferred response sections: Implementation Summary, Changed Files, Test Commands, Test Outcomes, Unresolved Risks.",
				"JSON is optional.",
				"",
				`Spec:\n${specText}`,
				`Validation feedback:\n${iterationFeedback}`,
			].join("\n");
			const remediationRun = await runAgent(state.routedAgent!, "validation-remediation-implementation", remediationPrompt);
			if (!remediationRun.ok) {
				iterationFeedback = `Remediation implementation failed:\n${remediationRun.stderr}`;
				recordProgress(pi, ctx, state, "fixing", "Remediation implementation failed; retrying");
				continue;
			}
			const remediationJson =
				extractJsonObject(remediationRun.finalAssistantText) ?? extractJsonObject(remediationRun.fullAssistantText);
			const remediationNormalized = normalizeImplementationOutput(
				remediationRun.finalAssistantText || remediationRun.fullAssistantText,
				remediationJson,
			);
			state.lastImplSummary = remediationNormalized.implementationSummary;
			persistTask(pi, state);

			recordProgress(pi, ctx, state, "review", `Reviewing validation remediation attempt ${state.reviewLoops}`);
			const remediationReviewPrompt = [
				"Review this validation-remediation implementation.",
				"Reviewer stage owns git integration: commit pending changes, push branch, open/update PR, and check CI status.",
				"Run only the CI checks needed for this repo and include a concise pass/fail summary.",
				"Include a DECISION block (status/blocking/loop_back_to/pr_url), then DETAILS in normal English.",
				"Preferred response sections: Approval, Blocking Findings (with severity), Non-blocking Findings, Fix Instructions, Branch / Commits / PR, CI Status.",
				"JSON is optional.",
				state.codexReviewSessionId
					? `Reuse Codex review session id: ${state.codexReviewSessionId} (use codex exec resume).`
					: "If starting a fresh Codex review session, return codex_session_id in DECISION block.",
				"",
				`Spec:\n${specText}`,
				`Implementation summary:\n${state.lastImplSummary ?? "(none)"}`,
				`Validation issues being fixed:\n${state.validationIssues.join("\n")}`,
			].join("\n");
			const remediationReviewRun = await runAgent("reviewer", "validation-remediation-review", remediationReviewPrompt);
			if (!remediationReviewRun.ok) {
				iterationFeedback = `Remediation review failed:\n${remediationReviewRun.stderr}`;
				recordProgress(pi, ctx, state, "fixing", "Remediation review failed");
				continue;
			}
			const remediationReviewJson =
				extractJsonObject(remediationReviewRun.finalAssistantText) ??
				extractJsonObject(remediationReviewRun.fullAssistantText);
			const remediationReviewNormalized = normalizeReviewOutput(
				remediationReviewRun.finalAssistantText || remediationReviewRun.fullAssistantText,
				remediationReviewJson,
			);
			if (remediationReviewNormalized.codexSessionId) {
				state.codexReviewSessionId = remediationReviewNormalized.codexSessionId;
			}
			state.lastBranchName = remediationReviewNormalized.branchName ?? state.lastBranchName;
			state.lastCommitShas = remediationReviewNormalized.commitShas ?? state.lastCommitShas;
			state.lastPrUrl = remediationReviewNormalized.prUrl ?? state.lastPrUrl;
			state.lastPrFailureReason = remediationReviewNormalized.prFailureReason ?? state.lastPrFailureReason;
			state.blockingFindings = remediationReviewNormalized.blockingFindings;
			const remediationApproved = remediationReviewNormalized.approved;
			const remediationHasBlocking = state.blockingFindings.some((f) => f.severity === "P0" || f.severity === "P1");
			if (remediationApproved && !remediationHasBlocking) {
				approved = true;
				recordProgress(pi, ctx, state, "validation", "Remediation review approved");
			} else {
				iterationFeedback = remediationReviewNormalized.fixInstructions || "Fix remediation findings.";
				recordProgress(pi, ctx, state, "fixing", "Remediation review requested additional changes");
			}
		}
	}

	// 4) Final report stage
	recordProgress(pi, ctx, state, "reporting", "Generating final report for main agent");

	const reporterPrompt = [
		"Generate the final handoff report for the main orchestrating agent.",
		"Include: outcome, what was changed, test/validation confidence, open risks, and deployment readiness.",
		"",
		`State summary:\n${summarizeState(state)}`,
		`Implementation summary:\n${state.lastImplSummary ?? "(none)"}`,
		`Branch:\n${state.lastBranchName ?? "(none)"}`,
		`PR URL:\n${state.lastPrUrl ?? "(none)"}`,
		`PR failure reason:\n${state.lastPrFailureReason ?? "(none)"}`,
		`Review summary:\n${state.lastReviewSummary ?? "(none)"}`,
		`Validation summary:\n${state.lastValidationSummary ?? "(none)"}`,
	].join("\n");

	let reporterOutput = "";
	const reporterRun = await runAgent("reporter", "final-report", reporterPrompt);
	if (reporterRun.ok) {
		reporterOutput = reporterRun.finalAssistantText || reporterRun.fullAssistantText;
	} else {
		reporterOutput = `Reporter agent failed. stderr:\n${reporterRun.stderr}`;
	}

	state.status = "completed";
	recordProgress(pi, ctx, state, "done", "Workflow completed");

	const reportMarkdown = buildReportMarkdown(state, reporterOutput);
	saveFinalArtifacts(state.repoPath, state, reportMarkdown);
	persistTask(pi, state);
	await sendReportToMainAgentWebhook(state);

	return state;
}

function parseTitle(task: string): string {
	const oneLine = task.trim().split("\n")[0] ?? "Untitled task";
	return oneLine.length > 96 ? `${oneLine.slice(0, 93)}...` : oneLine;
}

function createTask(taskInput: string, cwd: string): TaskState {
	const created = nowIso();
	const repoPath = deriveRepoPathFromTask(taskInput, cwd);
	return {
		id: `task-${Date.now()}-${randomUUID().slice(0, 8)}`,
		title: parseTitle(taskInput),
		originalTask: taskInput.trim(),
		repoPath,
		status: "queued",
		stage: "received",
		createdAt: created,
		updatedAt: created,
		reviewLoops: 0,
		validationLoops: 0,
		maxReviewLoops: 3,
		maxValidationLoops: 3,
		blockingFindings: [],
		validationIssues: [],
		history: [{ at: created, stage: "received", note: "Task received by Pi orchestrator" }],
	};
}

async function handleRun(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: TaskState,
	inMemoryTasks: Map<string, TaskState>,
): Promise<void> {
	const agents = loadProjectAgents(ctx.cwd);
	const required = ["spec-writer", "codex-impl", "amp-impl", "reviewer", "validator", "reporter"];
	const missing = required.filter((x) => !agents.has(x));
	if (missing.length > 0) {
		throw new Error(`Missing required .pi/agents definitions: ${missing.join(", ")}`);
	}

	inMemoryTasks.set(state.id, state);
	persistTask(pi, state);

	try {
		const finalState = await runWorkflow(pi, ctx, state, agents);
		refreshLiveUi(ctx, finalState);
		pi.sendMessage(
			{
				customType: "pi-orchestrator-report",
				display: true,
				content: [
					"Pi orchestrator completed task.",
					"",
					summarizeState(finalState),
					"",
					`Report JSON: ${finalState.reportJsonPath}`,
					`Report Markdown: ${finalState.reportMarkdownPath}`,
				].join("\n"),
			},
			{ triggerTurn: false },
		);
	} catch (err) {
		state.status = "failed";
		recordProgress(pi, ctx, state, "failed", err instanceof Error ? err.message : String(err));
		pi.sendMessage(
			{
				customType: "pi-orchestrator-report",
				display: true,
				content: [
					"Pi orchestrator failed task.",
					"",
					summarizeState(state),
					"",
					`Error: ${err instanceof Error ? err.message : String(err)}`,
				].join("\n"),
			},
			{ triggerTurn: false },
		);
		throw err;
	}
}

export default function piOrchestratorExtension(pi: ExtensionAPI): void {
	const tasks = new Map<string, TaskState>();
	let activeTaskId: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		const restored = loadPersistedTasks(ctx);
		for (const [id, state] of restored) tasks.set(id, state);
		const running = Array.from(tasks.values()).find((t) => t.status === "running");
		if (running) {
			refreshLiveUi(ctx, running);
			ctx.ui.notify(`Resume with /orchestrate-resume ${running.id}`, "info");
		}
	});

	pi.registerCommand("orchestrate", {
		description: "Run autonomous Pi orchestration: spec -> implement -> review/fix -> validate -> report",
		handler: async (args, ctx) => {
			const taskInput = (args ?? "").trim();
			if (!taskInput) {
				ctx.ui.notify("Usage: /orchestrate <task description>", "warning");
				return;
			}
			if (activeTaskId) {
				ctx.ui.notify(`Task ${activeTaskId} is already running. Use /orchestrate-status`, "warning");
				return;
			}
			const state = createTask(taskInput, ctx.cwd);
			activeTaskId = state.id;
			try {
				await handleRun(pi, ctx, state, tasks);
			} finally {
				activeTaskId = undefined;
			}
		},
	});

	pi.registerCommand("orchestrate-status", {
		description: "Show Pi orchestrator task summaries",
		handler: async (_args, ctx) => {
			if (tasks.size === 0) {
				ctx.ui.notify("No orchestrator tasks found yet.", "info");
				return;
			}
			const ordered = Array.from(tasks.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
			const summary = ordered
				.slice(0, 8)
				.map((t) => `- ${t.id} | ${t.status} | ${t.stage} | ${t.title} | ${t.history[t.history.length - 1]?.note ?? ""}`)
				.join("\n");
			ctx.ui.notify(`Recent tasks:\n${summary}`, "info");
		},
	});

	pi.registerCommand("orchestrate-widget", {
		description: "Set widget view mode: /orchestrate-widget <compact|spec|prompt|result|history>",
		handler: async (args, ctx) => {
			const mode = ((args ?? "").trim().toLowerCase() || "compact") as WidgetMode;
			const allowed: WidgetMode[] = ["compact", "spec", "prompt", "result", "history"];
			if (!allowed.includes(mode)) {
				ctx.ui.notify("Usage: /orchestrate-widget <compact|spec|prompt|result|history>", "warning");
				return;
			}
			widgetMode = mode;
			const active = activeTaskId ? tasks.get(activeTaskId) : undefined;
			const latest =
				active ??
				Array.from(tasks.values())
					.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
					.at(0);
			if (latest) refreshLiveUi(ctx, latest);
			ctx.ui.notify(`Orchestrator widget mode: ${mode}`, "info");
		},
	});

	pi.registerCommand("orchestrate-log", {
		description: "Show detailed stage history for one task: /orchestrate-log <task-id>",
		handler: async (args, ctx) => {
			const taskId = (args ?? "").trim();
			if (!taskId) {
				ctx.ui.notify("Usage: /orchestrate-log <task-id>", "warning");
				return;
			}
			const task = tasks.get(taskId) ?? loadTaskById(ctx, taskId);
			if (!task) {
				ctx.ui.notify(`Task not found: ${taskId}`, "warning");
				return;
			}
			const lines = task.history.map((h) => `- ${h.at} | ${h.stage} | ${h.note}`).join("\n");
			ctx.ui.notify(`History for ${taskId}:\n${lines}`, "info");
			refreshLiveUi(ctx, task);
		},
	});

	pi.registerCommand("orchestrate-trace", {
		description: "Show prompt/response trace files: /orchestrate-trace <task-id>",
		handler: async (args, ctx) => {
			const taskId = (args ?? "").trim();
			if (!taskId) {
				ctx.ui.notify("Usage: /orchestrate-trace <task-id>", "warning");
				return;
			}
			const task = tasks.get(taskId) ?? loadTaskById(ctx, taskId);
			if (!task) {
				ctx.ui.notify(`Task not found: ${taskId}`, "warning");
				return;
			}
			const traceDir = task.traceDir ?? getTraceDir(task.repoPath, task);
			if (!fs.existsSync(traceDir)) {
				ctx.ui.notify(`No trace directory yet: ${traceDir}`, "info");
				return;
			}
			const files = fs
				.readdirSync(traceDir)
				.filter((f) => f.endsWith(".prompt.md") || f.endsWith(".result.md") || f.endsWith(".meta.json"))
				.sort()
				.slice(-24)
				.map((f) => `- ${path.join(traceDir, f)}`);
			ctx.ui.notify(
				`Trace files for ${taskId}:\n${files.join("\n") || "(none yet)"}\n\nTip: open *.prompt.md to see exact prompts, *.result.md for outputs.`,
				"info",
			);
		},
	});

	pi.registerCommand("orchestrate-resume", {
		description: "Resume a previously failed/running orchestrator task by id",
		handler: async (args, ctx) => {
			const taskId = (args ?? "").trim();
			if (!taskId) {
				ctx.ui.notify("Usage: /orchestrate-resume <task-id>", "warning");
				return;
			}
			if (activeTaskId) {
				ctx.ui.notify(`Task ${activeTaskId} is already running.`, "warning");
				return;
			}
			const fromMemory = tasks.get(taskId);
			const fromSession = fromMemory ?? loadTaskById(ctx, taskId);
			if (!fromSession) {
				ctx.ui.notify(`Task not found: ${taskId}`, "warning");
				return;
			}
			const state: TaskState = {
				...fromSession,
				repoPath: fromSession.repoPath ?? ctx.cwd,
				status: "queued",
				updatedAt: nowIso(),
			};
			recordProgress(pi, ctx, state, "received", "Task resumed by /orchestrate-resume");
			activeTaskId = state.id;
			try {
				await handleRun(pi, ctx, state, tasks);
			} finally {
				activeTaskId = undefined;
			}
		},
	});
}
