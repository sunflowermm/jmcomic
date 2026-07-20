"""JMComic 子服务插件：下载/PDF/命令/更新（配置见 default_config.yaml）。"""

from __future__ import annotations

import asyncio
import concurrent.futures
import gc
import logging
import re
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse

from core.plugin_kit import default_plugin_update, load_plugin_config

from ._download_compress import attach_download_compress
from ._pdf_compress import CompressOutcome, mark_pdf_ready, maybe_optimize_pdf

logger = logging.getLogger(__name__)

_PLUGIN_DIR = Path(__file__).resolve().parent
config = load_plugin_config(_PLUGIN_DIR, "jmcomic")

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
        rss = usage.ru_maxrss
        rss_mb = rss / 1024 if rss > 10_000_000 else rss / 1024
        logger.debug("[jmcomic] %s RSS≈%.1fMB", tag, rss_mb)
    except Exception:
        pass


def _resolve_dir(key: str, fallback: Path) -> Path:
    raw = config.get(key, "")
    path = Path(raw) if raw else fallback
    if not path.is_absolute():
        path = config.repo_root / path
    path.mkdir(parents=True, exist_ok=True)
    return path


def _storage_dirs() -> tuple[Path, Path]:
    base = config.repo_root / "data" / "jmcomic"
    download_dir = _resolve_dir("download_dir", base / "download")
    pdf_dir = _resolve_dir("pdf_dir", base / "pdf")
    return download_dir, pdf_dir


def _pdf_belongs_to_album(path: Path, album_id: str) -> bool:
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
        return path.resolve().relative_to(config.repo_root.resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def _reject(album_id: str, reason: str, *, detail: str = "") -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "ok": False,
        "album_id": album_id,
        "error": reason,
        "reason": reason,
    }
    if detail:
        payload["detail"] = detail
    return payload


