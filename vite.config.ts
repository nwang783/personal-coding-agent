import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
  diffStats?: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
  publishStatus?: {
    branch?: string;
    hasChanges: boolean;
    stagedFiles: number;
    unstagedFiles: number;
    untrackedFiles: number;
    ahead: number;
    behind: number;
    prUrl?: string;
  };
  summaries: {
    progressPreview?: string;
    promptPreview?: string;
    resultPreview?: string;
    dispatchPromptPreview?: string;
    dispatchResultPreview?: string;
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

function persistTaskState(task: TaskState): void {
  if (!task.liveStatePath) return;
  fs.writeFileSync(task.liveStatePath, JSON.stringify(task, null, 2), "utf-8");
}

function readPreview(filePath: string | undefined, maxLines = 18): string | undefined {
  if (!filePath || !fs.existsSync(filePath)) return undefined;
  return fs.readFileSync(filePath, "utf-8").split("\n").slice(0, maxLines).join("\n");
}

function listTraceFilePaths(traceDir: string | undefined): string[] {
  if (!traceDir || !fs.existsSync(traceDir)) return [];
  return fs
    .readdirSync(traceDir)
    .sort()
    .map((name) => path.join(traceDir, name));
}

function findLatestTraceFile(
  traceDir: string | undefined,
  predicate: (filePath: string) => boolean,
): string | undefined {
  return listTraceFilePaths(traceDir).filter(predicate).at(-1);
}

function normalizeTask(task: TaskState): TaskState {
  const traceDir = task.traceDir;
  const derivedDispatchPromptPath =
    task.lastDispatchPromptPath ??
    findLatestTraceFile(traceDir, (filePath) => filePath.endsWith(".delegated.prompt.md"));
  const derivedDispatchResultPath =
    task.lastDispatchResultPath ??
    findLatestTraceFile(traceDir, (filePath) => filePath.endsWith(".delegated.result.md"));
  const derivedResultPath =
    task.lastResultPath ??
    findLatestTraceFile(
      traceDir,
      (filePath) => filePath.endsWith(".result.md") && !filePath.endsWith(".delegated.result.md"),
    );
  const derivedPromptPath =
    task.lastPromptPath ??
    findLatestTraceFile(
      traceDir,
      (filePath) => filePath.endsWith(".prompt.md") && !filePath.endsWith(".delegated.prompt.md"),
    );

  return {
    ...task,
    lastPromptPath: derivedPromptPath,
    lastResultPath: derivedResultPath,
    lastDispatchPromptPath: derivedDispatchPromptPath,
    lastDispatchResultPath: derivedDispatchResultPath,
  };
}

function getBaseBranchName(repoPath: string): string | undefined {
  try {
    const branch = execFileSync("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch && branch !== "HEAD" ? branch : undefined;
  } catch {
    return undefined;
  }
}

function parseShortStat(output: string): TaskDetailResponse["diffStats"] | undefined {
  const text = output.trim();
  if (!text) {
    return { filesChanged: 0, additions: 0, deletions: 0 };
  }

  const filesChanged = Number(text.match(/(\d+)\s+files? changed/)?.[1] ?? 0);
  const additions = Number(text.match(/(\d+)\s+insertions?\(\+\)/)?.[1] ?? 0);
  const deletions = Number(text.match(/(\d+)\s+deletions?\(-\)/)?.[1] ?? 0);
  return { filesChanged, additions, deletions };
}

function getDiffStats(task: TaskState): TaskDetailResponse["diffStats"] | undefined {
  if (!task.worktreePath || !fs.existsSync(task.worktreePath)) return undefined;
  const baseBranch = getBaseBranchName(task.repoPath);
  if (!baseBranch) return undefined;

  try {
    const mergeBase = execFileSync("git", ["-C", task.worktreePath, "merge-base", "HEAD", baseBranch], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const shortStat = execFileSync(
      "git",
      ["-C", task.worktreePath, "diff", "--shortstat", mergeBase, "--", ".", ":(exclude).pi"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return parseShortStat(shortStat);
  } catch {
    return undefined;
  }
}

function runGit(task: TaskState, args: string[]): string {
  if (!task.worktreePath || !fs.existsSync(task.worktreePath)) {
    throw new Error("Task worktree is unavailable");
  }
  return execFileSync("git", ["-C", task.worktreePath, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runGh(task: TaskState, args: string[]): string {
  if (!task.worktreePath || !fs.existsSync(task.worktreePath)) {
    throw new Error("Task worktree is unavailable");
  }
  return execFileSync("gh", args, {
    cwd: task.worktreePath,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function getPublishStatus(task: TaskState): TaskDetailResponse["publishStatus"] | undefined {
  if (!task.worktreePath || !fs.existsSync(task.worktreePath)) return undefined;

  try {
    const status = runGit(task, ["status", "--porcelain=2", "--branch"]);
    let branch = task.lastBranchName ?? task.worktreeBranch;
    let ahead = 0;
    let behind = 0;
    let stagedFiles = 0;
    let unstagedFiles = 0;
    let untrackedFiles = 0;

    for (const line of status.split("\n")) {
      if (line.startsWith("# branch.head ")) {
        const value = line.slice("# branch.head ".length).trim();
        if (value && value !== "(detached)") branch = value;
        continue;
      }
      if (line.startsWith("# branch.ab ")) {
        const match = line.match(/^\# branch\.ab \+(\d+) \-(\d+)$/);
        ahead = Number(match?.[1] ?? 0);
        behind = Number(match?.[2] ?? 0);
        continue;
      }
      if (line.startsWith("1 ") || line.startsWith("2 ")) {
        const parts = line.split(" ");
        const xy = parts[1] ?? "..";
        if (xy[0] && xy[0] !== ".") stagedFiles += 1;
        if (xy[1] && xy[1] !== ".") unstagedFiles += 1;
        continue;
      }
      if (line.startsWith("? ")) {
        untrackedFiles += 1;
      }
    }

    const prUrl = task.lastPrUrl ?? (() => {
      try {
        const raw = runGh(task, ["pr", "view", "--json", "url"]);
        const parsed = JSON.parse(raw) as { url?: string };
        return parsed.url;
      } catch {
        return undefined;
      }
    })();

    return {
      branch,
      hasChanges: stagedFiles + unstagedFiles + untrackedFiles > 0,
      stagedFiles,
      unstagedFiles,
      untrackedFiles,
      ahead,
      behind,
      prUrl,
    };
  } catch {
    return undefined;
  }
}

function getHeadCommit(task: TaskState): string | undefined {
  try {
    return runGit(task, ["rev-parse", "HEAD"]);
  } catch {
    return undefined;
  }
}

function commitTaskChanges(task: TaskState, message: string): { ok: boolean; commitSha?: string; error?: string } {
  try {
    runGit(task, ["add", "-A", "--", ".", ":(exclude).pi"]);
    try {
      runGit(task, ["diff", "--cached", "--quiet", "--", ".", ":(exclude).pi"]);
      return { ok: false, error: "No staged changes to commit" };
    } catch {
      // git diff --quiet exits non-zero when there are staged changes
    }
    runGit(task, ["commit", "-m", message]);
    task.lastBranchName = runGit(task, ["branch", "--show-current"]) || task.lastBranchName;
    task.lastCommitShas = [getHeadCommit(task)].filter((value): value is string => Boolean(value));
    persistTaskState(task);
    return { ok: true, commitSha: task.lastCommitShas?.[0] };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function pushTaskBranch(task: TaskState): { ok: boolean; branch?: string; error?: string } {
  try {
    const branch = runGit(task, ["branch", "--show-current"]);
    if (!branch) return { ok: false, error: "No active branch in task worktree" };
    runGit(task, ["push", "-u", "origin", branch]);
    task.lastBranchName = branch;
    persistTaskState(task);
    return { ok: true, branch };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function openTaskPr(
  task: TaskState,
  title: string,
  body: string,
): { ok: boolean; prUrl?: string; error?: string; existing?: boolean } {
  try {
    try {
      const existing = JSON.parse(runGh(task, ["pr", "view", "--json", "url"])) as { url?: string };
      if (existing.url) {
        task.lastPrUrl = existing.url;
        persistTaskState(task);
        return { ok: true, prUrl: existing.url, existing: true };
      }
    } catch {
      // no existing PR or gh unavailable for view; try create next
    }

    const url = runGh(task, ["pr", "create", "--title", title, "--body", body]);
    task.lastPrUrl = url.split("\n").find((line) => line.startsWith("http")) ?? url;
    task.lastBranchName = runGit(task, ["branch", "--show-current"]) || task.lastBranchName;
    persistTaskState(task);
    return { ok: true, prUrl: task.lastPrUrl };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readJsonBody<T>(req: NodeJS.ReadableStream): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
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
  return normalizeTask(task);
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
    diffStats: getDiffStats(task),
    publishStatus: getPublishStatus(task),
    summaries: {
      progressPreview: readPreview(task.progressPath, 20),
      promptPreview: readPreview(task.lastPromptPath),
      resultPreview: readPreview(task.lastResultPath),
      dispatchPromptPreview: readPreview(task.lastDispatchPromptPath),
      dispatchResultPreview: readPreview(task.lastDispatchResultPath),
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
    const action =
      pathname.endsWith("/stop") ? "stop"
      : pathname.endsWith("/commit") ? "commit"
      : pathname.endsWith("/push") ? "push"
      : pathname.endsWith("/open-pr") ? "open-pr"
      : undefined;
    const taskId = decodeURIComponent(action ? pathname.slice(0, -(action.length + 1)) : pathname);
    if (!taskId) {
      sendJson(res, { error: "Task id required" }, 400);
      return;
    }

    const detail = buildTaskDetail(taskId);
    if (!detail) {
      sendJson(res, { error: `Task not found: ${taskId}` }, 404);
      return;
    }
    if (req.method === "POST" && action) {
      void (async () => {
        if (action === "stop") {
          const stop = requestTaskStop(detail.task);
          sendJson(res, stop.ok ? { ok: true } : { error: stop.error ?? "Unable to stop task" }, stop.ok ? 200 : 500);
          return;
        }
        if (action === "commit") {
          const body = await readJsonBody<{ message?: string }>(req);
          const message = body.message?.trim() || `chore: apply ${detail.task.title.replace(/^"|"$/g, "")}`;
          const result = commitTaskChanges(detail.task, message);
          sendJson(
            res,
            result.ok ? { ok: true, commitSha: result.commitSha } : { error: result.error ?? "Unable to commit changes" },
            result.ok ? 200 : 500,
          );
          return;
        }
        if (action === "push") {
          const result = pushTaskBranch(detail.task);
          sendJson(
            res,
            result.ok ? { ok: true, branch: result.branch } : { error: result.error ?? "Unable to push branch" },
            result.ok ? 200 : 500,
          );
          return;
        }
        if (action === "open-pr") {
          const body = await readJsonBody<{ title?: string; body?: string }>(req);
          const prTitle = body.title?.trim() || detail.task.title.replace(/^"|"$/g, "");
          const prBody =
            body.body?.trim() ||
            [
              `## Summary`,
              detail.task.originalTask,
              "",
              `## Validation`,
              detail.task.finalReport ?? "Validated in orchestrator run.",
            ].join("\n");
          const result = openTaskPr(detail.task, prTitle, prBody);
          sendJson(
            res,
            result.ok ? { ok: true, prUrl: result.prUrl, existing: result.existing ?? false } : { error: result.error ?? "Unable to open PR" },
            result.ok ? 200 : 500,
          );
          return;
        }
        sendJson(res, { error: "Unknown action" }, 400);
      })().catch((error: unknown) => {
        sendJson(res, { error: error instanceof Error ? error.message : "Request failed" }, 500);
      });
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
