// Small display bits shared between the dashboard and a project's run history.
import { severeCount } from "../lib/projects.js";
import { targetsEvaluated } from "../../../shared/checks.mjs";

/** { tone, label, title } for a run. A run that looked at nothing is never "clean". */
export function runState(run) {
  if (!run) return { tone: "gray", label: "no runs", title: "No runs yet" };
  if (run.status === "queued" || run.status === "running") return { tone: "blue", label: "running", title: "Run in progress" };
  if (run.status === "error") return { tone: "gray", label: "error", title: `Run failed: ${run.error ?? ""}` };
  if (run.status === "timeout") return { tone: "gray", label: "timed out", title: run.error ?? "Run timed out" };
  if (targetsEvaluated(run.checks) === 0) {
    return { tone: "yellow", label: "nothing checked", title: "No target could be evaluated in this run" };
  }
  const severe = severeCount(run.counts) ?? 0;
  if (severe > 0) return { tone: "red", label: null, title: `${severe} critical/high finding(s)` };
  if ((run.counts?.medium ?? 0) > 0) return { tone: "yellow", label: null, title: "Medium findings only" };
  return { tone: "green", label: null, title: "No findings from the checks that ran" };
}

export function StatusDot({ run, withLabel = false }) {
  const s = runState(run);
  return (
    <span title={s.title} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className={`dot dot-${s.tone}`} />
      {withLabel && s.label && <span className="muted" style={{ fontSize: 12 }}>{s.label}</span>}
    </span>
  );
}

export function TrendArrow({ direction }) {
  if (direction === "up")
    return (
      <span className="trend trend-up" title="Worse than the previous successful run">
        ▲
      </span>
    );
  if (direction === "down")
    return (
      <span className="trend trend-down" title="Better than the previous successful run">
        ▼
      </span>
    );
  return (
    <span className="trend trend-flat" title="No change">
      –
    </span>
  );
}

/** Banner for the most recent alert when it wasn't delivered (channel 'none' or a failed send). */
export function UndeliveredAlertBanner({ alert, projectName }) {
  if (!alert || alert.status === "sent") return null;
  const what = alert.channel === "none" ? "Alerts not configured" : "Alert failed to send";
  return (
    <p className="notice notice-warn">
      <strong>{what}</strong>
      {projectName ? ` for ${projectName}` : ""}: new critical/high findings on {new Date(alert.sent_at).toLocaleString()} were
      not delivered ({alert.error ?? "unknown reason"}). Check the findings below and fix the alert setup in Settings.
    </p>
  );
}

export function relativeTime(iso) {
  if (!iso) return "never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
