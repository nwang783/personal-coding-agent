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

type DispatchRecord = {
  at: string;
  agent: string;
  provider: "codex" | "amp";
  taskKind: "spec" | "implementation" | "review" | "validation";
  promptPreview?: string;
  resultSummary?: string;
  timing?: number;
  timedOut?: boolean;
  sessionId?: string;
};

type ProgressEntry = {
  at: string;
  agent: string;
  line: string;
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
  liveStatePath?: string;
  traceDir?: string;
  reportJsonPath?: string;
  reportMarkdownPath?: string;
  progressPath?: string;
  promptDraftPath?: string;
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
  lastArtifacts?: Record<string, unknown>;
  finalReport?: string;
  history: HistoryEntry[];
  traceSeq?: number;
  activeAgentName?: string;
  lastPromptPath?: string;
  lastResultPath?: string;
  lastDispatchPromptPath?: string;
  lastDispatchResultPath?: string;
  dispatchHistory: DispatchRecord[];
  progressEntries: ProgressEntry[];
  lastDispatchProvider?: "codex" | "amp";
  workflowBugReport?: string;
  liveLogPath?: string;
  streamEvents?: StreamEvent[];
  stopRequested?: boolean;
};

type TaskSummary = {
  id: string;
  title: string;
  status: TaskStatus;
  stage: TaskStage;
  updatedAt: string;
  currentAgent?: string;
  activeAgentName?: string;
  lastProgressLine?: string;
  lastNote?: string;
  reviewLoops: number;
  validationLoops: number;
  maxReviewLoops: number;
  maxValidationLoops: number;
  handoffCount: number;
  failureKind?: string;
  stopRequested?: boolean;
};

type TaskDetailResponse = {
  task: TaskState;
  summaries: {
    progressPreview?: string;
    promptPreview?: string;
    resultPreview?: string;
    reportPreview?: string;
  };
  traceFiles: Array<{
    name: string;
    path: string;
    kind: "prompt" | "result" | "meta" | "other";
  }>;
};

const repoRoot = process.cwd();
const projectsRoot = path.dirname(repoRoot);

function getCandidateReportsDirs(): string[] {
  const dirs = new Set<string>([path.join(repoRoot, ".pi", "reports")]);
  try {
    for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      dirs.add(path.join(projectsRoot, entry.name, ".pi", "reports"));
    }
  } catch {
    // ignore
  }
  return Array.from(dirs).filter((dir) => fs.existsSync(dir));
}

function getReportsDirForTask(task: TaskState): string {
  return path.join(task.repoPath, ".pi", "reports");
}

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
  const candidates = getCandidateReportsDirs()
    .flatMap((reportsDir) => [
      path.join(reportsDir, `${taskId}.state.json`),
      path.join(reportsDir, `${taskId}.json`),
    ])
    .filter((filePath) => fs.existsSync(filePath));

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
  const ids = new Set<string>();
  for (const reportsDir of getCandidateReportsDirs()) {
    for (const entry of fs.readdirSync(reportsDir)) {
      const match = entry.match(/^(task-[^.]+)(?:\.state)?\.json$/);
      if (match) ids.add(match[1]);
    }
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
      lastProgressLine: (task.progressEntries ?? []).at(-1)?.line,
      lastNote: task.history.at(-1)?.note,
      reviewLoops: task.reviewLoops,
      validationLoops: task.validationLoops,
      maxReviewLoops: task.maxReviewLoops,
      maxValidationLoops: task.maxValidationLoops,
      handoffCount: task.handoffCount,
      failureKind: task.failureKind,
      stopRequested: task.stopRequested,
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

function getStopRequestPath(task: TaskState): string {
  return path.join(getReportsDirForTask(task), `${task.id}.stop`);
}

function requestTaskStop(task: TaskState): { ok: boolean; error?: string } {
  try {
    fs.writeFileSync(getStopRequestPath(task), `Stop requested at ${new Date().toISOString()}\n`, "utf-8");
    if (task.liveStatePath && fs.existsSync(task.liveStatePath)) {
      const nextTask = { ...task, stopRequested: true };
      fs.writeFileSync(task.liveStatePath, JSON.stringify(nextTask, null, 2), "utf-8");
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function buildTaskDetail(taskId: string): TaskDetailResponse | undefined {
  const task = loadTask(taskId);
  if (!task) return undefined;

  return {
    task,
    summaries: {
      progressPreview: readPreview(task.progressPath, 20),
      promptPreview: readPreview(task.lastPromptPath),
      resultPreview: readPreview(task.lastResultPath),
      reportPreview: readPreview(task.reportMarkdownPath ?? path.join(getReportsDirForTask(task), `${task.id}.md`), 24),
    },
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
    if ((url === "/" || url === "") && req.method === "GET") {
      sendJson(res, { tasks: listTasks() });
      return;
    }

    const pathname = url.replace(/^\/+/, "").split("?")[0] ?? "";
    const isStopRequest = pathname.endsWith("/stop");
    const taskId = decodeURIComponent(isStopRequest ? pathname.slice(0, -"/stop".length) : pathname);
    if (!taskId) {
      sendJson(res, { error: "Task id required" }, 400);
      return;
    }

    const detail = buildTaskDetail(taskId);
    if (!detail) {
      sendJson(res, { error: `Task not found: ${taskId}` }, 404);
      return;
    }
    if (req.method === "POST" && isStopRequest) {
      const stop = requestTaskStop(detail.task);
      sendJson(res, stop.ok ? { ok: true } : { error: stop.error ?? "Unable to stop task" }, stop.ok ? 200 : 500);
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, { error: "Method not allowed" }, 405);
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
