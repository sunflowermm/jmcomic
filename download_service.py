"""JMComic 下载与 PDF 导出 API（独立子服务插件，配置见本目录 default_config.yaml）。"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from pathlib import Path
from typing import Any, Dict, Optional

import importlib.util

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse

_config_spec = importlib.util.spec_from_file_location(
    "jmcomic_plugin.config_loader",
    Path(__file__).resolve().parent / "config_loader.py",
)
_config_mod = importlib.util.module_from_spec(_config_spec)
_config_spec.loader.exec_module(_config_mod)
get_config = _config_mod.get_config
_repo_root = _config_mod._repo_root

logger = logging.getLogger(__name__)
config = get_config()

_ALBUM_ID_RE = re.compile(r"^\d+$")


def _resolve_dir(key: str, fallback: Path) -> Path:
    raw = config.get(key, "")
    path = Path(raw) if raw else fallback
    if not path.is_absolute():
        path = _repo_root() / path
    path.mkdir(parents=True, exist_ok=True)
    return path


def _storage_dirs() -> tuple[Path, Path]:
    base = _repo_root() / "data" / "jmcomic"
    download_dir = _resolve_dir("download_dir", base / "download")
    pdf_dir = _resolve_dir("pdf_dir", base / "pdf")
    return download_dir, pdf_dir


def _build_option(download_dir: Path):
    import jmcomic

    option = jmcomic.JmOption.default()
    option.dir_rule.base_dir = str(download_dir)

    client_impl = config.get("client.impl", "api")
    if client_impl:
        option.client.impl = client_impl

    proxy = (config.get("client.proxy") or "").strip()
    if proxy:
        option.client.proxy = proxy

    return option


def _find_pdf(pdf_dir: Path, album_id: str) -> Optional[Path]:
    patterns = [
        f"[JM{album_id}]*.pdf",
        f"*{album_id}*.pdf",
    ]
    candidates: list[Path] = []
    for pattern in patterns:
        candidates.extend(pdf_dir.glob(pattern))

    if not candidates:
        candidates = list(pdf_dir.glob("*.pdf"))

    if not candidates:
        return None

    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for path in candidates:
        if album_id in path.name:
            return path
    return candidates[0]


def _to_relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(_repo_root().resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def _download_sync(album_id: str) -> Dict[str, Any]:
    from jmcomic import Feature, download_album

    download_dir, pdf_dir = _storage_dirs()
    option = _build_option(download_dir)
    delete_original = bool(config.get("delete_original", True))

    started = time.time()
    logger.info("开始下载本子 %s", album_id)

    download_album(
        album_id,
        option,
        extra=Feature.export_pdf(
            pdf_dir=str(pdf_dir),
            filename_rule="Aid",
            delete_original_file=delete_original,
        ),
    )

    pdf_path = _find_pdf(pdf_dir, album_id)
    if not pdf_path or not pdf_path.is_file():
        raise RuntimeError("PDF 生成失败，未在输出目录找到文件")

    title = pdf_path.stem
    if title.startswith(f"[JM{album_id}]"):
        title = title[len(f"[JM{album_id}]") :]

    elapsed = round(time.time() - started, 2)
    logger.info("本子 %s 下载完成，PDF=%s，耗时 %.2fs", album_id, pdf_path.name, elapsed)

    return {
        "ok": True,
        "album_id": album_id,
        "title": title or pdf_path.stem,
        "pdf_path": _to_relative(pdf_path),
        "pdf_name": pdf_path.name,
        "size": pdf_path.stat().st_size,
        "elapsed": elapsed,
    }


async def download_handler(request: Request):
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"无效 JSON: {exc}") from exc

    album_id = str(body.get("album_id", "")).strip()
    if not _ALBUM_ID_RE.fullmatch(album_id):
        raise HTTPException(status_code=400, detail="album_id 必须为纯数字")

    try:
        return await asyncio.to_thread(_download_sync, album_id)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("JMComic 下载失败 album=%s: %s", album_id, exc, exc_info=True)
        return {"ok": False, "album_id": album_id, "error": str(exc)}


def _safe_pdf_path(raw: str) -> Path:
    if not raw or ".." in raw.replace("\\", "/"):
        raise HTTPException(status_code=400, detail="非法文件路径")

    _, pdf_dir = _storage_dirs()
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = _repo_root() / raw

    resolved = candidate.resolve()
    pdf_root = pdf_dir.resolve()
    if pdf_root not in resolved.parents and resolved != pdf_root:
        raise HTTPException(status_code=403, detail="禁止访问该路径")

    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")

    return resolved


async def file_handler(request: Request):
    rel = request.query_params.get("path", "").strip()
    pdf_path = _safe_pdf_path(rel)
    return FileResponse(
        pdf_path,
        media_type="application/pdf",
        filename=pdf_path.name,
    )


async def startup_init(_app):
    sync_spec = importlib.util.spec_from_file_location(
        "jmcomic_plugin.deploy_sync",
        Path(__file__).resolve().parent / "deploy_sync.py",
    )
    sync_mod = importlib.util.module_from_spec(sync_spec)
    sync_spec.loader.exec_module(sync_mod)
    sync_mod.sync_qq_plugins(
        _repo_root(),
        target_core=config.get("deploy.target_core", "jm-Core"),
        enabled=bool(config.get("deploy.sync_qq_plugin_on_startup", True)),
    )


default = {
    "name": "jmcomic-download",
    "description": "禁漫本子下载并导出 PDF",
    "priority": 200,
    "init": startup_init,
    "routes": [
        {"method": "POST", "path": "/api/jmcomic/download", "handler": download_handler},
        {"method": "GET", "path": "/api/jmcomic/file", "handler": file_handler},
    ],
}
