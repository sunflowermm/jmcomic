"""PDF 体积优化：重编码内嵌图 + 可选限宽，面向 QQ 群文件/直链传输。"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, Optional, Protocol

logger = logging.getLogger(__name__)

MARKER_SUFFIX = ".jmcompress"
MARKER_VERSION = 1


class ConfigReader(Protocol):
    def get(self, key: str, default: Any = None) -> Any: ...


@dataclass
class CompressOutcome:
    path: Path
    compressed: bool
    original_size: int
    final_size: int
    ratio: float
    skipped_reason: str = ""


def load_compress_settings(config: ConfigReader) -> Dict[str, Any]:
    quality = int(config.get("pdf_compress.jpeg_quality", 84) or 84)
    return {
        "enabled": bool(config.get("pdf_compress.enabled", True)),
        "jpeg_quality": max(50, min(95, quality)),
        "max_image_width": max(0, int(config.get("pdf_compress.max_image_width", 1800) or 0)),
        "min_bytes": max(0, int(config.get("pdf_compress.min_bytes", 262144) or 262144)),
        "min_savings_ratio": max(
            0.0,
            min(0.95, float(config.get("pdf_compress.min_savings_ratio", 0.05) or 0.05)),
        ),
        "optimize_cached": bool(config.get("pdf_compress.optimize_cached", True)),
    }


def _marker_path(pdf_path: Path) -> Path:
    return pdf_path.with_suffix(pdf_path.suffix + MARKER_SUFFIX)


def _read_marker(pdf_path: Path) -> Optional[Dict[str, Any]]:
    marker = _marker_path(pdf_path)
    if not marker.is_file():
        return None
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
        if data.get("v") == MARKER_VERSION:
            return data
    except Exception:
        pass
    return None


def _write_marker(pdf_path: Path, original_size: int, final_size: int) -> None:
    payload = {
        "v": MARKER_VERSION,
        "original_size": original_size,
        "final_size": final_size,
    }
    _marker_path(pdf_path).write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )


def _recompress_image(
    image_bytes: bytes,
    *,
    jpeg_quality: int,
    max_width: int,
) -> Optional[bytes]:
    from PIL import Image

    try:
        img = Image.open(BytesIO(image_bytes))
    except Exception:
        return None

    width, height = img.size
    if max_width > 0 and max(width, height) > max_width:
        scale = max_width / max(width, height)
        img = img.resize(
            (max(1, int(width * scale)), max(1, int(height * scale))),
            Image.Resampling.LANCZOS,
        )

    if img.mode in ("RGBA", "LA", "P"):
        background = Image.new("RGB", img.size, (255, 255, 255))
        if img.mode == "P":
            img = img.convert("RGBA")
        if img.mode in ("RGBA", "LA"):
            background.paste(img, mask=img.split()[-1])
        else:
            background.paste(img)
        img = background
    elif img.mode != "RGB":
        img = img.convert("RGB")

    out = BytesIO()
    img.save(out, format="JPEG", quality=jpeg_quality, optimize=True, progressive=True)
    return out.getvalue()


def _compress_with_pymupdf(src: Path, dst: Path, settings: Dict[str, Any]) -> int:
    import fitz

    doc = fitz.open(str(src))
    updated = 0
    try:
        for page in doc:
            for img_info in page.get_images(full=True):
                xref = img_info[0]
                try:
                    extracted = doc.extract_image(xref)
                except Exception:
                    continue
                if not extracted:
                    continue

                original = extracted["image"]
                recompressed = _recompress_image(
                    original,
                    jpeg_quality=settings["jpeg_quality"],
                    max_width=settings["max_image_width"],
                )
                if not recompressed or len(recompressed) >= len(original):
                    continue

                try:
                    page.replace_image(xref, stream=recompressed)
                    updated += 1
                except Exception:
                    try:
                        doc.update_stream(xref, recompressed)
                        updated += 1
                    except Exception:
                        continue

        doc.save(
            str(dst),
            garbage=4,
            deflate=True,
            clean=True,
            pretty=False,
        )
    finally:
        doc.close()

    return updated


def optimize_pdf(
    pdf_path: Path,
    config: ConfigReader,
    *,
    force: bool = False,
) -> CompressOutcome:
    """压缩 PDF；已优化且 force=False 时跳过。"""
    settings = load_compress_settings(config)
    original_size = pdf_path.stat().st_size

    if not settings["enabled"]:
        return CompressOutcome(
            pdf_path, False, original_size, original_size, 1.0, "disabled"
        )

    if original_size < settings["min_bytes"]:
        return CompressOutcome(
            pdf_path, False, original_size, original_size, 1.0, "too_small"
        )

    if not force and _read_marker(pdf_path):
        return CompressOutcome(
            pdf_path, False, original_size, original_size, 1.0, "already_optimized"
        )

    tmp_path: Optional[Path] = None
    try:
        fd, tmp_name = tempfile.mkstemp(suffix=".pdf", dir=str(pdf_path.parent))
        os.close(fd)
        tmp_path = Path(tmp_name)

        updated = _compress_with_pymupdf(pdf_path, tmp_path, settings)
        final_size = tmp_path.stat().st_size
        min_target = int(original_size * (1 - settings["min_savings_ratio"]))

        if final_size >= min_target:
            logger.info(
                "[jmcomic] PDF 压缩收益不足 %s: %s → %s (images=%d)",
                pdf_path.name,
                _fmt_mb(original_size),
                _fmt_mb(final_size),
                updated,
            )
            return CompressOutcome(
                pdf_path,
                False,
                original_size,
                original_size,
                1.0,
                "insufficient_savings",
            )

        os.replace(str(tmp_path), str(pdf_path))
        tmp_path = None
        ratio = final_size / original_size if original_size else 1.0
        _write_marker(pdf_path, original_size, final_size)
        logger.info(
            "[jmcomic] PDF 已压缩 %s: %s → %s (×%.2f, images=%d)",
            pdf_path.name,
            _fmt_mb(original_size),
            _fmt_mb(final_size),
            original_size / final_size if final_size else 1.0,
            updated,
        )
        return CompressOutcome(
            pdf_path, True, original_size, final_size, ratio, ""
        )
    except ImportError:
        logger.warning("[jmcomic] 未安装 pymupdf，跳过 PDF 压缩（uv pip install pymupdf）")
        return CompressOutcome(
            pdf_path, False, original_size, original_size, 1.0, "missing_pymupdf"
        )
    except Exception as exc:
        logger.warning("[jmcomic] PDF 压缩失败 %s: %s", pdf_path.name, exc)
        return CompressOutcome(
            pdf_path, False, original_size, original_size, 1.0, "error"
        )
    finally:
        if tmp_path and tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


def maybe_optimize_pdf(
    pdf_path: Path,
    config: ConfigReader,
    *,
    cached: bool,
) -> CompressOutcome:
    settings = load_compress_settings(config)
    if cached and not settings["optimize_cached"]:
        return CompressOutcome(
            pdf_path,
            False,
            pdf_path.stat().st_size,
            pdf_path.stat().st_size,
            1.0,
            "cached_skip",
        )
    return optimize_pdf(pdf_path, config)


def _fmt_mb(num_bytes: int) -> str:
    return f"{num_bytes / (1024 * 1024):.2f}MB"
