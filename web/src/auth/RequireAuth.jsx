import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider.jsx";

/** Wrap a route element with this to redirect signed-out visitors to /login. */
export function RequireAuth({ children }) {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div className="page-loading">Loading…</div>;
  if (!session) return <Navigate to="/login" state={{ from: location }} replace />;

  return children;
}