def _pdf_result(
    pdf_path: Path,
    album_id: str,
    *,
    cached: bool,
    elapsed: float = 0,
    compress_outcome=None,
) -> Dict[str, Any]:
    rel = _to_relative(pdf_path)
    result: Dict[str, Any] = {
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
    if compress_outcome and compress_outcome.compressed:
        result["compressed"] = True
        result["size_before"] = compress_outcome.original_size
        result["compress_ratio"] = round(compress_outcome.ratio, 4)
    return result


def _compress_at_download_enabled() -> bool:
    return bool(config.get("pdf_compress.compress_at_download", True))


def _pdf_fallback_compress(pdf_path: Path, album_id: str) -> CompressOutcome:
    fallback_q = int(config.get("pdf_compress.fallback_jpeg_quality", 52) or 52)
    fallback_w = int(config.get("pdf_compress.fallback_max_image_width", 900) or 900)
    logger.info(
        "[jmcomic] PDF 仍超限，PDF 级强压 quality=%d width=%d: %s",
        fallback_q,
        fallback_w,
        pdf_path.name,
    )
    return maybe_optimize_pdf(
        pdf_path,
        config,
        cached=False,
        force=True,
        overrides={
            "jpeg_quality": fallback_q,
            "max_image_width": fallback_w,
            "min_savings_ratio": 0,
        },
    )


def _prepare_pdf_for_delivery(
    pdf_path: Path,
    album_id: str,
    *,
    cached: bool,
) -> Tuple[Optional[Dict[str, Any]], Optional[CompressOutcome]]:
    """首次下载：拉取时压图 → 合成 PDF → 必要时 PDF 级 fallback；命中缓存：直接交付。"""
    compress_outcome: Optional[CompressOutcome] = None

    if cached:
        size_error = _check_pdf_size_limit(pdf_path, album_id)
        return size_error, compress_outcome

    if _compress_at_download_enabled() and bool(config.get("pdf_compress.enabled", True)):
        mark_pdf_ready(pdf_path)
        size = pdf_path.stat().st_size
        compress_outcome = CompressOutcome(
            pdf_path,
            True,
            size,
            size,
            1.0,
            "at_download",
        )
    else:
        compress_outcome = maybe_optimize_pdf(pdf_path, config, cached=False)

    size_error = _check_pdf_size_limit(pdf_path, album_id)
    if size_error is None:
        return None, compress_outcome

    compress_outcome = _pdf_fallback_compress(pdf_path, album_id)
    return _check_pdf_size_limit(pdf_path, album_id), compress_outcome


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

    attach_download_compress(option, config)
    return option


def _estimate_page_count(album) -> int:
    page_count = int(getattr(album, "page_count", 0) or 0)
    if page_count > 0:
        return page_count

    episodes = album.episode_list or []
    if not episodes:
        return 0

    per_episode = max(1, int(config.get("limits.pages_per_episode_estimate", 12) or 12))
    return len(episodes) * per_episode


def _preflight_check(album_id: str, option) -> Optional[str]:
    if not config.get("limits.preflight", True):
        return None

    max_pages = int(config.get("limits.max_pages", 500) or 0)
    max_episodes = int(config.get("limits.max_episodes", 80) or 0)

    client = option.new_jm_client()
    try:
        album = client.get_album_detail(album_id)
    except Exception as exc:
        return f"无法获取本子信息，请检查 ID 或网络/代理配置: {exc}"

    episodes = len(album.episode_list or [])
    if max_episodes > 0 and episodes > max_episodes:
        return (
            f"章节数 {episodes} 超过上限 {max_episodes}，本子过大无法解析"
            f"（可在 data/jmcomic/config.yaml 调整 limits.max_episodes）"
        )

    estimated_pages = _estimate_page_count(album)
    if max_pages > 0 and estimated_pages > max_pages:
        title = getattr(album, "name", "") or album_id
        return (
            f"《{title}》预估页数约 {estimated_pages}，超过上限 {max_pages}，本子过大无法解析"
            f"（可在 data/jmcomic/config.yaml 调整 limits.max_pages）"
        )

    return None


def _check_pdf_size_limit(pdf_path: Path, album_id: str) -> Optional[Dict[str, Any]]:
    max_pdf_mb = float(config.get("limits.max_pdf_mb", 80) or 0)
    if max_pdf_mb <= 0:
        return None

    size_bytes = pdf_path.stat().st_size
    size_mb = size_bytes / (1024 * 1024)
    if size_mb <= max_pdf_mb:
        return None

    try:
        pdf_path.unlink(missing_ok=True)
    except OSError as exc:
        logger.warning("删除超限 PDF 失败 %s: %s", pdf_path, exc)

    return _reject(
        album_id,
        f"PDF 压缩后体积 {size_mb:.1f}MB 仍超过上限 {max_pdf_mb}MB，无法交付",
        detail="limits.max_pdf_mb",
    )


def _cleanup_leftover(download_dir: Path, album_id: str) -> None:
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
                size_error, compress_outcome = _prepare_pdf_for_delivery(
                    existing,
                    album_id,
                    cached=True,
                )
                if size_error:
                    return size_error
                return _pdf_result(
                    existing,
                    album_id,
                    cached=True,
                    compress_outcome=compress_outcome,
                )

        from jmcomic import Feature, download_album

        option = _build_option(download_dir)
        reject_reason = _preflight_check(album_id, option)
        if reject_reason:
            logger.info("本子 %s 预检拒绝: %s", album_id, reject_reason)
            return _reject(album_id, reject_reason)

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
            return _reject(album_id, "PDF 生成失败，未在输出目录找到文件")

        size_error, compress_outcome = _prepare_pdf_for_delivery(
            pdf_path,
            album_id,
            cached=False,
        )
        if size_error:
            return size_error

        elapsed = round(time.time() - started, 2)
        logger.info("本子 %s 下载完成，PDF=%s，耗时 %.2fs", album_id, pdf_path.name, elapsed)
        return _pdf_result(
            pdf_path,
            album_id,
            cached=False,
            elapsed=elapsed,
            compress_outcome=compress_outcome,
        )
    except MemoryError:
        logger.error("本子 %s 下载内存不足", album_id, exc_info=True)
        return _reject(album_id, "内存不足，本子过大无法解析，请调低 limits 或增大子服务内存")
    except Exception as exc:
        logger.error("本子 %s 下载异常: %s", album_id, exc, exc_info=True)
        return _reject(album_id, f"下载失败: {exc}")
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

    timeout_sec = int(config.get("limits.download_timeout_sec", 1800) or 1800)
    semaphore, executor = _ensure_download_pool()
    try:
        async with semaphore:
            loop = asyncio.get_running_loop()
            future = loop.run_in_executor(executor, _download_sync, album_id)
            if timeout_sec > 0:
                return await asyncio.wait_for(future, timeout=timeout_sec)
            return await future
    except asyncio.TimeoutError:
        logger.error("本子 %s 下载超时（>%ds）", album_id, timeout_sec)
        return _reject(
            album_id,
            f"下载超时（>{timeout_sec}秒），本子可能过大或网络过慢",
            detail="limits.download_timeout_sec",
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("JMComic 下载失败 album=%s: %s", album_id, exc, exc_info=True)
        return _reject(album_id, str(exc))


def _parse_blind_tags(raw: str) -> Tuple[str, List[str], List[str]]:
    """把用户/配置的 tag 文案规范成禁漫 search_tag 查询。

    格式（空格分隔）：
      全彩 中文          → +全彩 +中文（AND）
      +全彩 +中文 -CG    → 原样保留 +/- 
      单标签              → +单标签

    Returns:
        (search_query, include_tags, exclude_tags)
    """
    text = str(raw or "").strip()
    if not text:
        return "", [], []

    # 已是禁漫布尔串（含 +/-）时，按空白拆词解析
    tokens = [t for t in re.split(r"\s+", text) if t]
    include: List[str] = []
    exclude: List[str] = []
    parts: List[str] = []

    for tok in tokens:
        if tok.startswith("-") and len(tok) > 1:
            name = tok[1:].strip()
            if name:
                exclude.append(name)
                parts.append(f"-{name}")
        elif tok.startswith("+") and len(tok) > 1:
            name = tok[1:].strip()
            if name:
                include.append(name)
                parts.append(f"+{name}")
        else:
            name = tok.strip()
            if name:
                include.append(name)
                parts.append(f"+{name}")

    return " ".join(parts), include, exclude


def _norm_tag_name(name: str) -> str:
    s = str(name or "").strip()
    if not s:
        return ""
    try:
        from jmcomic import JmcomicText

        return str(JmcomicText.to_zh_cn(s) or s).casefold()
    except Exception:
        return s.casefold()


def _tag_token_hit(need: str, have: set[str]) -> bool:
    """精确或互相包含（ロリ / 萝莉 / ロリコン 等）。"""
    n = _norm_tag_name(need)
    if not n:
        return True
    if n in have:
        return True
    for h in have:
        if not h:
            continue
        if n in h or h in n:
            return True
    return False


def _tag_list_match(tag_list: Any, include: List[str], exclude: List[str], *, soft: bool = True) -> bool:
    """用 iter_id_title_tag 返回的标签列表做二次校验。"""
    raw = tag_list if isinstance(tag_list, (list, tuple, set)) else []
    have = {_norm_tag_name(t) for t in raw if t}
    have.discard("")
    for need in include:
        if soft:
            if not _tag_token_hit(need, have):
                return False
        else:
            n = _norm_tag_name(need)
            if n and n not in have:
                return False
    for ban in exclude:
        if soft:
            if _tag_token_hit(ban, have):
                return False
        else:
            b = _norm_tag_name(ban)
            if b and b in have:
                return False
    return True


def _blind_search_order_time(time_override: Optional[str] = None) -> Tuple[str, str]:
    """配置 order_by / time → jmcomic 常量字符串。"""
    from jmcomic import JmMagicConstants

    order_key = str(config.get("blind_box.order_by", "view") or "view").lower()
    order_map = {
        "latest": JmMagicConstants.ORDER_BY_LATEST,
        "mr": JmMagicConstants.ORDER_BY_LATEST,
        "view": JmMagicConstants.ORDER_BY_VIEW,
        "mv": JmMagicConstants.ORDER_BY_VIEW,
        "like": JmMagicConstants.ORDER_BY_LIKE,
        "tf": JmMagicConstants.ORDER_BY_LIKE,
        "score": JmMagicConstants.ORDER_BY_SCORE,
        "tr": JmMagicConstants.ORDER_BY_SCORE,
    }
    order_by = order_map.get(order_key, JmMagicConstants.ORDER_BY_VIEW)

    time_key = str(
        time_override
        if time_override is not None
        else (config.get("blind_box.time", "all") or "all")
    ).lower()
    time_map = {
        "all": JmMagicConstants.TIME_ALL,
        "a": JmMagicConstants.TIME_ALL,
        "today": JmMagicConstants.TIME_TODAY,
        "t": JmMagicConstants.TIME_TODAY,
        "week": JmMagicConstants.TIME_WEEK,
        "w": JmMagicConstants.TIME_WEEK,
        "month": JmMagicConstants.TIME_MONTH,
        "m": JmMagicConstants.TIME_MONTH,
    }
    time_v = time_map.get(time_key, JmMagicConstants.TIME_ALL)
    return order_by, time_v


def _collect_tag_album_ids(
    client: Any,
    search_query: str,
    include: List[str],
    exclude: List[str],
    *,
    time_override: Optional[str] = None,
    require_include: bool = True,
) -> List[str]:
    """search_tag + 多页；可选标签列表校验。"""
    category = str(config.get("blind_box.category", "0") or "0")
    try:
        start_page = max(1, int(config.get("blind_box.page", 1) or 1))
    except (TypeError, ValueError):
        start_page = 1
    try:
        page_count = max(1, min(int(config.get("blind_box.pages", 2) or 2), 5))
    except (TypeError, ValueError):
        page_count = 2

    order_by, time_v = _blind_search_order_time(time_override)
    ids: List[str] = []
    seen: set[str] = set()

    for offset in range(page_count):
        page_no = start_page + offset
        page_obj = client.search_tag(
            search_query,
            page=page_no,
            order_by=order_by,
            time=time_v,
            category=category,
        )
        raw_n = 0
        matched = 0
        for aid, _title, tag_list in page_obj.iter_id_title_tag():
            album_id = str(aid)
            if not _ALBUM_ID_RE.fullmatch(album_id) or album_id in seen:
                continue
            raw_n += 1
            # 排除标签始终校验；包含标签可按 require_include 放宽（信任 search_tag）
            check_include = include if require_include else []
            if check_include or exclude:
                if not _tag_list_match(tag_list, check_include, exclude, soft=True):
                    continue
            seen.add(album_id)
            ids.append(album_id)
            matched += 1
        logger.info(
            "[盲盒] search_tag page=%s query=%r raw=%s hit=%s pool=%s order=%s time=%s strict_include=%s",
            page_no,
            search_query,
            raw_n,
            matched,
            len(ids),
            order_by,
            time_v,
            require_include,
        )
        if raw_n == 0 and offset > 0:
            break

    return ids


def _pick_blind_album_id(tag: str = "") -> Tuple[str, str, str]:
    """抽一个车牌号。优先级：seed_ids → tag 搜索 → 日/周/月榜。

    Returns:
        (album_id, source, tag_query)  source 为 seed | tag | ranking
    """
    import random

    seed_raw = config.get("blind_box.seed_ids") or []
    seed_ids = [
        str(x).strip()
        for x in (seed_raw if isinstance(seed_raw, list) else [])
        if _ALBUM_ID_RE.fullmatch(str(x).strip())
    ]
    if seed_ids:
        return random.choice(seed_ids), "seed", ""

    raw_tag = (tag or config.get("blind_box.tag") or "").strip()
    search_query, include, exclude = _parse_blind_tags(raw_tag)

    category = str(config.get("blind_box.category", "0") or "0")
    try:
        page = max(1, int(config.get("blind_box.page", 1) or 1))
    except (TypeError, ValueError):
        page = 1

    download_dir, _ = _storage_dirs()
    option = _build_option(download_dir)
    client = option.new_jm_client()

    if search_query:
        logger.info("[盲盒] 按 tag 抽号 query=%r include=%s exclude=%s", search_query, include, exclude)
        # 1) 配置时间窗 + 标签软校验
        ids = _collect_tag_album_ids(client, search_query, include, exclude, require_include=True)
        # 2) 仍空：信任 search_tag 结果，只保留 -排除
        if not ids:
            logger.info("[盲盒] 标签软校验无命中，回退为搜索结果（仅排除校验）")
            ids = _collect_tag_album_ids(client, search_query, include, exclude, require_include=False)
        # 3) 仍空且当前不是 all：放宽时间窗再试
        cfg_time = str(config.get("blind_box.time", "all") or "all").lower()
        if not ids and cfg_time not in ("all", "a"):
            logger.info("[盲盒] 时间窗 %s 无结果，回退 time=all", cfg_time)
            ids = _collect_tag_album_ids(
                client, search_query, include, exclude, time_override="all", require_include=False
            )
        if not ids:
            raise ValueError(
                f"标签「{raw_tag}」无可用本子。可换中文标签、去掉 -排除，或检查代理/网络"
            )
        return random.choice(ids), "tag", search_query

    ranking = str(config.get("blind_box.ranking", "day") or "day").lower()
    if ranking == "week":
        page_obj = client.week_ranking(page=page, category=category)
    elif ranking == "month":
        page_obj = client.month_ranking(page=page, category=category)
    else:
        page_obj = client.day_ranking(page=page, category=category)

    ids = [str(aid) for aid, _title in page_obj.iter_id_title() if _ALBUM_ID_RE.fullmatch(str(aid))]
    if not ids:
        raise ValueError("排行榜无可用本子，请检查网络或配置 blind_box.seed_ids / tag")
    return random.choice(ids), "ranking", ""


def _blind_box_sync(tag: str = "") -> Dict[str, Any]:
    try:
        album_id, pick_source, tag_query = _pick_blind_album_id(tag)
    except Exception as exc:
        logger.error("[盲盒] 抽号失败: %s", exc, exc_info=True)
        return {"ok": False, "error": f"抽号失败: {exc}", "album_id": ""}

    result = _download_sync(album_id)
    if isinstance(result, dict):
        result["source"] = "blind_box"
        result["pick_source"] = pick_source
        raw_tag = (tag or config.get("blind_box.tag") or "").strip()
        if raw_tag:
            result["tag"] = raw_tag
        if tag_query:
            result["tag_query"] = tag_query
    return result


async def blind_box_handler(request: Request):
    # 固定开 1 本；body 可选 { "tag": "全彩 中文" } 或 "+全彩 +中文 -CG"
    body: Dict[str, Any] = {}
    try:
        raw = await request.json()
        if isinstance(raw, dict):
            body = raw
    except Exception:
        pass

    tag = str(body.get("tag") or body.get("tags") or "").strip()
    # 整串纯数字拒绝（避免和旧「份数」混淆）；多 tag 空格串允许
    if tag and _ALBUM_ID_RE.fullmatch(tag):
        raise HTTPException(status_code=400, detail="tag 不能为纯数字；多标签请空格分隔，例：全彩 中文")

    timeout_sec = int(config.get("limits.download_timeout_sec", 1800) or 1800)
    semaphore, executor = _ensure_download_pool()
    try:
        async with semaphore:
            loop = asyncio.get_running_loop()
            future = loop.run_in_executor(executor, _blind_box_sync, tag)
            if timeout_sec > 0:
                return await asyncio.wait_for(future, timeout=timeout_sec)
            return await future
    except asyncio.TimeoutError:
        return {
            "ok": False,
            "error": f"开盲盒超时（>{timeout_sec}秒）",
            "album_id": "",
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[盲盒] 失败: %s", exc, exc_info=True)
        return {"ok": False, "error": str(exc), "album_id": ""}


def _safe_pdf_path(raw: str) -> Path:
    if not raw or ".." in raw.replace("\\", "/"):
        raise HTTPException(status_code=400, detail="非法文件路径")

    _, pdf_dir = _storage_dirs()
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = config.repo_root / raw

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


async def cmd_status(_request, _args: List[str]):
    return {
        "service": "jmcomic",
        "config": str(config.runtime_file),
        "download_dir": config.get("download_dir", "data/jmcomic/download"),
        "pdf_dir": config.get("pdf_dir", "data/jmcomic/pdf"),
        "max_concurrent": config.get("max_concurrent_downloads", 1),
        "limits": {
            "max_pages": config.get("limits.max_pages"),
            "max_episodes": config.get("limits.max_episodes"),
            "max_pdf_mb": config.get("limits.max_pdf_mb"),
            "download_timeout_sec": config.get("limits.download_timeout_sec"),
        },
    }


async def jmcomic_update(_request, _args: List[str]):
    return await default_plugin_update(
        _PLUGIN_DIR,
        pip=True,
        git=(_PLUGIN_DIR / ".git").exists(),
    )


async def startup_init(_app):
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
    "name": "jmcomic",
    "description": "禁漫本子下载并导出 PDF",
    "group": "jmcomic",
    "plugin_dir": str(_PLUGIN_DIR),
    "priority": 200,
    "init": startup_init,
    "shutdown": shutdown_cleanup,
    "commands": {"status": cmd_status},
    "on_update": jmcomic_update,
    "routes": [
        {"method": "POST", "path": "/api/jmcomic/download", "handler": download_handler},
        {"method": "POST", "path": "/api/jmcomic/blind-box", "handler": blind_box_handler},
        {"method": "GET", "path": "/api/jmcomic/file", "handler": file_handler},
    ],
}
