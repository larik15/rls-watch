import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider.jsx";
import { useCurrentAgency } from "../hooks/useCurrentAgency.js";
import { getAgency, updateAgency } from "../lib/agencies.js";
import { getMyRole } from "../lib/members.js";
import { requestTelegramTest } from "../lib/runRequests.js";

export function Settings() {
  const { user } = useAuth();
  const { agencyId, loading: loadingAgency } = useCurrentAgency();

  const [agency, setAgency] = useState(null);
  const [role, setRole] = useState(null);
  const [name, setName] = useState("");
  const [chatId, setChatId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const [testing, setTesting] = useState(false);
  const [testQueued, setTestQueued] = useState(false);

  useEffect(() => {
    if (!agencyId) return;
    Promise.all([getAgency(agencyId), getMyRole(agencyId, user.id)])
      .then(([a, r]) => {
        setAgency(a);
        setName(a.name);
        setChatId(a.telegram_chat_id ?? "");
        setRole(r);
      })
      .catch((e) => setError(e.message));
  }, [agencyId, user.id]);

  const isOwner = role === "owner";

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const updated = await updateAgency(agencyId, { name: name.trim(), telegram_chat_id: chatId.trim() || null });
      setAgency(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSendTest() {
    setTesting(true);
    setError(null);
    setTestQueued(false);
    try {
      await requestTelegramTest(agencyId);
      setTestQueued(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setTesting(false);
    }
  }

  if (loadingAgency || (agencyId && !agency)) return <div className="page">Loading…</div>;
  if (!agencyId) {
    return (
      <div className="page">
        <p className="muted">
          You need an agency first. Go to the <Link to="/">dashboard</Link> and create one.
        </p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Settings</h1>
        <Link to="/">Back to dashboard</Link>
      </header>

      {error && <p className="notice notice-error">{error}</p>}
      {!isOwner && (
        <p className="notice" style={{ background: "rgba(255,255,255,0.05)", color: "var(--text-muted)" }}>
          Only the agency owner can change these settings. You can still send a test Telegram message below.
        </p>
      )}

      <form onSubmit={handleSave} style={{ maxWidth: 480 }}>
        <label htmlFor="agencyName">Agency name</label>
        <input id="agencyName" value={name} onChange={(e) => setName(e.target.value)} disabled={!isOwner} required />

        <label htmlFor="chatId">Telegram chat id</label>
        <input
          id="chatId"
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          disabled={!isOwner}
          className="mono"
          placeholder="e.g. -1001234567890"
        />
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Message your bot, then look up the chat id (e.g. via the bot's <code>getUpdates</code> call) — alerts and
          this test message are sent here.
        </p>

        {isOwner && (
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : saved ? "Saved" : "Save"}
          </button>
        )}
      </form>

      <div className="card" style={{ marginTop: 24, maxWidth: 480 }}>
        <h2 style={{ fontSize: 15, marginTop: 0 }}>Test Telegram alerts</h2>
        <p className="muted">Queues a message to the chat id above. The worker sends it within a minute.</p>
        {testQueued ? (
          <p className="notice notice-ok">Queued — check your Telegram chat shortly.</p>
        ) : (
          <button onClick={handleSendTest} disabled={testing || !agency?.telegram_chat_id}>
            {testing ? "Queueing…" : "Send test message"}
          </button>
        )}
        {!agency?.telegram_chat_id && <p className="muted" style={{ fontSize: 12 }}>Set a chat id above first.</p>}
      </div>
    </div>
  );
}
