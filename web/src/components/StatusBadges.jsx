// Small display bits shared between the dashboard and a project's run history.
import { severeCount } from "../lib/projects.js";

export function StatusDot({ run }) {
  if (!run) return <span className="dot dot-gray" title="No runs yet" />;
  if (run.status === "error") return <span className="dot dot-gray" title={`Run failed: ${run.error ?? ""}`} />;
  const severe = severeCount(run.counts);
  if (severe > 0) return <span className="dot dot-red" title={`${severe} critical/high finding(s)`} />;
  if ((run.counts?.medium ?? 0) > 0) return <span className="dot dot-yellow" title="Medium findings only" />;
  return <span className="dot dot-green" title="Clean" />;
}

export function TrendArrow({ direction }) {
  if (direction === "up")
    return (
      <span className="trend trend-up" title="Worse than last run">
        ▲
      </span>
    );
  if (direction === "down")
    return (
      <span className="trend trend-down" title="Better than last run">
        ▼
      </span>
    );
  return (
    <span className="trend trend-flat" title="No change">
      –
    </span>
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
