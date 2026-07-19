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

- `POST /api/jmcomic/download` — body `{ album_id }`（纯数字）
- `POST /api/jmcomic/blind-box` — 无参，固定随机 1 本（响应同 download）
- `GET /api/jmcomic/file?path=...`

## QQ

- `#车牌123456` — 指定车牌下载并交付
- `#开盲盒` — 排行榜随机 1 本（不要后缀数字）

## AI（chat 工具面）

工作流名 `jmcomic`（`frameworkToolSurface: true`）：

| 工具 | 入参 |
|------|------|
| `jmcomic.jm_download` | `album_id` 纯数字 |
| `jmcomic.jm_blind_box` | 无 |

有会话时代发 `#车牌` / `#开盲盒`；无会话只调子服 API 返回元数据。  
**勿**把本插件写进框架 `PyserverApi`（第三方本地插件）。
