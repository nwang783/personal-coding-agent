import type { TaskDetail, TaskStage, HistoryEntry, HandoffRecord } from "./types";

// ── Helpers ────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString();
}

// ── Stage flow diagram constants ───────────────────────────────

const NODE_W = 150;
const NODE_H = 64;
const GAP_X = 56;
const GAP_Y = 100;
const PADDING = 36;

type StageNode = {
  id: string;
  label: string;
  defaultAgent: string;
  x: number;
  y: number;
};

type StageArrow = {
  from: string;
  to: string;
  label?: string;
  loopBack?: boolean;
  color?: string;
};

function col(c: number) {
  return PADDING + c * (NODE_W + GAP_X);
}
function row(r: number) {
  return PADDING + r * (NODE_H + GAP_Y);
}

const STAGE_NODES: StageNode[] = [
  { id: "received",       label: "Received",       defaultAgent: "orchestrator", x: col(0), y: row(0) },
  { id: "spec",           label: "Spec",           defaultAgent: "spec-writer",  x: col(1), y: row(0) },
  { id: "implementation", label: "Implementation", defaultAgent: "impl-agent",   x: col(2), y: row(0) },
  { id: "review",         label: "Review",         defaultAgent: "reviewer",     x: col(3), y: row(0) },
  { id: "fixing",         label: "Fixing",         defaultAgent: "impl-agent",   x: col(2.5), y: row(1) },
  { id: "validation",     label: "Validation",     defaultAgent: "validator",    x: col(4), y: row(0) },
  { id: "reporting",      label: "Reporting",      defaultAgent: "reporter",     x: col(5), y: row(0) },
  { id: "done",           label: "Done",           defaultAgent: "orchestrator", x: col(6), y: row(0) },
];

const STAGE_ARROWS: StageArrow[] = [
  { from: "received", to: "spec" },
  { from: "spec", to: "implementation" },
  { from: "implementation", to: "review" },
  { from: "review", to: "fixing",    label: "rejected", loopBack: true, color: "#c53030" },
  { from: "fixing", to: "implementation", label: "retry", loopBack: true, color: "#c53030" },
  { from: "review", to: "validation", label: "approved", color: "#1a6b3c" },
  { from: "validation", to: "fixing", label: "failed",  loopBack: true, color: "#c53030" },
  { from: "validation", to: "reporting", label: "passed", color: "#1a6b3c" },
  { from: "reporting", to: "done" },
];

const STAGE_ORDER: Record<string, number> = {
  received: 0, spec: 1, implementation: 2, review: 3, fixing: 3,
  validation: 4, reporting: 5, done: 6, failed: 6,
};

function getNodeStatus(
  nodeId: string,
  currentStage: string,
  taskStatus: string,
  history: HistoryEntry[],
): "completed" | "active" | "pending" | "failed" {
  if (taskStatus === "failed" && currentStage === nodeId) return "failed";
  if (nodeId === "fixing") {
    if (currentStage === "fixing") return "active";
    if (history.some((h) => h.stage === "fixing")) return "completed";
    return "pending";
  }
  const cur = STAGE_ORDER[currentStage] ?? -1;
  const tgt = STAGE_ORDER[nodeId] ?? 99;
  if (tgt < cur) return "completed";
  if (tgt === cur) return taskStatus === "completed" ? "completed" : "active";
  return "pending";
}

function buildArrowPath(fromNode: StageNode, toNode: StageNode): { d: string; lx: number; ly: number } {
  if (fromNode.y === toNode.y) {
    const sx = fromNode.x + NODE_W;
    const sy = fromNode.y + NODE_H / 2;
    const ex = toNode.x;
    const ey = toNode.y + NODE_H / 2;
    return { d: `M ${sx} ${sy} L ${ex} ${ey}`, lx: (sx + ex) / 2, ly: sy - 10 };
  }
  if (toNode.y > fromNode.y) {
    const sx = fromNode.x + NODE_W / 2;
    const sy = fromNode.y + NODE_H;
    const ex = toNode.x + NODE_W / 2;
    const ey = toNode.y;
    const my = (sy + ey) / 2;
    return { d: `M ${sx} ${sy} C ${sx} ${my}, ${ex} ${my}, ${ex} ${ey}`, lx: (sx + ex) / 2 + 12, ly: my };
  }
  // up arrow
  const sx = fromNode.x + NODE_W / 2;
  const sy = fromNode.y;
  const ex = toNode.x + NODE_W / 2;
  const ey = toNode.y + NODE_H;
  const ox = -20;
  const my = (sy + ey) / 2;
  return { d: `M ${sx} ${sy} C ${sx + ox} ${my}, ${ex + ox} ${my}, ${ex} ${ey}`, lx: (sx + ex) / 2 + ox - 16, ly: my };
}

