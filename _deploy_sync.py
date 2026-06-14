"""子服务启动时将 plugin/ 同步到 core/<Core>/plugin/（内容不一致才覆盖）。"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)

_PLUGIN_DIR = Path(__file__).resolve().parent / "plugin"


def sync_qq_plugins(repo_root: Path, *, target_core: str, enabled: bool = True) -> list[str]:
    """对比并复制 plugin/*.js，返回已更新文件的相对路径列表。"""
    if not enabled:
        logger.debug("QQ 插件启动同步已关闭")
        return []

    if not _PLUGIN_DIR.is_dir():
        logger.warning("未找到 plugin 目录，跳过 QQ 插件同步: %s", _PLUGIN_DIR)
        return []

    dest_dir = repo_root / "core" / target_core / "plugin"
    dest_dir.mkdir(parents=True, exist_ok=True)

    updated: list[str] = []
    for src in sorted(_PLUGIN_DIR.glob("*.js")):
        dest = dest_dir / src.name
        src_bytes = src.read_bytes()
        if dest.is_file() and dest.read_bytes() == src_bytes:
            continue
        shutil.copy2(src, dest)
        rel = dest.relative_to(repo_root).as_posix()
        updated.append(rel)
        logger.info("QQ 插件已同步: %s -> %s", src.name, rel)

    if not updated:
        logger.debug("QQ 插件已是最新，无需同步 (%s)", dest_dir)

    return updated
