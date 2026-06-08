# xrk-jmcomic-plugin

XRK-AGT **独立子服务插件**：禁漫本子下载 + PDF 导出 + 配套 QQ `#车牌` 指令。

不写入 AGT 本体 `config/default_config/`、`data/subserver/config.yaml` 或 `docs/subserver-api.md`。

---

## 仓库结构（本目录即仓库根）

```
.
├── README.md
├── requirements.txt          # Python 依赖（仅本插件）
├── default_config.yaml       # 配置模板 → 首次运行复制到 data/jmcomic/config.yaml
├── config_loader.py
├── deploy_sync.py            # 启动时同步 plugin/ → core/jm-Core/plugin/
├── download_service.py       # ApiLoader 热插拔入口
├── __init__.py
├── plugin/
│   └── 车牌.js               # QQ 插件 → 部署到 core/jm-Core/plugin/
└── deploy/
    ├── install.sh            # Linux/macOS 一键复制
    └── install.ps1           # Windows 一键复制
```

---

## 新建仓库

在本目录（`apis/jmcomic`）初始化即可：

```bash
git init
git add .
git commit -m "init: xrk jmcomic subserver plugin"
git remote add origin <你的仓库 URL>
git push -u origin main
```

> **主仓 XRK-AGT** 已在根 `.gitignore` 忽略 `subserver/pyserver/apis/jmcomic/` 与 `data/jmcomic/`；`core/jm-Core/` 由 `core/*` 规则忽略。插件代码只进独立仓库，部署时用 `deploy/install.*` 复制。

---

## 部署到 XRK-AGT（复制安装）

### 方式 A：脚本（推荐）

**Linux / macOS**

```bash
chmod +x deploy/install.sh
./deploy/install.sh /path/to/XRK-AGT
```

**Windows**

```powershell
.\deploy\install.ps1 C:\path\to\XRK-AGT
```

脚本会做两件事：

| 来源 | 目标 |
|------|------|
| 本仓库根目录（Python 文件） | `{AGT}/subserver/pyserver/apis/jmcomic/` |
| `plugin/车牌.js` | `{AGT}/core/jm-Core/plugin/车牌.js` |

> 若仓库就放在 AGT 的 `apis/jmcomic/` 内开发，脚本会跳过 Python 文件自复制，仅更新 `core/jm-Core/plugin/车牌.js`。

### 方式 B：手动复制

1. 将除 `plugin/`、`deploy/` 外的文件复制到 `XRK-AGT/subserver/pyserver/apis/jmcomic/`
2. 将 `plugin/车牌.js` 复制到 `XRK-AGT/core/jm-Core/plugin/车牌.js`（`jm-Core` 目录不存在则新建）

---

## 安装依赖

```bash
cd XRK-AGT/subserver/pyserver
uv pip install -r apis/jmcomic/requirements.txt
```

Docker 部署需在子服务容器内执行上述命令，或把 `requirements.txt` 挂进你的自定义镜像构建步骤（**不要**改 AGT 本体 Dockerfile，除非你要做私有 fork）。

---

## 配置

| 文件 | 说明 |
|------|------|
| `default_config.yaml` | 仓库内模板 |
| `data/jmcomic/config.yaml` | 运行时配置（首次加载自动从模板复制） |

```yaml
download_dir: "data/jmcomic/download"
pdf_dir: "data/jmcomic/pdf"
delete_original: true
client:
  impl: "api"    # api | mobile（被墙时可改 mobile）
  proxy: ""      # 例 http://127.0.0.1:7890
deploy:
  sync_qq_plugin_on_startup: true   # 子服务启动时自动同步 QQ 插件
  target_core: "jm-Core"            # 同步目标 Core 名
```

### QQ 插件自动同步

**每次子服务启动**（加载本 API 的 `init` 钩子）会：

1. 读取 `plugin/*.js`（源，以仓库内 `plugin/车牌.js` 为准）
2. 与 `{AGT}/core/<target_core>/plugin/` 下同名文件**逐字节对比**
3. **仅在不一致或目标不存在时**覆盖复制；内容相同则跳过

