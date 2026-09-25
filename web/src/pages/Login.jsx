import { useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { supabase } from "../supabaseClient.js";
import { useAuth } from "../auth/AuthProvider.jsx";

export function Login() {
  const { session, loading } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [error, setError] = useState(null);

  if (!loading && session) {
    const from = location.state?.from?.pathname ?? "/";
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus("sending");
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (signInError) {
      setStatus("error");
      setError(signInError.message);
      return;
    }
    setStatus("sent");
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>RLS Watch</h1>
        <p className="muted">Sign in with a magic link. No password to leak.</p>

        {status === "sent" ? (
          <p className="notice notice-ok">
            Check <strong>{email}</strong> for a sign-in link.
          </p>
        ) : (
          <form onSubmit={handleSubmit}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@agency.com"
            />
            <button type="submit" disabled={status === "sending"}>
              {status === "sending" ? "Sending…" : "Send magic link"}
            </button>
            {status === "error" && <p className="notice notice-error">{error}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
