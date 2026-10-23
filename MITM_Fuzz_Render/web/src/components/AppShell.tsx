import { Outlet, useLocation } from "react-router-dom";
import { useHealth } from "../lib/health";
import { getPageMeta } from "../lib/nav";
import NavRail from "./NavRail";
import PageHeader from "./PageHeader";
import StatusPill from "./StatusPill";

/** 应用外壳：左侧导航 + 顶栏 + 路由内容区。 */
export default function AppShell() {
  const { pathname } = useLocation();
  const meta = getPageMeta(pathname);
  const health = useHealth();

  return (
    <div className="flex h-screen min-w-[1280px] overflow-hidden bg-bg text-ink">
      <NavRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          title={meta.title}
          kicker={meta.kicker}
          description={meta.description}
        >
          <StatusPill
            state={health.state}
            info={health.info}
            lastCheckedAt={health.lastCheckedAt}
          />
        </PageHeader>
        <main
          aria-labelledby="page-title"
          className="min-h-0 flex-1 overflow-hidden"
        >
          <Outlet context={health} />
        </main>
      </div>
    </div>
  );
}
