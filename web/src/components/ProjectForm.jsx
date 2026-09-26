import { useState } from "react";

function splitCommaList(text) {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function emptyTwoAccountRow() {
  return { name: "", ownerColumn: "", idColumn: "", sampleRow: "" };
}

/** projects_public.two_account (array of {name, ownerColumn, idColumn, sampleRow}) -> form rows. */
function twoAccountToRows(twoAccount) {
  if (!twoAccount?.length) return [emptyTwoAccountRow()];
  return twoAccount.map((t) => ({
    name: t.name ?? "",
    ownerColumn: t.ownerColumn ?? "",
    idColumn: t.idColumn ?? "",
    sampleRow: t.sampleRow ? JSON.stringify(t.sampleRow) : "",
  }));
}

/**
 * The add/edit project form. In edit mode (`initial` set), the service role key and
 * database URL fields start blank — typing something replaces it, leaving it blank
 * keeps whatever's already stored in Vault.
 *
 * @param {Object} props
 * @param {Object} [props.initial]  a projects_public row to prefill from (edit mode)
 * @param {(payload: object) => Promise<void>} props.onSubmit
 * @param {string} props.submitLabel
 * @param {string} [props.pendingLabel]
 */
export function ProjectForm({ initial, onSubmit, submitLabel, pendingLabel }) {
  const isEdit = Boolean(initial);

  const [name, setName] = useState(initial?.name ?? "");
  const [supabaseUrl, setSupabaseUrl] = useState(initial?.supabase_url ?? "");
  const [anonKey, setAnonKey] = useState(initial?.anon_key ?? "");
  const [serviceRoleKey, setServiceRoleKey] = useState("");
  const [databaseUrl, setDatabaseUrl] = useState("");
  const [tablesText, setTablesText] = useState((initial?.tables ?? []).join(", "));
  const [bucketsText, setBucketsText] = useState((initial?.buckets ?? []).join(", "));
  const [rpcText, setRpcText] = useState((initial?.rpc ?? []).join(", "));
  const [twoAccountRows, setTwoAccountRows] = useState(twoAccountToRows(initial?.two_account));
  const [twoAccountEnabled, setTwoAccountEnabled] = useState(initial?.two_account_enabled ?? false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

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
      await onSubmit({
        name: name.trim(),
        supabase_url: supabaseUrl.trim().replace(/\/+$/, ""),
        anon_key: anonKey.trim(),
        tables: splitCommaList(tablesText),
        buckets: splitCommaList(bucketsText),
        rpc: splitCommaList(rpcText),
        two_account,
        two_account_enabled: twoAccountEnabled,
        serviceRoleKey: serviceRoleKey.trim(),
        databaseUrl: databaseUrl.trim(),
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
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

      <label htmlFor="serviceRoleKey">
        Service role key (optional — enables the two-account test)
        {isEdit && initial?.has_service_key && <span className="badge">currently set</span>}
      </label>
      <input
        id="serviceRoleKey"
        type="password"
        value={serviceRoleKey}
        onChange={(e) => setServiceRoleKey(e.target.value)}
        className="mono"
        autoComplete="off"
        placeholder={isEdit ? "leave blank to keep, enter to replace" : undefined}
      />

      <label htmlFor="databaseUrl">
        Database URL (optional — enables the policy audit)
        {isEdit && initial?.has_database_url && <span className="badge">currently set</span>}
      </label>
      <input
        id="databaseUrl"
        type="password"
        value={databaseUrl}
        onChange={(e) => setDatabaseUrl(e.target.value)}
        className="mono"
        placeholder={isEdit ? "leave blank to keep, enter to replace" : "postgresql://postgres.xxxx:PASSWORD@...:5432/postgres"}
        autoComplete="off"
      />
      <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        Both are stored in Supabase Vault and never sent back to a browser.
        {isEdit && " Leave either field blank to keep what's already stored."}
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

      <label htmlFor="twoAccountEnabled" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
        <input
          id="twoAccountEnabled"
          type="checkbox"
          checked={twoAccountEnabled}
          onChange={(e) => setTwoAccountEnabled(e.target.checked)}
          style={{ width: "auto" }}
        />
        Run the two-account test
      </label>
      <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        Off by default: this creates two temporary users and test rows in the client's
        database, then deletes them.
      </p>

      {error && <p className="notice notice-error">{error}</p>}

      <div>
        <button type="submit" disabled={saving}>
          {saving ? (pendingLabel ?? "Saving…") : submitLabel}
        </button>
      </div>
    </form>
  );
}
