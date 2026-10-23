import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { NAV_ITEMS } from "../lib/nav";
import type { NavId } from "../lib/nav";
import { subscribe } from "../lib/events";
import { getProxyStatus } from "../lib/proxy";

function LogoMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 text-accent"
      aria-hidden="true"
    >
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="m4.5 6 2 2-2 2M8.5 10h3" />
    </svg>
  );
}

function NavIcon({ id }: { id: NavId }) {
  const common = {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    className: "h-4 w-4",
    "aria-hidden": true,
  } as const;

  switch (id) {
    case "history":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.25" />
          <path d="M8 4.75V8l2.25 1.5" />
        </svg>
      );
    case "repeater":
      return (
        <svg {...common}>
          <path d="M3 5.5h9.5L10 3M13 10.5H3.5L6 13" />
        </svg>
      );
    case "scripts":
      return (
        <svg {...common}>
          <path d="M5.5 3 2 8l3.5 5M10.5 3 14 8l-3.5 5" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
          <circle cx="6" cy="4.5" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="10" cy="8" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="5" cy="11.5" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}

/** 左侧固定导航栏（200px）：产品标识、路由入口、代理状态。 */
export default function NavRail() {
  const [proxy, setProxy] = useState<{ running: boolean; listen: string }>({
    running: false,
    listen: "",
  });

  useEffect(() => {
    let alive = true;
    const load = () => {
      void getProxyStatus()
        .then((status) => {
          if (alive) setProxy({ running: status.running, listen: status.listen });
        })
        .catch(() => {
          // 后端不可用时保持"未启动"外观
        });
    };
    load();
    const subscription = subscribe((event) => {
      if (event.type === "proxy.status") load();
    });
    return () => {
      alive = false;
      subscription.close();
    };
  }, []);

  return (
    <nav
      aria-label="主导航"
      data-testid="nav-rail"
      className="flex w-[200px] shrink-0 flex-col border-r border-line bg-panel"
    >
      <div className="flex h-[58px] shrink-0 items-center justify-between border-b border-line px-4">
        <div className="min-w-0">
          <p className="text-[14px] font-semibold leading-tight tracking-tight text-ink">
            replayd
          </p>
          <p className="mt-1 font-mono text-[9px] leading-none text-muted/60">
            v0.1.0-dev
          </p>
        </div>
        <LogoMark />
      </div>

      <ul className="flex flex-col gap-0.5 px-2 py-3">
        {NAV_ITEMS.map((item) => (
          <li key={item.id}>
            <NavLink
              to={item.to}
              data-testid={`nav-${item.id}`}
              className={({ isActive }) =>
                [
                  "group flex items-center gap-2.5 rounded-md border px-2.5 py-2 transition-opacity duration-100",
                  isActive
                    ? "border-line bg-[#16202c] text-ink"
                    : "border-transparent text-muted hover:bg-[#0f1620] hover:text-ink",
                ].join(" ")
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={isActive ? "text-accent" : "text-muted/70 group-hover:text-muted"}
                  >
                    <NavIcon id={item.id} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[12px] font-medium leading-tight">
                      {item.label}
                    </span>
                    <span className="mt-0.5 text-[10px] leading-none text-muted/60">
                      {item.subtitle}
                    </span>
                  </span>
                  {isActive ? (
                    <span aria-hidden="true" className="h-4 w-0.5 rounded-sm bg-accent" />
                  ) : null}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="mt-auto shrink-0 border-t border-line p-3">
        <div
          data-testid="proxy-status"
          data-state={proxy.running ? "running" : "stopped"}
          className="flex items-center gap-2 rounded-md border border-line bg-bg px-2.5 py-2"
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${proxy.running ? "bg-accent" : "bg-danger"}`}
          />
          <span className="text-[11px] text-muted">
            {proxy.running ? "抓包中" : "代理未启动"}
          </span>
          <span className="ml-auto font-mono text-[10px] text-muted/50">
            {proxy.listen !== "" ? proxy.listen.replace(/^[^:]*:/, ":") : ":8898"}
          </span>
        </div>
        <p className="mt-2 px-1 text-[10px] leading-relaxed text-muted/50">
          {proxy.running ? "浏览器/客户端指向该地址即可抓包" : "到 Settings 启动 MITM 代理"}
        </p>
      </div>
    </nav>
  );
}
