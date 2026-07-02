"""下载阶段逐张压图：PDF 由小图合成，避免下载后再跑 pymupdf 整本重压。"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Protocol

from jmcomic import JmModuleConfig, JmOptionPlugin

from ._pdf_compress import compress_image_bytes, load_compress_settings

logger = logging.getLogger(__name__)

_PLUGIN_KEY = "xrk_jm_image_compress"
_PLUGIN_REGISTERED = False


class ConfigReader(Protocol):
    def get(self, key: str, default: Any = None) -> Any: ...


class JmImageCompressPlugin(JmOptionPlugin):
    plugin_key = _PLUGIN_KEY

    def invoke(self, image=None, downloader=None, **kwargs) -> None:
        if not kwargs.get("enabled", True):
            return
        if image is None:
            return
        if getattr(image, "is_gif", False):
            return

        save_path = getattr(image, "save_path", None)
        if not save_path or not os.path.isfile(save_path):
            return

        quality = int(kwargs.get("jpeg_quality", 62) or 62)
        max_width = int(kwargs.get("max_image_width", 1080) or 0)
        compress_image_file(
            Path(save_path),
            jpeg_quality=quality,
            max_image_width=max_width,
        )


def _ensure_plugin_registered() -> None:
    global _PLUGIN_REGISTERED
    if _PLUGIN_REGISTERED:
        return
    JmModuleConfig.register_plugin(JmImageCompressPlugin)
    _PLUGIN_REGISTERED = True


def compress_image_file(
    path: Path,
    *,
    jpeg_quality: int,
    max_image_width: int,
) -> bool:
    try:
        original = path.read_bytes()
    except OSError as exc:
        logger.debug("[jmcomic] 读取图片失败 %s: %s", path, exc)
        return False

    compressed = compress_image_bytes(
        original,
        jpeg_quality=jpeg_quality,
        max_width=max_image_width,
    )
    if not compressed:
        return False

    target = path
    if path.suffix.lower() not in {".jpg", ".jpeg"}:
        target = path.with_suffix(".jpg")

    fd, tmp_name = tempfile.mkstemp(
        suffix=target.suffix,
        dir=str(target.parent),
    )
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        tmp_path.write_bytes(compressed)
        tmp_path.replace(target)
        if target != path and path.is_file():
            path.unlink(missing_ok=True)
    except OSError as exc:
        logger.debug("[jmcomic] 写入压图失败 %s: %s", target, exc)
        tmp_path.unlink(missing_ok=True)
        return False
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)

    return True


def attach_download_compress(option, config: ConfigReader) -> None:
    """在 jmcomic 拉取每张图后立刻降质/限宽，供后续 img2pdf 直接使用。"""
    if not bool(config.get("pdf_compress.compress_at_download", True)):
        return

    settings = load_compress_settings(config)
    if not settings["enabled"]:
        return

    _ensure_plugin_registered()
    option.download.image.suffix = ".jpg"

    kwargs = {
        "enabled": True,
        "jpeg_quality": settings["jpeg_quality"],
        "max_image_width": settings["max_image_width"],
    }
    plugins = option.plugins.src_dict
    after_image = plugins.setdefault("after_image", [])
    for item in after_image:
        if item.get("plugin") == _PLUGIN_KEY:
            item["kwargs"] = kwargs
            item["log"] = False
            return

    after_image.append(
        {
            "plugin": _PLUGIN_KEY,
            "kwargs": kwargs,
            "log": False,
        }
    )
