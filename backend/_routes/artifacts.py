"""Route handlers for /api/artifacts/* — file transfer for non-local clients.

The rest of the API speaks in absolute paths in *this* machine's filesystem: a generation
returns `video_path`, and image/audio conditioning is passed as `imagePath`/`audioPath`.
That is unambiguous when the client and the backend share a filesystem, which is the only
arrangement the desktop app had. A client on another machine can neither read what it is
told about nor name a file it wants used, so these three endpoints move the bytes.

Both directions are confined to directories this backend owns — outputs and a dedicated
uploads directory. There is deliberately no general file-read endpoint here: the auth token
gates *who* may call, and these bounds gate *what* they can reach, so a leaked token cannot
be turned into a read of the whole disk.
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, UploadFile
from fastapi.responses import FileResponse

from _routes._errors import HTTPError
from api_types import ArtifactCapabilitiesResponse, ArtifactUploadResponse
# `state` before `app_handler`, as in every other route module: app_handler and state import
# each other, and taking app_handler first leaves it half-initialised.
from state import get_state_service
from app_handler import AppHandler

router = APIRouter(prefix="/api/artifacts", tags=["artifacts"])

# Filenames only; the client never names a directory.
_MAX_UPLOAD_BYTES = 512 * 1024 * 1024


def _outputs_dir(handler: AppHandler) -> Path:
    return Path(handler.config.outputs_dir).resolve()


def _uploads_dir(handler: AppHandler) -> Path:
    uploads = Path(handler.config.app_data_dir).resolve() / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    return uploads


def _readable_roots(handler: AppHandler) -> list[Path]:
    """Directories a client may read from: what we generated, and what it uploaded."""
    return [_outputs_dir(handler), _uploads_dir(handler)]


def _resolve_readable(handler: AppHandler, requested: str) -> Path:
    """Resolve a client-supplied path, or refuse.

    `Path.resolve()` collapses `..` and follows symlinks *before* the prefix check, so
    neither traversal nor a symlink planted in outputs/ can escape the roots.
    """
    if not requested.strip():
        raise HTTPError(status_code=400, code="INVALID_ARTIFACT_PATH", detail="path is required")

    candidate = Path(requested).expanduser()
    if not candidate.is_absolute():
        # A relative path is interpreted against outputs/ so clients can pass a bare
        # filename, which is all they need for a generation result.
        candidate = _outputs_dir(handler) / candidate

    resolved = candidate.resolve()
    roots = _readable_roots(handler)
    if not any(resolved == root or root in resolved.parents for root in roots):
        raise HTTPError(
            status_code=403,
            code="ARTIFACT_OUT_OF_BOUNDS",
            detail="Path is outside this backend's artifact directories",
        )
    if not resolved.is_file():
        raise HTTPError(status_code=404, code="ARTIFACT_NOT_FOUND", detail=f"No such artifact: {resolved.name}")
    return resolved


@router.get("/capabilities", response_model=ArtifactCapabilitiesResponse)
def route_artifact_capabilities(
    handler: AppHandler = Depends(get_state_service),
) -> ArtifactCapabilitiesResponse:
    """GET /api/artifacts/capabilities — presence of this route is the capability signal.

    A client probes this to decide whether a remote provider can return usable results at
    all; an older backend answers 404 and the client reports artifact transfer unsupported.
    """
    return ArtifactCapabilitiesResponse(
        download=True,
        upload=True,
        outputs_dir=str(_outputs_dir(handler)),
        uploads_dir=str(_uploads_dir(handler)),
        max_upload_bytes=_MAX_UPLOAD_BYTES,
    )


@router.get("/download")
def route_artifact_download(
    path: str,
    handler: AppHandler = Depends(get_state_service),
) -> FileResponse:
    """GET /api/artifacts/download?path=… — stream one generated file back to the client."""
    resolved = _resolve_readable(handler, path)
    return FileResponse(str(resolved), filename=resolved.name)


@router.post("/upload", response_model=ArtifactUploadResponse)
async def route_artifact_upload(
    file: UploadFile,
    handler: AppHandler = Depends(get_state_service),
) -> ArtifactUploadResponse:
    """POST /api/artifacts/upload — accept a conditioning input and return its local path.

    The returned path is what the client should then pass as `imagePath`/`audioPath`.
    """
    original = Path(file.filename or "upload").name
    if not original or original in {".", ".."}:
        raise HTTPError(status_code=400, code="INVALID_ARTIFACT_NAME", detail="Uploaded file needs a name")

    # Prefix rather than replace the name: it keeps the extension (pipelines dispatch on it)
    # and keeps concurrent uploads of the same filename from overwriting each other.
    destination = _uploads_dir(handler) / f"{uuid.uuid4().hex}-{original}"

    written = 0
    try:
        with destination.open("wb") as sink:
            while chunk := await file.read(8 * 1024 * 1024):
                written += len(chunk)
                if written > _MAX_UPLOAD_BYTES:
                    raise HTTPError(
                        status_code=413,
                        code="ARTIFACT_TOO_LARGE",
                        detail=f"Upload exceeds {_MAX_UPLOAD_BYTES // (1024 * 1024)}MB",
                    )
                sink.write(chunk)
    except BaseException:
        # Never leave a partial upload behind for a later generation to pick up.
        destination.unlink(missing_ok=True)
        raise
    finally:
        await file.close()

    return ArtifactUploadResponse(path=str(destination), size_bytes=written)


def clear_uploads(handler: AppHandler) -> int:
    """Remove every staged upload. Returns how many were removed. Used by tests."""
    uploads = _uploads_dir(handler)
    removed = 0
    for entry in uploads.iterdir():
        if entry.is_file():
            entry.unlink()
            removed += 1
        elif entry.is_dir():
            shutil.rmtree(entry)
            removed += 1
    return removed
