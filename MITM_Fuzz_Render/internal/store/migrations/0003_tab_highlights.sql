-- 0003_tab_highlights.sql — 标签页上的请求/响应高亮标记
-- 存 JSON：{"request":[{"start":0,"end":12,"color":"yellow"}],
--          "response":{"raw":[...],"pretty":[...],"hex":[...]}}
-- 放服务端（而不是浏览器）是为了让 /api/capture 的无头截图也能带上高亮。

ALTER TABLE tabs ADD COLUMN highlights TEXT;
