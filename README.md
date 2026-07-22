# jmcomic 子服务插件

禁漫本子下载、PDF 导出与压缩；QQ `#车牌` / `#开盲盒`；AI 工作流 MCP。

## 目录

```
apis/jmcomic/
  service.py
  default_config.yaml       # → data/jmcomic/config.yaml
  core/
    commonconfig/jmcomic.js # 主服控制台（ConfigBase）
    plugin/车牌.js          # #车牌 / #开盲盒
    workflow/jmcomic.js     # AI：jm_download / jm_blind_box（frameworkToolSurface）
```

## 配置

| 侧 | 路径 |
|----|------|
| 运行时 yaml | `data/jmcomic/config.yaml` |
| 控制台 | 主服 CommonConfig「禁漫本子」 |
| 子服连接 | AiWorkflow → 子服务端（`runtimeConfig.subserver`） |

## API

- `POST /api/jmcomic/download` — `{ album_id }`
- `POST /api/jmcomic/blind-box` — 可选 `{ tag }`；固定 1 本（含 `pick_source` / `tag`）
- `GET /api/jmcomic/file?path=...`

抽号：`seed_ids` → `tag`（`search_tag`）→ `ranking`。

## QQ

- `#车牌123456` / `#开盲盒` / `#开盲盒 全彩 中文` / `#开盲盒 +全彩 +中文 -CG`
- tag：空格多标签 → `+A +B`；`iter_id_title_tag` 二次校验；`order_by`/`time`/`pages` 可配
- 进度/车牌/直链/PDF：`reply(..., { recallMsg: 120 })` 发出即预约撤回

## AI

| 工具 | 入参 |
|------|------|
| `jmcomic.jm_download` | `album_id` |
| `jmcomic.jm_blind_box` | 可选 `tag` |

有会话：API + 车牌插件交付（不套 `PluginLoader.deal`）。  
**勿**写入框架 `PyserverApi`。
