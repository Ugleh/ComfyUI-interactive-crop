import os
import uuid
import threading
import json
import time
from typing import Dict, Tuple, Any

import torch
import numpy as np
from PIL import Image

import folder_paths
from aiohttp import web
from server import PromptServer
import comfy.model_management

TIMEOUT_SECONDS = 4 * 60  # 4 minutes

_LOCK = threading.Lock()
_WAITERS: Dict[Tuple[str, str], Dict[str, Any]] = {}


def _extract_workflow(extra_pnginfo: Any) -> Any:
    if not isinstance(extra_pnginfo, dict):
        return None

    wf = extra_pnginfo.get("workflow") or extra_pnginfo.get("Workflow")
    if wf is None:
        return None

    if isinstance(wf, str):
        try:
            return json.loads(wf)
        except Exception:
            return None

    if isinstance(wf, dict):
        return wf

    return None


def _is_node_bypassed(node_id: str, *, extra_pnginfo: Any = None, prompt: Any = None) -> bool:
    node_id = str(node_id)

    wf = _extract_workflow(extra_pnginfo)
    nodes = None
    if isinstance(wf, dict):
        nodes = wf.get("nodes")
    if isinstance(nodes, list):
        for n in nodes:
            if not isinstance(n, dict):
                continue
            if str(n.get("id")) != node_id:
                continue

            # ComfyUI/LiteGraph modes vary by version; commonly:
            # - 0: enabled
            # - 2: never/muted
            # - 4: bypass
            mode = n.get("mode", None)
            try:
                mode_i = int(mode)
            except Exception:
                mode_i = None

            if n.get("bypassed") is True or n.get("bypass") is True:
                return True
            if mode_i in (2, 4):
                return True

            return False

    # Some ComfyUI builds only include prompt graph here (no workflow modes).
    # If we can't prove bypass, assume not bypassed.
    _ = prompt
    return False


def _to_pil(img_tensor: torch.Tensor) -> Image.Image:
    if img_tensor.dim() != 4:
        raise ValueError(f"Expected IMAGE tensor [B,H,W,C], got {tuple(img_tensor.shape)}")

    t = img_tensor[0].detach().cpu()
    t = torch.clamp(t, 0.0, 1.0)
    arr = (t.numpy() * 255.0).astype(np.uint8)
    return Image.fromarray(arr)


def _save_temp_preview(pil_img: Image.Image, prefix: str) -> Dict[str, str]:
    temp_dir = folder_paths.get_temp_directory()
    os.makedirs(temp_dir, exist_ok=True)

    filename = f"{prefix}_{uuid.uuid4().hex}.png"
    fullpath = os.path.join(temp_dir, filename)
    pil_img.save(fullpath, format="PNG")

    return {"filename": filename, "subfolder": "", "type": "temp"}


def _resize_image_tensor_to_hw(img_bhwc: torch.Tensor, out_h: int, out_w: int) -> torch.Tensor:
    if img_bhwc.dim() != 4:
        raise ValueError("Expected [B,H,W,C]")

    b, h, w, c = img_bhwc.shape
    if h == out_h and w == out_w:
        return img_bhwc

    x = img_bhwc.permute(0, 3, 1, 2)  # [B,C,H,W]
    x = torch.nn.functional.interpolate(x, size=(out_h, out_w), mode="bilinear", align_corners=False)
    x = x.permute(0, 2, 3, 1).contiguous()
    return x


routes = PromptServer.instance.routes

@routes.post("/interactive_crop/submit")
async def interactive_crop_submit(request):
    form = await request.post()

    prompt_id = str(form.get("prompt_id", "")).strip()
    node_id = str(form.get("node_id", "")).strip()
    action = str(form.get("action", "")).strip()  # "continue" | "cancel" | "passthrough"

    def _as_int(name: str, default: int = 0) -> int:
        try:
            return int(float(form.get(name, default)))
        except Exception:
            return default

    x0 = _as_int("x0", 0)
    y0 = _as_int("y0", 0)
    x1 = _as_int("x1", 0)
    y1 = _as_int("y1", 0)

    key = (prompt_id, node_id)

    with _LOCK:
        waiter = _WAITERS.get(key)
        if waiter is None:
            return web.json_response({"ok": False, "error": "No active waiter for this prompt/node."})

        waiter["data"] = {"action": action, "x0": x0, "y0": y0, "x1": x1, "y1": y1}
        waiter["event"].set()

    return web.json_response({"ok": True})


