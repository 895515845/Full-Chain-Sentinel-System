export interface NavItem {
  id: "history" | "repeater" | "scripts" | "settings";
  to: string;
  label: string;
  subtitle: string;
  title: string;
  kicker: string;
  description: string;
}

export type NavId = NavItem["id"];

export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: "history",
    to: "/history",
    label: "History",
    subtitle: "抓包历史",
    title: "抓包历史",
    kicker: "PROXY HISTORY",
    description: "浏览代理捕获的请求，筛选后可发送到 Repeater。",
  },
  {
    id: "repeater",
    to: "/repeater",
    label: "Repeater",
    subtitle: "请求重放",
    title: "请求重放",
    kicker: "REPEATER",
    description: "手工编辑原始请求并逐字节重放，对照查看响应。",
  },
  {
    id: "scripts",
    to: "/scripts",
    label: "Scripts",
    subtitle: "脚本钩子",
    title: "脚本",
    kicker: "SCRIPT HOOKS",
    description: "用脚本改写入站/出站报文，并为响应编写断言。",
  },
  {
    id: "settings",
    to: "/settings",
    label: "Settings",
    subtitle: "运行设置",
    title: "设置",
    kicker: "SETTINGS",
    description: "查看当前运行实例、代理与证书状态。",
  },
];

export interface PageMeta {
  title: string;
  kicker: string;
  description: string;
}

const HISTORY_META: PageMeta = {
  title: NAV_ITEMS[0]?.title ?? "抓包历史",
  kicker: NAV_ITEMS[0]?.kicker ?? "PROXY HISTORY",
  description: NAV_ITEMS[0]?.description ?? "",
};

const NOT_FOUND_META: PageMeta = {
  title: "页面不存在",
  kicker: "404 NOT FOUND",
  description: "当前路径没有对应页面。",
};

export function getPageMeta(pathname: string): PageMeta {
  if (pathname === "/") {
    return HISTORY_META;
  }

  const item = NAV_ITEMS.find(
    (candidate) =>
      pathname === candidate.to || pathname.startsWith(`${candidate.to}/`),
  );

  if (!item) {
    return NOT_FOUND_META;
  }

  return {
    title: item.title,
    kicker: item.kicker,
    description: item.description,
  };
}
