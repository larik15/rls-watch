import { Routes, Route, Navigate } from "react-router-dom";
import { RequireAuth } from "./auth/RequireAuth.jsx";
import { Login } from "./pages/Login.jsx";
import { Dashboard } from "./pages/Dashboard.jsx";
import { ProjectNew } from "./pages/ProjectNew.jsx";
import { ProjectEdit } from "./pages/ProjectEdit.jsx";
import { ProjectDetail } from "./pages/ProjectDetail.jsx";
import { Settings } from "./pages/Settings.jsx";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Dashboard />
          </RequireAuth>
        }
      />
      <Route
        path="/projects/new"
        element={
          <RequireAuth>
            <ProjectNew />
          </RequireAuth>
        }
      />
      <Route
        path="/projects/:id"
        element={
          <RequireAuth>
            <ProjectDetail />
          </RequireAuth>
        }
      />
      <Route
        path="/projects/:id/edit"
        element={
          <RequireAuth>
            <ProjectEdit />
          </RequireAuth>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <Settings />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