// ── Component ──────────────────────────────────────────────────

type Props = { detail: TaskDetail };

export default function PipelineView({ detail }: Props) {
  const task = detail.task;
  const handoffs = task.handoffHistory ?? [];
  const history = task.history ?? [];

  // Compute durations per stage from history
  const durations: Record<string, number> = {};
  for (let i = 0; i < history.length - 1; i++) {
    const s = history[i].stage;
    const dt = new Date(history[i + 1].at).getTime() - new Date(history[i].at).getTime();
    durations[s] = (durations[s] ?? 0) + dt;
  }

  const svgW = PADDING * 2 + 7 * NODE_W + 6 * GAP_X;
  const svgH = PADDING * 2 + 2 * NODE_H + GAP_Y;

  const nodeById = Object.fromEntries(STAGE_NODES.map((n) => [n.id, n]));

  function agentForNode(nodeId: string): string {
    if (nodeId === "implementation" || nodeId === "fixing") return task.currentAgent ?? task.routedAgent ?? "impl-agent";
    return nodeById[nodeId]?.defaultAgent ?? "";
  }

  return (
    <div className="pipeline-view">
      {/* Live agent banner */}
      {(task.currentAgent || task.activeAgentName) && task.status === "running" && (
        <div className="pipeline-live-banner">
          <span className="pipeline-live-dot" />
          <strong>{task.currentAgent ?? task.activeAgentName}</strong>
          {task.activeAgentPurpose && (
            <span className="pipeline-live-purpose">{task.activeAgentPurpose}</span>
          )}
          {task.lastStreamEvent && (
            <span className="pipeline-live-event">{task.lastStreamEvent}</span>
          )}
        </div>
      )}

      {/* SVG flow diagram */}
      <div className="pipeline-diagram-wrap">
        <svg viewBox={`0 0 ${svgW} ${svgH}`} className="pipeline-diagram" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="ah" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#999" />
            </marker>
            <marker id="ah-g" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#1a6b3c" />
            </marker>
            <marker id="ah-r" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#c53030" />
            </marker>
          </defs>

          {/* Arrows */}
          {STAGE_ARROWS.map((arrow, i) => {
            const fn = nodeById[arrow.from];
            const tn = nodeById[arrow.to];
            if (!fn || !tn) return null;
            const { d, lx, ly } = buildArrowPath(fn, tn);
            const color = arrow.color ?? "#bbb";
            const mid = arrow.color === "#1a6b3c" ? "ah-g" : arrow.color === "#c53030" ? "ah-r" : "ah";
            return (
              <g key={i}>
                <path d={d} fill="none" stroke={color} strokeWidth={arrow.loopBack ? 1.5 : 2}
                  strokeDasharray={arrow.loopBack ? "6 4" : undefined} markerEnd={`url(#${mid})`} />
                {arrow.label && (
                  <text x={lx} y={ly} textAnchor="middle" className="pipeline-arrow-label" fill={color}>
                    {arrow.label}
                  </text>
                )}
              </g>
            );
          })}

          {/* Nodes */}
          {STAGE_NODES.map((node) => {
            const status = getNodeStatus(node.id, task.stage, task.status, history);
            const dur = durations[node.id];
            let fill = "#f5f5f5", stroke = "#ddd", txt = "#999";
            if (status === "completed") { fill = "#e8f5ee"; stroke = "#1a6b3c"; txt = "#1a6b3c"; }
            else if (status === "active") { fill = "#1a6b3c"; stroke = "#145530"; txt = "#fff"; }
            else if (status === "failed") { fill = "#fef2f2"; stroke = "#c53030"; txt = "#c53030"; }

            return (
              <g key={node.id}>
                <rect x={node.x} y={node.y} width={NODE_W} height={NODE_H} rx={10} ry={10}
                  fill={fill} stroke={stroke} strokeWidth={status === "active" ? 2.5 : 1.5} />
                {status === "active" && (
                  <rect x={node.x} y={node.y} width={NODE_W} height={NODE_H} rx={10} ry={10}
                    fill="none" stroke="#1a6b3c" strokeWidth={2.5} opacity={0.4} className="pipeline-node-pulse" />
                )}
                <text x={node.x + NODE_W / 2} y={node.y + 22} textAnchor="middle" className="pipeline-node-label" fill={txt}>
                  {node.label}
                </text>
                <text x={node.x + NODE_W / 2} y={node.y + 38} textAnchor="middle" className="pipeline-node-agent"
                  fill={status === "active" ? "rgba(255,255,255,0.7)" : "#999"}>
                  {agentForNode(node.id)}
                </text>
                {dur !== undefined && (
                  <text x={node.x + NODE_W / 2} y={node.y + 54} textAnchor="middle" className="pipeline-node-duration"
                    fill={status === "active" ? "rgba(255,255,255,0.6)" : "#bbb"}>
                    {formatDuration(dur)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Stats row */}
      <div className="pipeline-stats-row">
        <div className="pipeline-stat">
          <span className="pipeline-stat-label">Handoffs</span>
          <span className="pipeline-stat-value">{task.handoffCount ?? handoffs.length}</span>
        </div>
        <div className="pipeline-stat">
          <span className="pipeline-stat-label">Review loops</span>
          <span className="pipeline-stat-value">{task.reviewLoops} / {task.maxReviewLoops}</span>
          <div className="pipeline-stat-bar">
            <div className="pipeline-stat-fill"
              style={{ width: `${task.maxReviewLoops ? (task.reviewLoops / task.maxReviewLoops) * 100 : 0}%` }} />
          </div>
        </div>
        <div className="pipeline-stat">
          <span className="pipeline-stat-label">Validation loops</span>
          <span className="pipeline-stat-value">{task.validationLoops} / {task.maxValidationLoops}</span>
          <div className="pipeline-stat-bar">
            <div className="pipeline-stat-fill"
              style={{ width: `${task.maxValidationLoops ? (task.validationLoops / task.maxValidationLoops) * 100 : 0}%` }} />
          </div>
        </div>
        <div className="pipeline-stat">
          <span className="pipeline-stat-label">Status</span>
          <span className={`pill ${task.status === "completed" ? "ok" : task.status === "failed" ? "bad" : "live"}`}>
            {task.status}
          </span>
        </div>
        <div className="pipeline-stat">
          <span className="pipeline-stat-label">Current agent</span>
          <span className="pipeline-stat-value">{task.currentAgent ?? task.activeAgentName ?? "idle"}</span>
        </div>
        {task.lastPrUrl && (
          <div className="pipeline-stat">
            <span className="pipeline-stat-label">Pull Request</span>
            <a href={task.lastPrUrl} target="_blank" rel="noreferrer" className="pipeline-stat-link">View PR →</a>
          </div>
        )}
      </div>

      {/* Failure banner */}
      {task.failureKind && (
        <div className="pipeline-failure-banner">
          <strong>Failed: {task.failureKind}</strong>
          {task.failureDetails && <p>{task.failureDetails}</p>}
        </div>
      )}

      {/* Handoff chain — the primary new visualization */}
      {handoffs.length > 0 && (
        <div className="pipeline-handoff-section">
          <h3 className="pipeline-section-title">Handoff chain</h3>
          <div className="pipeline-handoff-chain">
            {handoffs.map((h, i) => (
              <div key={`${h.at}-${i}`} className="pipeline-handoff-item">
                <div className="pipeline-handoff-header">
                  <span className="pipeline-handoff-agents">
                    <span className="pipeline-handoff-agent-badge">{h.fromAgent}</span>
                    <span className="pipeline-handoff-arrow">→</span>
                    <span className="pipeline-handoff-agent-badge">{h.toAgent}</span>
                  </span>
                  <time>{formatTime(h.at)}</time>
                </div>
                <p className="pipeline-handoff-summary">{h.summary}</p>
                {h.reason && <p className="pipeline-handoff-reason">Reason: {h.reason}</p>}
                {h.message && (
                  <details className="pipeline-handoff-message">
                    <summary>Forwarded message</summary>
                    <pre>{h.message}</pre>
                  </details>
                )}
                {h.artifacts && Object.keys(h.artifacts).length > 0 && (
                  <details className="pipeline-handoff-message">
                    <summary>Artifacts</summary>
                    <pre>{JSON.stringify(h.artifacts, null, 2)}</pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stage history cards */}
      {history.length > 0 && (
        <div className="pipeline-handoff-section">
          <h3 className="pipeline-section-title">Stage history</h3>
          <div className="pipeline-stage-cards">
            {[...new Set(history.map((h) => h.stage))].map((stageId) => {
              const entries = history.filter((h) => h.stage === stageId);
              const status = getNodeStatus(stageId, task.stage, task.status, history);
              return (
                <div key={stageId} className={`pipeline-stage-card ${status}`}>
                  <div className="pipeline-stage-card-header">
                    <strong>{stageId}</strong>
                    <span>{entries.length} events</span>
                  </div>
                  <div className="pipeline-stage-card-events">
                    {entries.map((h, i) => (
                      <div key={`${h.at}-${i}`} className="pipeline-stage-event">
                        <span className="pipeline-stage-event-note">{h.note}</span>
                        <time>{formatTime(h.at)}</time>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
