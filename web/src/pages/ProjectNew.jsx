import { useState } from "react";
import { Link } from "react-router-dom";
import { useCurrentAgency } from "../hooks/useCurrentAgency.js";
import { createProject } from "../lib/projects.js";
import { upsertProjectSecrets } from "../lib/secrets.js";
import { requestRun } from "../lib/runRequests.js";

function splitCommaList(text) {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function emptyTwoAccountRow() {
  return { name: "", ownerColumn: "", idColumn: "", sampleRow: "" };
}

export function ProjectNew() {
  const { agencyId, loading: loadingAgency } = useCurrentAgency();

  const [name, setName] = useState("");
  const [supabaseUrl, setSupabaseUrl] = useState("");
  const [anonKey, setAnonKey] = useState("");
  const [serviceRoleKey, setServiceRoleKey] = useState("");
  const [databaseUrl, setDatabaseUrl] = useState("");
  const [tablesText, setTablesText] = useState("");
  const [bucketsText, setBucketsText] = useState("");
  const [rpcText, setRpcText] = useState("");
  const [twoAccountRows, setTwoAccountRows] = useState([emptyTwoAccountRow()]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null); // the new project row, once saved
  const [runQueued, setRunQueued] = useState(false);
  const [queueing, setQueueing] = useState(false);

  function updateRow(index, field, value) {
    setTwoAccountRows((rows) => rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }

  function addRow() {
    setTwoAccountRows((rows) => [...rows, emptyTwoAccountRow()]);
  }

  function removeRow(index) {
    setTwoAccountRows((rows) => rows.filter((_, i) => i !== index));
  }

  function buildTwoAccount() {
    const out = [];
    for (const row of twoAccountRows) {
      if (!row.name.trim()) continue;
      let sampleRow = {};
      if (row.sampleRow.trim()) {
        try {
          sampleRow = JSON.parse(row.sampleRow);
        } catch {
          throw new Error(`Sample row for table "${row.name}" is not valid JSON.`);
        }
      }
      out.push({
        name: row.name.trim(),
        ownerColumn: row.ownerColumn.trim() || undefined,
        idColumn: row.idColumn.trim() || undefined,
        sampleRow,
      });
    }
    return out;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const two_account = buildTwoAccount();
      const project = await createProject(agencyId, {
        name: name.trim(),
        supabase_url: supabaseUrl.trim().replace(/\/+$/, ""),
        anon_key: anonKey.trim(),
        tables: splitCommaList(tablesText),
        buckets: splitCommaList(bucketsText),
        rpc: splitCommaList(rpcText),
        two_account,
      });

      if (serviceRoleKey.trim() || databaseUrl.trim()) {
        await upsertProjectSecrets(project.id, {
          serviceRoleKey: serviceRoleKey.trim() || null,
          databaseUrl: databaseUrl.trim() || null,
        });
      }

      setCreated(project);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRunNow() {
    setQueueing(true);
    setError(null);
    try {
      await requestRun(agencyId, created.id);
      setRunQueued(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setQueueing(false);
    }
  }

  if (loadingAgency) return <div className="page">Loading…</div>;
  if (!agencyId) {
    return (
      <div className="page">
        <p className="muted">
          You need an agency first. Go to the <Link to="/">dashboard</Link> and create one.
        </p>
      </div>
    );
  }

  if (created) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Project added</h1>
        </header>
        <div className="card">
          <h2>{created.name}</h2>
          <p className="muted">It won't be checked until the next scheduled sweep, or you run it now.</p>
          {error && <p className="notice notice-error">{error}</p>}
          {runQueued ? (
            <p className="notice notice-ok">Queued — the worker picks up run requests within a minute.</p>
          ) : (
            <button onClick={handleRunNow} disabled={queueing}>
              {queueing ? "Queueing…" : "Run now"}
            </button>
          )}
          <p style={{ marginTop: 16 }}>
            <Link to={`/projects/${created.id}`}>View project</Link> · <Link to="/">Back to dashboard</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Add project</h1>
      </header>

      <form onSubmit={handleSubmit} style={{ maxWidth: 640 }}>
        <label htmlFor="name">Name</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Client app" />

        <label htmlFor="supabaseUrl">Supabase URL</label>
        <input
          id="supabaseUrl"
          value={supabaseUrl}
          onChange={(e) => setSupabaseUrl(e.target.value)}
          required
          placeholder="https://xxxxxxxxxxxx.supabase.co"
        />

        <label htmlFor="anonKey">Anon / publishable key</label>
        <input id="anonKey" value={anonKey} onChange={(e) => setAnonKey(e.target.value)} required className="mono" />

        <label htmlFor="serviceRoleKey">Service role key (optional — enables the two-account test)</label>
        <input
          id="serviceRoleKey"
          type="password"
          value={serviceRoleKey}
          onChange={(e) => setServiceRoleKey(e.target.value)}
          className="mono"
          autoComplete="off"
        />

        <label htmlFor="databaseUrl">Database URL (optional — enables the policy audit)</label>
        <input
          id="databaseUrl"
          type="password"
          value={databaseUrl}
          onChange={(e) => setDatabaseUrl(e.target.value)}
          className="mono"
          placeholder="postgresql://postgres.xxxx:PASSWORD@...:5432/postgres"
          autoComplete="off"
        />
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Both are stored in Supabase Vault and never sent back to a browser.
        </p>

        <label htmlFor="tables">Tables to probe (comma-separated)</label>
        <input id="tables" value={tablesText} onChange={(e) => setTablesText(e.target.value)} placeholder="todos, profiles" />

        <label htmlFor="buckets">Storage buckets to probe (comma-separated)</label>
        <input id="buckets" value={bucketsText} onChange={(e) => setBucketsText(e.target.value)} placeholder="avatars" />

        <label htmlFor="rpc">RPC functions to probe (comma-separated)</label>
        <input id="rpc" value={rpcText} onChange={(e) => setRpcText(e.target.value)} placeholder="get_stats" />

        <label>Two-account test tables (optional, needs the service role key)</label>
        {twoAccountRows.map((row, i) => (
          <div key={i} className="card" style={{ marginBottom: 10, padding: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <div>
                <label htmlFor={`ta-name-${i}`}>Table</label>
                <input
                  id={`ta-name-${i}`}
                  value={row.name}
                  onChange={(e) => updateRow(i, "name", e.target.value)}
                  placeholder="todos"
                />
              </div>
              <div>
                <label htmlFor={`ta-owner-${i}`}>Owner column</label>
                <input
                  id={`ta-owner-${i}`}
                  value={row.ownerColumn}
                  onChange={(e) => updateRow(i, "ownerColumn", e.target.value)}
                  placeholder="user_id"
                />
              </div>
              <div>
                <label htmlFor={`ta-id-${i}`}>Id column</label>
                <input
                  id={`ta-id-${i}`}
                  value={row.idColumn}
                  onChange={(e) => updateRow(i, "idColumn", e.target.value)}
                  placeholder="id"
                />
              </div>
            </div>
            <label htmlFor={`ta-sample-${i}`}>Sample row (JSON)</label>
            <textarea
              id={`ta-sample-${i}`}
              className="mono"
              rows={2}
              value={row.sampleRow}
              onChange={(e) => updateRow(i, "sampleRow", e.target.value)}
              placeholder='{"title": "test"}'
            />
            {twoAccountRows.length > 1 && (
              <button type="button" className="btn-link" onClick={() => removeRow(i)} style={{ marginTop: 8 }}>
                Remove
              </button>
            )}
          </div>
        ))}
        <button type="button" className="btn-link" onClick={addRow}>
          + Add table
        </button>

        {error && <p className="notice notice-error">{error}</p>}

        <div>
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save project"}
          </button>
        </div>
      </form>
    </div>
  );
}
