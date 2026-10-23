import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description: string;
  testId?: string;
  action?: ReactNode;
  hint?: string;
}

function InboxIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M2.5 9.5 4.5 3.5h7l2 6v3h-11z" />
      <path d="M2.5 9.5h3l1 1.5h3l1-1.5h3" />
    </svg>
  );
}

/** 统一的空态卡片：真实 DOM 文本，无图片/动画。 */
export default function EmptyState({
  title,
  description,
  testId,
  action,
  hint,
}: EmptyStateProps) {
  return (
    <div
      data-testid={testId}
      className="flex w-full flex-col items-center justify-center rounded-lg border border-dashed border-line bg-panel/40 px-6 py-12 text-center"
    >
      <div
        aria-hidden="true"
        className="mb-4 flex h-9 w-9 items-center justify-center rounded-md border border-line bg-panel text-muted/70"
      >
        <InboxIcon />
      </div>
      <p className="text-[13px] font-medium text-ink">{title}</p>
      <p className="mt-1.5 max-w-[440px] text-[12px] leading-relaxed text-muted">
        {description}
      </p>
      {action ? <div className="mt-4">{action}</div> : null}
      {hint ? (
        <p className="mt-3 font-mono text-[10px] leading-relaxed text-muted/50">{hint}</p>
      ) : null}
    </div>
  );
}
