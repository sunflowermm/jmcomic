# jmcomic 子服务插件

禁漫本子下载、PDF 导出与压缩；QQ `#车牌` 在 `core/plugin/`。

## 标准目录（子服业务插件 + CommonConfig）

```
apis/jmcomic/
  service.py              # 业务入口；default 含 plugin_config
  default_config.yaml     # 默认值 → data/jmcomic/config.yaml
  config_schema.yaml      # 控制台 schema（非主服 commonconfig/*.js）
  requirements.txt
  core/plugin/车牌.js     # 主服 QQ 插件
  _download_compress.py
  _pdf_compress.py
```

**CommonConfig 不在主服写 JS 插件**。主服 `ConfigLoader.registerFromSubserver()` 拉取 schema，注册 `SubserverConfigProxy`（控制台「禁漫本子」）。

## 配置

| 项 | 路径 |
|----|------|
| 运行时 | `data/jmcomic/config.yaml` |
| 控制台 | 主服 CommonConfig「禁漫本子」 |
| 子服端点 | AIStream → 子服务端（`cfg.subserver`） |

## API

- `POST /api/jmcomic/download`
- `GET /api/jmcomic/file?path=...`
- `GET/POST /api/jmcomic/config/*`（声明 `plugin_config` 后自动挂载）

## 终端

```text
子服> jmcomic 状态
子服> jmcomic 更新
```