class InteractiveCrop:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "force_original_ratio": ("BOOLEAN", {"default": False}),
                "resize_to_original": ("BOOLEAN", {"default": False}),
            },
            "hidden": {
                "node_id": "UNIQUE_ID",
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE", "BOOLEAN")
    RETURN_NAMES = ("image", "did_crop")
    FUNCTION = "run"
    CATEGORY = "image"

    def run(
        self,
        image: torch.Tensor,
        force_original_ratio: bool,
        resize_to_original: bool,
        node_id: str,
        prompt=None,
        extra_pnginfo=None,
    ):
        if _is_node_bypassed(node_id, extra_pnginfo=extra_pnginfo, prompt=prompt):
            return (image, False)

        prompt_id = getattr(PromptServer.instance, "last_prompt_id", None)
        prompt_id = str(prompt_id) if prompt_id is not None else "unknown"
        node_id = str(node_id)

        orig_b, orig_h, orig_w, orig_c = image.shape

        key = (prompt_id, node_id)
        evt = threading.Event()
        with _LOCK:
            _WAITERS[key] = {"event": evt, "data": None}

        pil = _to_pil(image)
        preview_info = _save_temp_preview(pil, prefix=f"crop_{prompt_id}_{node_id}")

        PromptServer.instance.send_sync(
            "interactive.crop.request",
            {
                "prompt_id": prompt_id,
                "node": node_id,
                "image": preview_info,
                "width": pil.width,
                "height": pil.height,
                "force_original_ratio": bool(force_original_ratio),
            },
        )

        deadline = time.time() + float(TIMEOUT_SECONDS)
        ok = False
        while time.time() < deadline:
            if evt.wait(timeout=0.25):
                ok = True
                break
            if comfy.model_management.should_stop_processing():
                with _LOCK:
                    _WAITERS.pop(key, None)
                raise comfy.model_management.InterruptProcessingException(
                    "InteractiveCrop: job cancelled while waiting for user input."
                )

        with _LOCK:
            payload = _WAITERS.get(key, {}).get("data")
            _WAITERS.pop(key, None)

        if not ok or not payload:
            raise Exception("InteractiveCrop: timed out waiting for user input.")

        action = payload.get("action", "")

        if action == "cancel":
            raise comfy.model_management.InterruptProcessingException("InteractiveCrop: user cancelled.")

        if action == "passthrough":
            return (image, False)

        # "continue" => crop (but if invalid rect, treat as passthrough)
        x0 = int(payload.get("x0", 0))
        y0 = int(payload.get("y0", 0))
        x1 = int(payload.get("x1", 0))
        y1 = int(payload.get("y1", 0))

        b, h, w, c = image.shape

        x0, x1 = sorted([x0, x1])
        y0, y1 = sorted([y0, y1])

        x0 = max(0, min(w - 1, x0))
        x1 = max(0, min(w, x1))
        y0 = max(0, min(h - 1, y0))
        y1 = max(0, min(h, y1))

        if x1 <= x0 or y1 <= y0:
            return (image, False)

        cropped = image[:, y0:y1, x0:x1, :].contiguous()
        if resize_to_original:
            cropped = _resize_image_tensor_to_hw(cropped, orig_h, orig_w)

        return (cropped, True)


NODE_CLASS_MAPPINGS = {"InteractiveCrop": InteractiveCrop}
NODE_DISPLAY_NAME_MAPPINGS = {"InteractiveCrop": "Interactive Crop"}
