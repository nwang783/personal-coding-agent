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

export type ReviewFinding = {
  severity: string;
  title: string;
  description: string;
  file?: string;
  line?: number;
};

export type VerificationItem = {
  command: string;
  outcome: "passed" | "failed" | "not_run";
  details: string;
};

export type CiCheck = {
  name: string;
  status: "passed" | "failed" | "pending" | "not_run";
  details: string;
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
  activeAgentPurpose?: string;
  routedAgent?: "codex-impl" | "amp-impl";
  lastNote?: string;
  reviewLoops: number;
  validationLoops: number;
  maxReviewLoops: number;
  maxValidationLoops: number;
  handoffCount: number;
  failureKind?: string;
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
    specPath?: string;
    liveLogPath?: string;
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
    activeAgentName?: string;
    activeAgentPurpose?: string;
    lastPromptPath?: string;
    lastResultPath?: string;
    lastSubagentCommand?: string;
    lastStreamEvent?: string;
    streamEvents?: StreamEvent[];
  };
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
