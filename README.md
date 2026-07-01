# jmcomic 子服务插件

禁漫本子下载、PDF 导出与压缩；QQ 指令 `#车牌` 见 `plugin/车牌.js`。

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
| `pdf_compress.*` | 下载后 JPEG 重编码与限宽 |
| `deploy.*` | 启动时同步 `plugin/` → `core/jm-Core/plugin/` |

主服务连子服务：`data/server_bots/{port}/aistream.yaml` → `subserver.host` / `port`。

## API

- `POST /api/jmcomic/download` — body: `{"album_id":"123456"}`
- `GET /api/jmcomic/file?path=data/jmcomic/pdf/...`
- `POST /api/jmcomic/command` — `{"cmd":"status"}` / `{"cmd":"update"}` / `{"cmd":"sync"}`

## 终端 / QQ 更新

子服务交互终端：

```text
sub> jmcomic status
sub> jmcomic update
sub> jmcomic sync
```

主服务 QQ / stdin：`#子服 jmcomic update`
