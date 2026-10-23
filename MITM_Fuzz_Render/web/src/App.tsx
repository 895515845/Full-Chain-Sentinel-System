import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import AppShell from "./components/AppShell";
import EmptyState from "./components/EmptyState";
import HistoryPage from "./pages/HistoryPage";
import RepeaterPage from "./pages/RepeaterPage";
import ScriptsPage from "./pages/ScriptsPage";
import SettingsPage from "./pages/SettingsPage";

function NotFoundPage() {
  const { pathname } = useLocation();

  return (
    <section
      data-testid="page-not-found"
      className="flex h-full items-center justify-center overflow-auto p-6"
    >
      <div className="w-full max-w-[520px]">
        <EmptyState
          title="页面不存在"
          description={`路径 ${pathname} 未匹配任何页面。`}
          hint="404 · 请检查地址，或返回抓包历史"
          action={
            <Link
              to="/history"
              data-testid="not-found-back"
              className="btn btn-primary"
            >
              返回抓包历史
            </Link>
          }
        />
      </div>
    </section>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/history" replace />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="repeater" element={<RepeaterPage />} />
        <Route path="scripts" element={<ScriptsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
