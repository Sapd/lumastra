# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Lazy CLAP text encoder: keep the GPT-2 caption encoder out of RAM until a text query
needs it.

CLAP 2023's caption encoder holds 505 MB of the model's 652 MB of fp32 weights
(measured 2026-10-15) and serves only /embed-text (music text search). Audio embedding,
analysis, clustering and the map never touch it. SONIC_TEXT_ENCODER chooses:

  warm  keep it loaded (the old behaviour)
  lazy  after model load, save its exact tensors to the model cache volume, free them,
        load them back on the first /embed-text, and free them again after
        SONIC_TEXT_ENCODER_IDLE_SEC (default 900) without a text query
  auto  (default) warm when the container memory limit is at least 8 GiB, else lazy

Lazy mode lowers the sidecar's resident memory while no one searches; the memory gate
still keeps room for the encoder (server.py measures its baseline with it loaded), so a
search that loads it can never push admitted jobs over the limit.

The snapshot holds every parameter and buffer of the module as loaded in this process
(the GPT-2 base from the Hugging Face cache plus CLAP's fine-tuned weights), so a reload
gives bit-identical text embeddings (measured on preprod). It is a safetensors file (no
pickle: torch.load(weights_only=True) is not a safe boundary in this image's torch 2.3,
CVE-2025-32434), rewritten on every start under a per-process name, and its sha256 is
kept in memory and checked before every reload. If it cannot be written (read-only
cache), the encoder simply stays warm.

All methods except prepare() must run on the server's single text-lane thread.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
import uuid

log = logging.getLogger("sonic-server")

AUTO_WARM_MIN_LIMIT_MB = 8192
DEFAULT_IDLE_SEC = 900
MIN_IDLE_SEC = 60


def resolve_mode(raw: str | None, limit_mb: int) -> str:
    mode = (raw or "auto").strip().lower()
    if mode not in ("warm", "lazy", "auto"):
        log.warning("SONIC_TEXT_ENCODER=%r is not warm|lazy|auto; using auto", raw)
        mode = "auto"
    if mode == "auto":
        return "warm" if limit_mb >= AUTO_WARM_MIN_LIMIT_MB else "lazy"
    return mode


def idle_seconds() -> int:
    raw = os.environ.get("SONIC_TEXT_ENCODER_IDLE_SEC", "").strip()
    try:
        val = int(raw) if raw else DEFAULT_IDLE_SEC
    except ValueError:
        val = DEFAULT_IDLE_SEC
    return max(MIN_IDLE_SEC, val)


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class TextEncoderManager:
    """state: 'warm' (never offloaded), 'loaded' (lazy, in RAM) or 'unloaded'."""

    def __init__(self, model, mode: str, snapshot_dir: str, idle_sec: int):
        self._model = model
        self.mode = mode
        self.idle_sec = idle_sec
        self.state = "warm"
        self.size_mb = 0
        self.last_used = time.monotonic()
        self._snapshot_dir = snapshot_dir
        self._snapshot_path = ""
        self._snapshot_sha256 = ""
        self._shapes: dict[str, tuple] = {}

    def _module(self):
        return self._model.clap.caption_encoder

    def _tensors(self):
        mod = self._module()
        out = {f"p:{n}": t for n, t in mod.named_parameters()}
        out.update({f"b:{n}": t for n, t in mod.named_buffers()})
        return out

    def prepare(self) -> None:
        """At startup, after model load: snapshot and offload in lazy mode."""
        import torch

        tensors = self._tensors()
        self.size_mb = sum(t.numel() * t.element_size() for t in tensors.values()) // (1024 * 1024)
        if self.mode != "lazy":
            return
        if getattr(self._model, "use_cuda", False) and torch.cuda.is_available():
            log.info("Text encoder stays loaded: lazy loading is for CPU memory, the model is on CUDA")
            self.mode = "warm"
            return
        try:
            from safetensors.torch import save_file

            os.makedirs(self._snapshot_dir, exist_ok=True)
            self._remove_stale_snapshots()
            path = os.path.join(self._snapshot_dir, f"text-encoder-{os.getpid()}-{uuid.uuid4().hex}.safetensors")
            save_file({k: t.detach().contiguous() for k, t in tensors.items()}, path)
            os.chmod(path, 0o600)
            self._snapshot_path = path
            self._snapshot_sha256 = _sha256(path)
            self._shapes = {k: (tuple(t.shape), t.dtype) for k, t in tensors.items()}
        except Exception as exc:  # noqa: BLE001
            log.warning("Text encoder stays loaded: cannot write its snapshot (%s)", exc)
            self.mode = "warm"
            return
        self._offload()
        log.info("Text encoder offloaded (%d MB); loads on the first text query", self.size_mb)

    def _remove_stale_snapshots(self) -> None:
        """Snapshots of earlier processes (restarts) are never read again. Only ones
        older than an hour: a second sidecar sharing the volume may still use its own."""
        now = time.time()
        for name in os.listdir(self._snapshot_dir):
            if not name.startswith("text-encoder-"):
                continue
            path = os.path.join(self._snapshot_dir, name)
            try:
                if now - os.path.getmtime(path) > 3600:
                    os.remove(path)
            except OSError:
                pass

    def _offload(self) -> None:
        self._module().to("meta")
        self.state = "unloaded"

    def ensure_loaded(self) -> bool:
        """Load it back if needed. Returns True when this call loaded it."""
        self.last_used = time.monotonic()
        if self.state != "unloaded":
            return False
        import torch
        from safetensors.torch import load_file

        t0 = time.monotonic()
        if _sha256(self._snapshot_path) != self._snapshot_sha256:
            raise RuntimeError("text encoder snapshot changed on disk since it was written; refusing it")
        snap = load_file(self._snapshot_path, device="cpu")
        if {k: (tuple(t.shape), t.dtype) for k, t in snap.items()} != self._shapes:
            raise RuntimeError("text encoder snapshot does not match the loaded module")
        mod = self._module()
        try:
            mod.to_empty(device="cpu")
            with torch.no_grad():
                for key, src in snap.items():
                    kind, name = key.split(":", 1)
                    dst = mod.get_parameter(name) if kind == "p" else mod.get_buffer(name)
                    dst.copy_(src)
        except Exception:
            self._offload()  # never leave half-restored weights in use
            raise
        del snap
        mod.eval()
        self.state = "loaded"
        log.info("Text encoder loaded in %.1fs", time.monotonic() - t0)
        return True

    def unload_if_idle(self) -> bool:
        """Offload after idle_sec without a query. Returns True when it offloaded."""
        if self.state != "loaded" or time.monotonic() - self.last_used < self.idle_sec:
            return False
        self._offload()
        log.info("Text encoder offloaded after %ds idle", self.idle_sec)
        return True
