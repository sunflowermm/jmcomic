# jmcomic 子服务插件

禁漫本子下载、PDF 导出与压缩。

## 目录

```
apis/jmcomic/
  service.py
  default_config.yaml       # → data/jmcomic/config.yaml
  core/
    commonconfig/jmcomic.js # 主服控制台（ConfigBase）
    plugin/车牌.js          # QQ #车牌
```

## 配置

| 侧 | 路径 |
|----|------|
| 运行时 yaml | `data/jmcomic/config.yaml` |
| 控制台 | 主服 CommonConfig「禁漫本子」（扫描 `core/commonconfig/jmcomic.js`，**无需 pyserver 在线**） |
| 子服连接 | AIStream → 子服务端（`cfg.subserver`） |

## API

- `POST /api/jmcomic/download`
- `GET /api/jmcomic/file?path=...`
