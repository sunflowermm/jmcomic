# jmcomic 子服务插件

禁漫本子下载、PDF 导出与压缩；QQ 指令 `#车牌` 见 `plugin/车牌.js`（启动时同步至 `core/jm-Core/plugin/`）。

Python 入口为单文件 `service.py`（routes + commands + init/shutdown，符合 CONTRACT）。

## 依赖

```bash
cd subserver/pyserver
uv pip install -r apis/jmcomic/requirements.txt
```

## 配置

运行时：`data/jmcomic/config.yaml`（首次从 `default_config.yaml` 复制）。

| 段 | 说明 |
|---|---|
| `client.impl` / `client.proxy` | jmcomic 客户端 |
| `limits.*` | 本子大小预检与超时（超限返回原因，不强行下载） |
| `pdf_compress.*` | 拉取时压图（`compress_at_download`）+ 超限 PDF 级 fallback |
| `deploy.*` | 启动时同步 `plugin/` → `core/jm-Core/plugin/` |

主服务连子服务：`data/server_bots/{port}/aistream.yaml` → `subserver.host` / `port`。

## API

- `POST /api/jmcomic/download` — body: `{"album_id":"123456"}`
- `GET /api/jmcomic/file?path=data/jmcomic/pdf/...`
- `POST /api/jmcomic/command` — `{"cmd":"status"}` / `{"cmd":"update"}` / `{"cmd":"sync"}`

## 终端 / QQ 更新

子服务交互终端：

```text
子服> jmcomic 状态
子服> jmcomic 更新
子服> jmcomic 同步
```
