export type TaskStatus = "queued" | "running" | "completed" | "failed";

export type TaskStage =
  | "received"
  | "spec"
  | "implementation"
  | "review"
  | "fixing"
  | "validation"
  | "reporting"
  | "done"
  | "failed";

export type HistoryEntry = {
  at: string;
  stage: TaskStage;
  note: string;
};

export type StreamEvent = {
  at: string;
  agent: string;
  purpose: string;
  kind: string;
  text: string;
};

export type DispatchRecord = {
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

export type ProgressEntry = {
  at: string;
  agent: string;
  line: string;
};

export type HandoffRecord = {
  at: string;
  fromAgent: string;
  toAgent: string;
  summary: string;
  message: string;
  reason?: string;
  artifacts?: Record<string, unknown>;
};

export type TaskSummary = {
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

export type TaskDetail = {
  task: {
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
