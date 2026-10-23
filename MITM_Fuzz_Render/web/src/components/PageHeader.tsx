import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  kicker: string;
  description: string;
  children?: ReactNode;
}

/** 应用顶栏：当前页面标题 + 右侧全局状态。 */
export default function PageHeader({
  title,
  kicker,
  description,
  children,
}: PageHeaderProps) {
  return (
    <header className="flex h-[58px] shrink-0 items-center justify-between gap-4 border-b border-line bg-panel px-5">
      <div className="flex min-w-0 items-baseline gap-3">
        <h1
          id="page-title"
          className="shrink-0 text-[15px] font-semibold tracking-wide text-ink"
        >
          {title}
        </h1>
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-[10px] uppercase tracking-[0.16em] text-muted/60"
        >
          {kicker}
        </span>
        <p className="hidden truncate border-l border-line pl-3 text-[11px] text-muted/70 xl:block">
          {description}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="font-mono text-[10px] text-muted/50">M0 · 骨架</span>
        {children}
      </div>
    </header>
  );
}
