import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type PreviewServer, type ViteDevServer } from "vite";

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

type HistoryEntry = {
  at: string;
  stage: TaskStage;
  note: string;
};

type StreamEvent = {
  at: string;
  agent: string;
  purpose: string;
  kind: string;
  text: string;
};

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

type HandoffRecord = {
  at: string;
  fromAgent: string;
  toAgent: string;
  summary: string;
  message: string;
  reason?: string;
  artifacts?: Record<string, unknown>;
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
  routedAgent?: "codex-impl" | "amp-impl";
  reviewLoops: number;
  validationLoops: number;
  maxReviewLoops: number;
  maxValidationLoops: number;
  handoffCount: number;
  currentAgent?: string;
  lastHandoff?: HandoffRecord;
  handoffHistory: HandoffRecord[];
  failureKind?: string;
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
  lastArtifacts?: Record<string, unknown>;
  finalReport?: string;
  history: HistoryEntry[];
  traceSeq?: number;
  activeAgentName?: string;
  activeAgentPurpose?: string;
  lastPromptPath?: string;
  lastResultPath?: string;
  lastSubagentCommand?: string;
  lastStreamEvent?: string;
  streamEvents?: StreamEvent[];
};

type TaskSummary = {
  id: string;
  title: string;
  status: TaskStatus;
  stage: TaskStage;
  updatedAt: string;
  activeAgentName?: string;
  activeAgentPurpose?: string;
  routedAgent?: "codex-impl" | "amp-impl";
  lastNote?: string;
  reviewLoops: number;
  validationLoops: number;
  maxReviewLoops: number;
  maxValidationLoops: number;
};

type TaskDetailResponse = {
  task: TaskState;
  summaries: {
    specPreview?: string;
    promptPreview?: string;
    resultPreview?: string;
    reportPreview?: string;
  };
  liveLogTail: string[];
  traceFiles: Array<{
    name: string;
    path: string;
    kind: "prompt" | "result" | "meta" | "other";
  }>;
};

const repoRoot = process.cwd();
const reportsDir = path.join(repoRoot, ".pi", "reports");

function safeReadJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function readPreview(filePath: string | undefined, maxLines = 18): string | undefined {
  if (!filePath || !fs.existsSync(filePath)) return undefined;
  return fs.readFileSync(filePath, "utf-8").split("\n").slice(0, maxLines).join("\n");
}

function parseStreamEvents(liveLogPath: string | undefined): StreamEvent[] {
  if (!liveLogPath || !fs.existsSync(liveLogPath)) return [];
  const lines = fs.readFileSync(liveLogPath, "utf-8").split("\n").filter(Boolean);
  return lines
    .map((line) => {
      const match = line.match(/^(\S+)\s+\[stream:([^:]+):([^\]]+)\]\s+(.*)$/);
      if (!match) return undefined;
      return {
        at: match[1],
        agent: match[2],
        purpose: "",
        kind: match[3],
        text: match[4],
      };
    })
    .filter((entry): entry is StreamEvent => Boolean(entry))
    .slice(-80);
}

function loadTask(taskId: string): TaskState | undefined {
  const candidates = [
    path.join(reportsDir, `${taskId}.state.json`),
    path.join(reportsDir, `${taskId}.json`),
  ].filter((filePath) => fs.existsSync(filePath));

  if (candidates.length === 0) return undefined;
  const latest = candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const task = safeReadJson<TaskState>(latest);
  if (!task) return undefined;
  if ((!task.streamEvents || task.streamEvents.length === 0) && task.liveLogPath) {
    task.streamEvents = parseStreamEvents(task.liveLogPath);
  }
  return task;
}

function loadTaskIds(): string[] {
  if (!fs.existsSync(reportsDir)) return [];
  const ids = new Set<string>();
  for (const entry of fs.readdirSync(reportsDir)) {
    const match = entry.match(/^(task-[^.]+)(?:\.state)?\.json$/);
    if (match) ids.add(match[1]);
  }
  return Array.from(ids);
}

function listTasks(): TaskSummary[] {
  return loadTaskIds()
    .map((taskId) => loadTask(taskId))
    .filter((task): task is TaskState => Boolean(task))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      stage: task.stage,
      updatedAt: task.updatedAt,
      currentAgent: task.currentAgent,
      activeAgentName: task.activeAgentName,
      activeAgentPurpose: task.activeAgentPurpose,
      routedAgent: task.routedAgent,
      lastNote: task.history.at(-1)?.note,
      reviewLoops: task.reviewLoops,
      validationLoops: task.validationLoops,
      maxReviewLoops: task.maxReviewLoops,
      maxValidationLoops: task.maxValidationLoops,
      handoffCount: task.handoffCount,
      failureKind: task.failureKind,
    }));
}

function listTraceFiles(traceDir: string | undefined): TaskDetailResponse["traceFiles"] {
  if (!traceDir || !fs.existsSync(traceDir)) return [];
  return fs.readdirSync(traceDir).sort().map((name) => ({
    name,
    path: path.join(traceDir, name),
    kind: name.endsWith(".prompt.md")
      ? "prompt"
      : name.endsWith(".result.md")
        ? "result"
        : name.endsWith(".meta.json")
          ? "meta"
          : "other",
  }));
}

function buildTaskDetail(taskId: string): TaskDetailResponse | undefined {
  const task = loadTask(taskId);
  if (!task) return undefined;

  return {
    task,
    summaries: {
      specPreview: readPreview(task.specPath),
      promptPreview: readPreview(task.lastPromptPath),
      resultPreview: readPreview(task.lastResultPath),
      reportPreview: readPreview(task.reportMarkdownPath ?? path.join(reportsDir, `${task.id}.md`), 24),
    },
    liveLogTail:
      task.liveLogPath && fs.existsSync(task.liveLogPath)
        ? fs.readFileSync(task.liveLogPath, "utf-8").split("\n").filter(Boolean).slice(-80)
        : [],
    traceFiles: listTraceFiles(task.traceDir),
  };
}

function sendJson(
  res: { setHeader: (name: string, value: string) => void; end: (body: string) => void },
  body: unknown,
  statusCode = 200,
): void {
  Object.assign(res, { statusCode });
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function attachApi(server: ViteDevServer | PreviewServer): void {
  server.middlewares.use("/api/tasks", (req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "") {
      sendJson(res, { tasks: listTasks() });
      return;
    }

    const taskId = decodeURIComponent(url.replace(/^\/+/, "").split("?")[0] ?? "");
    if (!taskId) {
      sendJson(res, { error: "Task id required" }, 400);
      return;
    }

    const detail = buildTaskDetail(taskId);
    if (!detail) {
      sendJson(res, { error: `Task not found: ${taskId}` }, 404);
      return;
    }
    sendJson(res, detail);
  });
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "pi-orchestrator-api",
      configureServer(server) {
        attachApi(server);
      },
      configurePreviewServer(server) {
        attachApi(server);
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 4173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
});
