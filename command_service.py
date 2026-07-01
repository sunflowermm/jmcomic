"""JMComic 终端命令与插件更新。"""

from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path
from typing import List

from core.plugin_kit import default_plugin_update

logger = logging.getLogger(__name__)

_PLUGIN_DIR = Path(__file__).resolve().parent

_config_spec = importlib.util.spec_from_file_location(
    "jmcomic_plugin.config_loader",
    _PLUGIN_DIR / "_config_loader.py",
)
_config_mod = importlib.util.module_from_spec(_config_spec)
if _config_spec.name:
    sys.modules[_config_spec.name] = _config_mod
_config_spec.loader.exec_module(_config_mod)
get_config = _config_mod.get_config
_repo_root = _config_mod._repo_root


async def cmd_status(_request, _args: List[str]):
    cfg = get_config()
    download_dir = cfg.get("download_dir", "data/jmcomic/download")
    pdf_dir = cfg.get("pdf_dir", "data/jmcomic/pdf")
    return {
        "service": "jmcomic",
        "config": str(cfg.runtime_file),
        "download_dir": download_dir,
        "pdf_dir": pdf_dir,
        "max_concurrent": cfg.get("max_concurrent_downloads", 1),
    }


async def cmd_sync(_request, _args: List[str]):
    sync_spec = importlib.util.spec_from_file_location(
        "jmcomic_plugin.deploy_sync",
        _PLUGIN_DIR / "_deploy_sync.py",
    )
    sync_mod = importlib.util.module_from_spec(sync_spec)
    if sync_spec.name:
        sys.modules[sync_spec.name] = sync_mod
    sync_spec.loader.exec_module(sync_mod)
    cfg = get_config()
    updated = sync_mod.sync_qq_plugins(
        _repo_root(),
        target_core=cfg.get("deploy.target_core", "jm-Core"),
        enabled=bool(cfg.get("deploy.sync_qq_plugin_on_startup", True)),
    )
    return {"synced": updated, "count": len(updated)}


async def jmcomic_update(_request, args: List[str]):
    base = await default_plugin_update(
        _PLUGIN_DIR,
        pip=True,
        git=(_PLUGIN_DIR / ".git").exists(),
    )
    sync = await cmd_sync(_request, args)
    base["sync"] = sync
    base["ok"] = bool(base.get("ok", True))
    return base


default = {
    "name": "jmcomic-commands",
    "description": "JMComic 命令与更新",
    "group": "jmcomic",
    "plugin_dir": str(_PLUGIN_DIR),
    "priority": 199,
    "commands": {"status": cmd_status, "sync": cmd_sync},
    "on_update": jmcomic_update,
    "routes": [],
}
