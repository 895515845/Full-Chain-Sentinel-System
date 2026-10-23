import { useEffect, useState } from "react";
import { HIGHLIGHT_COLORS, type HighlightColor, type HighlightRect } from "../lib/highlights";

/* -------------------------------------------------------------------------- */
/* 请求编辑器的高亮层（底层色块 + 上层透明 textarea）                          */
/* -------------------------------------------------------------------------- */

interface LayerProps {
  rects: HighlightRect[];
  scrollTop: number;
  scrollLeft: number;
}

export function HighlightLayer({ rects, scrollTop, scrollLeft }: LayerProps) {
  return (
    <div
      aria-hidden="true"
      data-testid="repeater-request-highlight-layer"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {rects.map((rect, index) => (
        <span
          key={`${rect.color}-${rect.x}-${rect.y}-${index}`}
          className="absolute rounded-[2px]"
          style={{
            left: rect.x - scrollLeft,
            top: rect.y - scrollTop,
            width: rect.width,
            height: rect.height,
            backgroundColor: HIGHLIGHT_COLORS.find((spec) => spec.key === rect.color)?.mark,
          }}
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 选中文字后浮出的工具条                                                      */
/* -------------------------------------------------------------------------- */

export interface SelectionAnchor {
  target: "request" | "response";
  start: number;
  end: number;
  /** 选区在视口里的位置（用来摆工具条） */
  rect: { x: number; y: number; width: number; height: number };
  /** 选区上已经存在的高亮（有则显示"清除"） */
  existing: boolean;
}

interface ToolbarProps {
  anchor: SelectionAnchor;
  onPick: (color: HighlightColor) => void;
  onClear: () => void;
  onCopy: () => void;
  onDismiss: () => void;
}

const TOOLBAR_WIDTH = 232;

export function HighlightToolbar({ anchor, onPick, onClear, onCopy, onDismiss }: ToolbarProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [anchor.start, anchor.end, anchor.target]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  const viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth;
  const left = Math.max(8, Math.min(anchor.rect.x + anchor.rect.width / 2 - TOOLBAR_WIDTH / 2, viewportWidth - TOOLBAR_WIDTH - 8));
  const above = anchor.rect.y > 56;
  const top = above ? anchor.rect.y - 40 : anchor.rect.y + anchor.rect.height + 8;

  return (
    <div
      role="toolbar"
      aria-label="高亮工具栏"
      data-testid="highlight-toolbar"
      className="fixed z-30 flex items-center gap-1 rounded-lg border border-line bg-panel/95 px-2 py-1 shadow-lg backdrop-blur"
      style={{ left, top }}
      onMouseDown={(event) => event.preventDefault()} // 别把选区弄没了
    >
      <span className="pr-1 font-mono text-[10px] text-muted/70">
        {anchor.end - anchor.start} 字符
      </span>
      {HIGHLIGHT_COLORS.map((spec) => (
        <button
          key={spec.key}
          type="button"
          data-testid={`highlight-color-${spec.key}`}
          title={`标记为${spec.label}色`}
          aria-label={`标记为${spec.label}色`}
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-panel"
          onClick={() => onPick(spec.key)}
        >
          <span className={`h-3.5 w-3.5 rounded-sm ${spec.dot}`} />
        </button>
      ))}
      <span className="mx-0.5 h-4 w-px bg-line" />
      <button
        type="button"
        data-testid="highlight-copy"
        className="btn h-6 px-1.5 text-[11px]"
        onClick={() => {
          onCopy();
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? "已复制" : "复制"}
      </button>
      {anchor.existing ? (
        <button
          type="button"
          data-testid="highlight-clear"
          className="btn h-6 px-1.5 text-[11px] text-danger"
          onClick={onClear}
        >
          清除
        </button>
      ) : null}
      <button
        type="button"
        data-testid="highlight-dismiss"
        className="btn h-6 px-1.5 text-[11px]"
        onClick={onDismiss}
        aria-label="关闭高亮工具栏"
      >
        ×
      </button>
    </div>
  );
}
