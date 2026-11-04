"""
Where camera media lives: status-change photos, saved snapshots and recordings.

Files are always written to backend/captures/ first. With S3_BUCKET set, each one is then
uploaded to S3 in the background and the local copy is deleted, so the server's disk only
holds files that are still waiting to upload (a failed upload is retried every minute).
Without S3_BUCKET everything simply stays on disk. Credentials come from the usual AWS
places; on EC2 that is the instance role, so no keys go in .env.

    S3_BUCKET   bucket name (empty = keep files on this server)
    S3_PREFIX   optional folder inside the bucket, e.g. "trashwatch"
    AWS_REGION  bucket region, e.g. ap-southeast-1
"""

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse, RedirectResponse

# TRASHWATCH_MEDIA lets a throwaway test backend use its own folder
MEDIA_DIR = Path(os.getenv("TRASHWATCH_MEDIA") or Path(__file__).resolve().parent / "captures")
S3_BUCKET = os.getenv("S3_BUCKET", "").strip()
S3_PREFIX = os.getenv("S3_PREFIX", "").strip().strip("/")
AWS_REGION = os.getenv("AWS_REGION", "").strip()

# kind -> content type. "photos" (status-change frames) sit directly in MEDIA_DIR, the rest in a subfolder.
KINDS = {"photos": "image/jpeg", "snapshots": "image/jpeg", "recordings": "video/mp4"}
SUFFIXES = {".jpg", ".mp4"}
UPLOAD_AFTER_AGE = 120   # seconds a file must be untouched before the retry sweep uploads it
LINK_SECONDS = 600       # how long a presigned S3 link works

_client_obj = None
_client_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="s3-upload")
_queued: set[tuple[str, str]] = set()
_queued_lock = threading.Lock()


def enabled() -> bool:
    return bool(S3_BUCKET)


def folder(kind: str) -> Path:
    return MEDIA_DIR if kind == "photos" else MEDIA_DIR / kind


def local_path(kind: str, name: str) -> Path:
    return folder(kind) / name


def key(kind: str, name: str) -> str:
    return "/".join(p for p in (S3_PREFIX, kind, name) if p)


def _client():
    global _client_obj
    with _client_lock:
        if _client_obj is None:
            import boto3  # imported here so the server runs without boto3 when S3 is off
            from botocore.config import Config

            _client_obj = boto3.client("s3", region_name=AWS_REGION or None, config=Config(signature_version="s3v4"))
        return _client_obj


def _upload(kind: str, name: str):
    try:
        path = local_path(kind, name)
        if path.exists():
            _client().upload_file(str(path), S3_BUCKET, key(kind, name), ExtraArgs={"ContentType": KINDS[kind]})
            path.unlink(missing_ok=True)  # uploaded: free the server's disk
    except Exception as e:
        print(f"[storage] upload of {kind}/{name} failed, will retry: {e!r}")
    finally:
        with _queued_lock:
            _queued.discard((kind, name))


def upload_later(kind: str, name: str):
    """Send a finished local file to S3 in the background, then delete it from disk."""
    if not enabled():
        return
    with _queued_lock:
        if (kind, name) in _queued:
            return
        _queued.add((kind, name))
    _pool.submit(_upload, kind, name)


def sync_pending(busy: set[tuple[str, str]] = frozenset()) -> int:
    """Queue every old local file that isn't uploaded yet (failed earlier, or left by a restart)."""
    if not enabled():
        return 0
    cutoff = time.time() - UPLOAD_AFTER_AGE
    n = 0
    for kind in KINDS:
        d = folder(kind)
        if not d.is_dir():
            continue
        for f in d.iterdir():
            if f.is_file() and f.suffix in SUFFIXES and (kind, f.name) not in busy and f.stat().st_mtime < cutoff:
                upload_later(kind, f.name)
                n += 1
    return n


def _remote_exists_url(kind: str, name: str, download_as: str | None) -> str | None:
    c = _client()
    try:
        c.head_object(Bucket=S3_BUCKET, Key=key(kind, name))
    except Exception:
        return None
    params = {"Bucket": S3_BUCKET, "Key": key(kind, name), "ResponseContentType": KINDS[kind]}
    if download_as:
        params["ResponseContentDisposition"] = f'attachment; filename="{download_as}"'
    return c.generate_presigned_url("get_object", Params=params, ExpiresIn=LINK_SECONDS)


def serve(kind: str, name: str, download_as: str | None = None):
    """The local file, or a redirect to a short-lived S3 link. 404 when it is in neither place."""
    path = local_path(kind, name)
    if name and path.exists():
        return FileResponse(path, media_type=KINDS[kind], filename=download_as)
    if name and enabled():
        url = _remote_exists_url(kind, name, download_as)
        if url:
            return RedirectResponse(url, status_code=307, headers={"Cache-Control": "no-store"})
    raise HTTPException(404, "File not found")


def delete(kind: str, name: str) -> bool:
    """Remove the local copy and the S3 object. False when S3 could not be reached (try again later)."""
    if not name:
        return True
    local_path(kind, name).unlink(missing_ok=True)
    if enabled():
        try:
            _client().delete_object(Bucket=S3_BUCKET, Key=key(kind, name))
        except Exception as e:
            print(f"[storage] could not delete {kind}/{name} from S3: {e!r}")
            return False
    return True