关闭同步：在 `data/jmcomic/config.yaml` 设 `deploy.sync_qq_plugin_on_startup: false`。

> 主服务需**重启或热加载插件**后，新的 `core/jm-Core/plugin/车牌.js` 才会被 Node 加载。

---

## 主服务连接子服务

仅需在 `data/server_bots/{port}/aistream.yaml` 配置（**不改** AGT 默认模板）：

```yaml
subserver:
  host: "127.0.0.1"      # 本子机跑子服务；多 AGT 共用填子服务所在机器 IP
  port: 8000
  timeout: 30000
```

**多 AGT 共用一台子服务**：只有跑子服务的那台 AGT 本地有 `data/jmcomic/pdf/`。其它 AGT 通过 `Bot.fetchSubserverToPath` 经 `GET /api/jmcomic/file` 拉取到 `data/jmcomic/cache/`，无需在本机再装 jmcomic 依赖。

QQ 插件内部对下载请求单独使用 10 分钟超时，无需把全局 `timeout` 调很大。

---

## API

子服务启动后访问 `GET /api/list`，应出现 `jmcomic-download`。

### `POST /api/jmcomic/download`

```json
{ "album_id": "123456" }
```

成功响应示例：

```json
{
  "ok": true,
  "cached": true,
  "album_id": "123456",
  "title": "本子标题",
  "pdf_path": "data/jmcomic/pdf/[JM123456]本子标题.pdf",
  "pdf_name": "[JM123456]本子标题.pdf",
  "file_url": "/api/jmcomic/file?path=data/jmcomic/pdf/...",
  "size": 1048576,
  "elapsed": 0
}
```

`cached: true` 表示 `data/jmcomic/pdf/` 已有该本子 PDF，跳过下载。可在 `data/jmcomic/config.yaml` 设 `reuse_existing_pdf: false` 强制重新下载。

> PDF 缓存按文件名精确匹配 `[JM{id}]…` 或 `{id}.pdf`，**不会**用 glob 的 `[]` 模式（否则会误命中其他本子，例如始终把 `1375860.pdf` 当成缓存）。

### `GET /api/jmcomic/file?path=...`

按相对项目根路径下载 PDF（路径限制在 `pdf_dir` 内）。

---

## QQ 使用

群内发送：

```
#车牌123456
```

流程：提示处理中 → PDF 就绪后 **先发直链**（`/subserver-file?path=…`）→ **再上传群文件**；直链与群文件消息均在 **2 分钟后撤回**。

直链示例：`https://你的域名:端口/subserver-file?path=data/jmcomic/pdf/643777.pdf`

公网根地址：`Bot.getPublicServerUrl()`（优先 `server.url` / `public_base_url`）。**勿再用** `/media/jmcomic/…` 作 PDF 直链。

---

## 启动子服务

部署并完成依赖安装后，在 **AGT 的** `subserver/pyserver` 目录执行：

**Linux**

```bash
cd /path/to/XRK-AGT/subserver/pyserver
uv sync                                    # 首次：子服务底层依赖
uv pip install -r apis/jmcomic/requirements.txt   # 本插件依赖
uv run xrk
```

开发热重载：

```bash
HOST=0.0.0.0 PORT=8000 RELOAD=true uv run xrk
```

**Windows（PowerShell）**

```powershell
cd C:\path\to\XRK-AGT\subserver\pyserver
uv sync
uv pip install -r apis\jmcomic\requirements.txt
uv run xrk
```

验证：

```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/api/list    # 应含 jmcomic-download
```

Docker 仅起子服务：`docker compose up -d xrk-subserver`（在 AGT 根目录）。

---

## 卸载

1. 删除 `subserver/pyserver/apis/jmcomic/`
2. 删除 `core/jm-Core/plugin/车牌.js`（若 `jm-Core` 无其他插件可删整个目录）
3. 可选：删除 `data/jmcomic/`
4. 重启主服务与子服务

---

## 依赖说明

基于 [jmcomic](https://pypi.org/project/jmcomic/)（JMComic-Crawler-Python）。若需指定 fork，修改 `requirements.txt` 为 git 源即可。
