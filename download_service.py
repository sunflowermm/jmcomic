"""JMComic 下载与 PDF 导出 API（独立子服务插件，配置见本目录 default_config.yaml）。"""

from __future__ import annotations

import asyncio
import concurrent.futures
import gc
import logging
import re
import shutil
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.parse import quote

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
_PDF_INDEX: Dict[str, Tuple[float, str]] = {}
_download_executor: Optional[concurrent.futures.ThreadPoolExecutor] = None
_download_semaphore: Optional[asyncio.Semaphore] = None


def _max_concurrent() -> int:
    raw = config.get("max_concurrent_downloads", 1)
    try:
        return max(1, min(int(raw or 1), 2))
    except (TypeError, ValueError):
        return 1


def _ensure_download_pool() -> Tuple[asyncio.Semaphore, concurrent.futures.ThreadPoolExecutor]:
    global _download_executor, _download_semaphore
    limit = _max_concurrent()
    if _download_semaphore is None:
        _download_semaphore = asyncio.Semaphore(limit)
    if _download_executor is None:
        _download_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=limit,
            thread_name_prefix="jmcomic",
        )
    return _download_semaphore, _download_executor


def _log_memory(tag: str) -> None:
    try:
        import resource

        usage = resource.getrusage(resource.RUSAGE_SELF)
        # Linux: KB；macOS: bytes
        rss = usage.ru_maxrss
        rss_mb = rss / 1024 if rss > 10_000_000 else rss / 1024
        logger.debug("[jmcomic] %s RSS≈%.1fMB", tag, rss_mb)
    except Exception:
        pass


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


def _pdf_belongs_to_album(path: Path, album_id: str) -> bool:
    """按文件名判断 PDF 是否属于指定本子（禁止 glob 的 [] 字符类误匹配）。"""
    name = path.name
    stem = path.stem
    jm_prefix = f"[JM{album_id}]"
    if name == f"{album_id}.pdf" or stem == album_id:
        return True
    if stem.startswith(jm_prefix) or name.startswith(jm_prefix):
        return True
    return False


def _find_pdf(pdf_dir: Path, album_id: str) -> Optional[Path]:
    cached = _PDF_INDEX.get(album_id)
    if cached:
        mtime, path_str = cached
        candidate = Path(path_str)
        if candidate.is_file():
            try:
                if candidate.stat().st_mtime == mtime:
                    return candidate
            except OSError:
                pass
        _PDF_INDEX.pop(album_id, None)

    candidates: list[Path] = []
    direct = pdf_dir / f"{album_id}.pdf"
    if direct.is_file():
        candidates.append(direct)

    try:
        for path in pdf_dir.iterdir():
            if not path.is_file() or path.suffix.lower() != ".pdf":
                continue
            if path == direct:
                continue
            if _pdf_belongs_to_album(path, album_id):
                candidates.append(path)
    except OSError as exc:
        logger.warning("扫描 PDF 目录失败: %s", exc)

    if not candidates:
        return None

    best = max(candidates, key=lambda p: p.stat().st_mtime)
    _PDF_INDEX[album_id] = (best.stat().st_mtime, str(best.resolve()))
    return best


def _extract_title(pdf_path: Path, album_id: str) -> str:
    title = pdf_path.stem
    prefix = f"[JM{album_id}]"
    if title.startswith(prefix):
        title = title[len(prefix) :]
    return title or pdf_path.stem


def _to_relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(_repo_root().resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def _pdf_result(pdf_path: Path, album_id: str, *, cached: bool, elapsed: float = 0) -> Dict[str, Any]:
    rel = _to_relative(pdf_path)
    return {
        "ok": True,
        "cached": cached,
        "album_id": album_id,
        "title": _extract_title(pdf_path, album_id),
        "pdf_path": rel,
        "pdf_name": pdf_path.name,
        "file_url": f"/api/jmcomic/file?path={quote(rel, safe='')}",
        "size": pdf_path.stat().st_size,
        "elapsed": elapsed,
    }


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


def _cleanup_leftover(download_dir: Path, album_id: str) -> None:
    """下载/转 PDF 后清理残留原图目录，避免磁盘与库内缓存长期堆积。"""
    if not download_dir.exists():
        return
    markers = (album_id, f"[JM{album_id}]")
    image_ext = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
    for child in list(download_dir.iterdir()):
        name = child.name
        if not any(marker in name for marker in markers):
            continue
        try:
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            elif child.is_file() and child.suffix.lower() in image_ext:
                child.unlink(missing_ok=True)
        except OSError as exc:
            logger.debug("清理残留失败 %s: %s", child, exc)


def _download_sync(album_id: str) -> Dict[str, Any]:
    download_dir, pdf_dir = _storage_dirs()
    _log_memory(f"download:{album_id}:start")

    try:
        if config.get("reuse_existing_pdf", True):
            existing = _find_pdf(pdf_dir, album_id)
            if existing:
                logger.info("本子 %s 命中已有 PDF，跳过下载: %s", album_id, existing.name)
                return _pdf_result(existing, album_id, cached=True)

        from jmcomic import Feature, download_album

        option = _build_option(download_dir)
        delete_original = bool(config.get("delete_original", True))
        started = time.time()
        logger.info("本子 %s 开始下载", album_id)

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
        if not pdf_path:
            raise RuntimeError("PDF 生成失败，未在输出目录找到文件")

        elapsed = round(time.time() - started, 2)
        logger.info("本子 %s 下载完成，PDF=%s，耗时 %.2fs", album_id, pdf_path.name, elapsed)
        return _pdf_result(pdf_path, album_id, cached=False, elapsed=elapsed)
    finally:
        _cleanup_leftover(download_dir, album_id)
        gc.collect()
        _log_memory(f"download:{album_id}:done")


async def download_handler(request: Request):
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"无效 JSON: {exc}") from exc

    album_id = str(body.get("album_id", "")).strip()
    if not _ALBUM_ID_RE.fullmatch(album_id):
        raise HTTPException(status_code=400, detail="album_id 必须为纯数字")

    semaphore, executor = _ensure_download_pool()
    try:
        async with semaphore:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(executor, _download_sync, album_id)
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
    logger.info("JMComic 下载并发上限: %d", _max_concurrent())


async def shutdown_cleanup(_app):
    global _download_executor, _download_semaphore
    _PDF_INDEX.clear()
    if _download_executor is not None:
        _download_executor.shutdown(wait=False, cancel_futures=True)
        _download_executor = None
    _download_semaphore = None
    gc.collect()
    logger.info("JMComic 资源已释放")


default = {
    "name": "jmcomic-download",
    "description": "禁漫本子下载并导出 PDF",
    "priority": 200,
    "init": startup_init,
    "shutdown": shutdown_cleanup,
    "routes": [
        {"method": "POST", "path": "/api/jmcomic/download", "handler": download_handler},
        {"method": "GET", "path": "/api/jmcomic/file", "handler": file_handler},
    ],
}
