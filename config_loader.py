"""JM 子服务插件本地配置（与 AGT 本体 data/subserver/config.yaml 无关）。"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Dict

import yaml

_PLUGIN_DIR = Path(__file__).resolve().parent
_DEFAULT_FILE = _PLUGIN_DIR / "default_config.yaml"


def _repo_root() -> Path:
    # apis/jmcomic -> apis -> pyserver -> subserver -> 项目根
    return _PLUGIN_DIR.parents[3]


def _runtime_config_file() -> Path:
    return _repo_root() / "data" / "jmcomic" / "config.yaml"


def _merge(default: Dict[str, Any], user: Dict[str, Any]) -> Dict[str, Any]:
    result = default.copy()
    for key, value in user.items():
        if (
            key in result
            and isinstance(result[key], dict)
            and isinstance(value, dict)
        ):
            result[key] = _merge(result[key], value)
        else:
            result[key] = value
    return result


def _builtin_default() -> Dict[str, Any]:
    return {
        "download_dir": "data/jmcomic/download",
        "pdf_dir": "data/jmcomic/pdf",
        "delete_original": True,
        "reuse_existing_pdf": True,
        "client": {"impl": "api", "proxy": ""},
        "public_base_url": "",
        "deploy": {
            "sync_qq_plugin_on_startup": True,
            "target_core": "jm-Core",
        },
    }


class JmcomicConfig:
    _instance: "JmcomicConfig | None" = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._config = {}
            cls._instance._load()
        return cls._instance

    def _ensure_runtime_file(self):
        runtime = _runtime_config_file()
        runtime.parent.mkdir(parents=True, exist_ok=True)
        if runtime.exists():
            return
        if _DEFAULT_FILE.exists():
            shutil.copy2(_DEFAULT_FILE, runtime)
        else:
            with open(runtime, "w", encoding="utf-8") as f:
                yaml.dump(
                    _builtin_default(),
                    f,
                    allow_unicode=True,
                    default_flow_style=False,
                    sort_keys=False,
                )

    def _load(self):
        self._ensure_runtime_file()
        runtime = _runtime_config_file()
        with open(runtime, "r", encoding="utf-8") as f:
            user = yaml.safe_load(f) or {}
        self._config = _merge(_builtin_default(), user)

    def get(self, key: str, default: Any = None) -> Any:
        value: Any = self._config
        for part in key.split("."):
            if isinstance(value, dict) and part in value:
                value = value[part]
            else:
                return default
        return value

    @property
    def runtime_file(self) -> Path:
        return _runtime_config_file()


def get_config() -> JmcomicConfig:
    return JmcomicConfig()
