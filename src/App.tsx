import { useEffect, useState } from "react";
import type { TaskDetail, TaskSummary } from "./types";
import PipelineView from "./PipelineView";

type ViewTab = "pipeline" | "detail";

const REFRESH_MS = 2500;

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

function statusTone(status: TaskSummary["status"]): string {
  if (status === "completed") return "ok";
  if (status === "failed") return "bad";
  return "live";
}

function App() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<TaskDetail>();
  const [tasksError, setTasksError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [activeTab, setActiveTab] = useState<ViewTab>("pipeline");
  const [stopPending, setStopPending] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadTasks = async () => {
      try {
        const payload = await getJson<{ tasks: TaskSummary[] }>("/api/tasks");
        if (cancelled) return;
        setTasks(payload.tasks);
        setTasksError(undefined);
        setSelectedId((current) => current ?? payload.tasks[0]?.id);
      } catch (error) {
        if (cancelled) return;
        setTasksError(error instanceof Error ? error.message : "Unable to load tasks");
      }
    };

    void loadTasks();
    const timer = window.setInterval(loadTasks, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(undefined);
      return;
    }

    let cancelled = false;

    const loadDetail = async () => {
      try {
        const payload = await getJson<TaskDetail>(`/api/tasks/${selectedId}`);
        if (cancelled) return;
        setDetail(payload);
        setDetailError(undefined);
      } catch (error) {
        if (cancelled) return;
        setDetailError(error instanceof Error ? error.message : "Unable to load task detail");
      }
    };

    void loadDetail();
    const timer = window.setInterval(loadDetail, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedId]);

  const selectedTask = detail?.task;

  async function requestStop(taskId: string): Promise<void> {
    setStopPending(true);
    try {
      const response = await fetch(`/api/tasks/${taskId}/stop`, { method: "POST" });
      if (!response.ok) {
        throw new Error(`Stop request failed: ${response.status}`);
      }
      setDetail((current) =>
        current && current.task.id === taskId
          ? { ...current, task: { ...current.task, stopRequested: true } }
          : current,
      );
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "Unable to stop task");
    } finally {
      setStopPending(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>Pi Orchestrator</h1>
          <p className="sidebar-copy">Subagent task dashboard</p>
        </div>

        <div className="task-count">
          <span>{tasks.length} tasks</span>
          <span>refresh {REFRESH_MS / 1000}s</span>
        </div>

        {tasksError ? <div className="empty-state">{tasksError}</div> : null}

        <div className="task-list">
          {tasks.map((task) => (
            <button
              key={task.id}
              className={`task-card ${selectedId === task.id ? "selected" : ""}`}
              onClick={() => setSelectedId(task.id)}
              type="button"
            >
              <div className="task-card-header">
                <span className={`pill ${statusTone(task.status)}`}>{task.status}</span>
                <span className="task-stage">{task.stage}</span>
              </div>
              <strong>{task.title.replace(/^"|"$/g, "")}</strong>
              <p>{task.lastNote ?? "No recent note"}</p>
              <div className="task-meta">
                <span>{task.currentAgent ?? "idle"}</span>
                <span>
                  H {task.handoffCount} · R {task.reviewLoops}/{task.maxReviewLoops} · V {task.validationLoops}/{task.maxValidationLoops}
                </span>
              </div>
              <div className="task-meta">
                <span>{task.stopRequested ? "stop requested" : task.failureKind ?? task.lastProgressLine ?? ""}</span>
                <span>{formatTime(task.updatedAt)}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="main-panel">
        {!selectedTask ? (
          <section className="empty-state large">
            <h2>No orchestrator tasks yet</h2>
            <p>Run `/orchestrate ...` in Pi, then reload this page.</p>
          </section>
        ) : (
          <>
            {/* Top bar */}
            <div className="top-bar">
              <div className="tab-bar">
                <button
                  className={`tab-btn ${activeTab === "pipeline" ? "active" : ""}`}
                  onClick={() => setActiveTab("pipeline")}
                  type="button"
                >
                  Pipeline
                </button>
                <button
                  className={`tab-btn ${activeTab === "detail" ? "active" : ""}`}
                  onClick={() => setActiveTab("detail")}
                  type="button"
                >
                  Detail
                </button>
              </div>
              {selectedTask.status === "running" ? (
                <button
                  className="tab-btn stop-btn"
                  disabled={stopPending || selectedTask.stopRequested}
                  onClick={() => requestStop(selectedTask.id)}
                  type="button"
                >
                  {selectedTask.stopRequested ? "Stop requested" : stopPending ? "Stopping..." : "Stop run"}
                </button>
              ) : null}
            </div>

            {activeTab === "pipeline" && detail ? (
              <PipelineView detail={detail} />
            ) : (
            <>
            <header className="hero">
              <div style={{ minWidth: 0, flex: 1 }}>
                <p className="eyebrow">Selected task</p>
                <h2>{selectedTask.title.replace(/^"|"$/g, "")}</h2>
                <p className="hero-copy">{selectedTask.originalTask}</p>
              </div>
              <div className="hero-metrics">
                <div className="metric">
                  <span>Status</span>
                  <strong>{selectedTask.status}</strong>
                </div>
                <div className="metric">
                  <span>Stage</span>
                  <strong>{selectedTask.stage}</strong>
                </div>
                <div className="metric">
                  <span>Active agent</span>
                  <strong>{selectedTask.currentAgent ?? "idle"}</strong>
                </div>
                <div className="metric">
                  <span>Updated</span>
                  <strong>{formatTime(selectedTask.updatedAt)}</strong>
                </div>
              </div>
            </header>

            {detailError ? <section className="empty-state">{detailError}</section> : null}
            {selectedTask.stopRequested ? (
              <section className="empty-state">Stop requested. The active subagent will be terminated shortly.</section>
            ) : null}

            <section className="grid two-up">
              <article className="panel">
                <div className="panel-header">
                  <h3>Execution</h3>
                  <span>{selectedTask.currentAgent ?? "pending"}</span>
                </div>
                <dl className="detail-list">
                  <div>
                    <dt>Repo</dt>
                    <dd>{selectedTask.repoPath}</dd>
                  </div>
                  <div>
                    <dt>Worktree</dt>
                    <dd>{selectedTask.worktreePath ?? "n/a"}</dd>
                  </div>
                  <div>
                    <dt>Branch</dt>
                    <dd>{selectedTask.lastBranchName ?? selectedTask.worktreeBranch ?? "n/a"}</dd>
                  </div>
                  <div>
                    <dt>Handoffs</dt>
                    <dd>{selectedTask.handoffCount}</dd>
                  </div>
                  <div>
                    <dt>PR</dt>
                    <dd>
                      {selectedTask.lastPrUrl ? (
                        <a href={selectedTask.lastPrUrl} rel="noreferrer" target="_blank">
                          {selectedTask.lastPrUrl}
                        </a>
                      ) : (
                        "n/a"
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Prompt</dt>
                    <dd>{selectedTask.lastPromptPath ?? "n/a"}</dd>
                  </div>
                  <div>
                    <dt>Progress</dt>
                    <dd>{selectedTask.progressPath ?? "n/a"}</dd>
                  </div>
                  <div>
                    <dt>Result</dt>
                    <dd>{selectedTask.lastResultPath ?? "n/a"}</dd>
                  </div>
                  <div>
                    <dt>Failure</dt>
                    <dd>{selectedTask.failureKind ? `${selectedTask.failureKind}: ${selectedTask.failureDetails ?? ""}` : "n/a"}</dd>
                  </div>
                </dl>
              </article>

              <article className="panel">
                <div className="panel-header">
                  <h3>Latest handoff</h3>
                  <span>{selectedTask.lastHandoff ? `${selectedTask.lastHandoff.fromAgent} -> ${selectedTask.lastHandoff.toAgent}` : "none"}</span>
                </div>
                <div className="stack">
                  <div className="mini-block">
                    <h4>Summary</h4>
                    {selectedTask.lastHandoff ? (
                      <p>{selectedTask.lastHandoff.summary}</p>
                    ) : (
                      <p>No handoff yet</p>
                    )}
                  </div>
                  <div className="mini-block">
                    <h4>Forwarded message</h4>
                    {selectedTask.lastHandoff?.message ? (
                      <pre>{selectedTask.lastHandoff.message}</pre>
                    ) : (
                      <p>No forwarded message yet.</p>
                    )}
                  </div>
                </div>
              </article>
            </section>

            <section className="grid two-up">
              <article className="panel">
                <div className="panel-header">
                  <h3>Handoff history</h3>
                  <span>{selectedTask.handoffHistory?.length ?? 0} handoffs</span>
                </div>
                <div className="timeline">
                  {(selectedTask.handoffHistory ?? []).slice().reverse().map((entry) => (
                    <div key={`${entry.at}-${entry.summary}`} className="timeline-entry">
                      <span>
                        {entry.fromAgent} → {entry.toAgent}
                      </span>
                      <strong>{entry.summary}</strong>
                      <time>{formatTime(entry.at)}</time>
                    </div>
                  ))}
                  {selectedTask.handoffHistory?.length ? null : <p className="muted">No handoffs yet.</p>}
                </div>
              </article>

              <article className="panel">
                <div className="panel-header">
                  <h3>Trace files</h3>
                  <span>{detail?.traceFiles.length ?? 0} files</span>
                </div>
                <div className="trace-list">
                  {(detail?.traceFiles ?? []).map((file) => (
                    <div key={file.path} className="trace-item">
                      <span className={`pill trace ${file.kind}`}>{file.kind}</span>
                      <strong>{file.name}</strong>
                      <p>{file.path}</p>
                    </div>
                  ))}
                </div>
              </article>
            </section>

            {(selectedTask.streamEvents ?? []).length > 0 && (
              <section className="panel" style={{ marginBottom: 16 }}>
                <div className="panel-header">
                  <h3>Agent stream</h3>
                  <span>{selectedTask.streamEvents!.length} events</span>
                </div>
                <div className="timeline">
                  {selectedTask.streamEvents!.slice().reverse().map((entry, i) => (
                    <div key={`${entry.at}-${entry.agent}-${i}`} className="timeline-entry">
                      <span>
                        {entry.agent} · {entry.kind}
                      </span>
                      <strong>{entry.text}</strong>
                      <time>{formatTime(entry.at)}</time>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="grid two-up">
              <article className="panel">
                <div className="panel-header">
                  <h3>Progress</h3>
                  <span>shared run memory</span>
                </div>
                {detail?.summaries.progressPreview ? <pre>{detail.summaries.progressPreview}</pre> : <p className="muted">No progress yet.</p>}
                {(selectedTask.progressEntries ?? []).length > 0 && (
                  <div className="timeline" style={{ marginTop: 12 }}>
                    {(selectedTask.progressEntries ?? []).map((entry, i) => (
                      <div key={`${entry.at}-${i}`} className="timeline-entry">
                        <span>{entry.agent}</span>
                        <strong>{entry.line}</strong>
                        <time>{formatTime(entry.at)}</time>
                      </div>
                    ))}
                  </div>
                )}
              </article>
              <article className="panel">
                <div className="panel-header">
                  <h3>Delegated Run</h3>
                  <span>{selectedTask.lastDispatchPromptPath ? "latest" : "none"}</span>
                </div>
                <div className="stack">
                  <div className="mini-block">
                    <h4>Dispatch Prompt</h4>
                    <p>{selectedTask.lastDispatchPromptPath ?? "n/a"}</p>
                  </div>
                  <div className="mini-block">
                    <h4>Dispatch Result</h4>
                    <p>{selectedTask.lastDispatchResultPath ?? "n/a"}</p>
                  </div>
                  {selectedTask.lastDispatchProvider && (
                    <div className="mini-block">
                      <h4>Provider</h4>
                      <p>{selectedTask.lastDispatchProvider}</p>
                    </div>
                  )}
                </div>
                {detail?.summaries.dispatchPromptPreview && (
                  <details style={{ marginTop: 12 }}>
                    <summary>Latest delegated prompt</summary>
                    <pre>{detail.summaries.dispatchPromptPreview}</pre>
                  </details>
                )}
                {detail?.summaries.dispatchResultPreview && (
                  <details style={{ marginTop: 12 }}>
                    <summary>Latest delegated result</summary>
                    <pre>{detail.summaries.dispatchResultPreview}</pre>
                  </details>
                )}
              </article>
            </section>

            {(selectedTask.dispatchHistory ?? []).length > 0 && (
              <section className="panel" style={{ marginBottom: 16 }}>
                <div className="panel-header">
                  <h3>Dispatch history</h3>
                  <span>{selectedTask.dispatchHistory.length} dispatches</span>
                </div>
                <div className="timeline">
                  {selectedTask.dispatchHistory.slice().reverse().map((d, i) => (
                    <div key={`${d.at}-${i}`} className="timeline-entry">
                      <span>
                        {d.agent} → {d.provider} · {d.taskKind}
                        {d.timedOut ? " · TIMEOUT" : ""}
                        {d.timing !== undefined ? ` · ${Math.round(d.timing / 1000)}s` : ""}
                      </span>
                      <strong>{d.resultSummary ?? d.promptPreview ?? "dispatched"}</strong>
                      <time>{formatTime(d.at)}</time>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="grid two-up">
              <article className="panel">
                <div className="panel-header">
                  <h3>Latest prompt</h3>
                  <span>{selectedTask.lastPromptPath ?? "n/a"}</span>
                </div>
                <pre>{detail?.summaries.promptPreview ?? "No prompt preview available."}</pre>
              </article>

              <article className="panel">
                <div className="panel-header">
                  <h3>Latest result</h3>
                  <span>{selectedTask.lastResultPath ?? "n/a"}</span>
                </div>
                <pre>{detail?.summaries.resultPreview ?? "No result preview available."}</pre>
              </article>
            </section>

            {(selectedTask.finalReport || detail?.summaries.reportPreview) && (
              <section className="panel" style={{ marginBottom: 16 }}>
                <div className="panel-header">
                  <h3>Final report</h3>
                </div>
                <pre>{selectedTask.finalReport ?? detail?.summaries.reportPreview}</pre>
              </section>
            )}

            {selectedTask.workflowBugReport && (
              <section className="empty-state" style={{ background: "rgba(197,48,48,0.06)", borderColor: "rgba(197,48,48,0.2)", color: "var(--bad)" }}>
                <strong>Workflow bug reported</strong>
                <p>{selectedTask.workflowBugReport}</p>
              </section>
            )}
            </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

export default App;
