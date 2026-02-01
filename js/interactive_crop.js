import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function hasPrimaryButton(e) {
  // Works for PointerEvent/MouseEvent in most browsers.
  // If buttons is missing, assume down only when type suggests it.
  const b = Number(e?.buttons ?? 0);
  if (Number.isFinite(b) && b !== 0) return (b & 1) === 1;
  return false;
}

function setCanvasCursor(graphcanvas, cursor) {
  const el = graphcanvas?.canvas;
  if (!el || !el.style) return;
  el.style.cursor = cursor || "";
}

function cursorForHandle(handle) {
  switch (handle) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    default:
      return null;
  }
}

function wrapTextLines(ctx, text, maxWidth) {
  const raw = String(text ?? "").trim();
  if (!raw) return [];

  // Keep explicit newlines if present.
  const paragraphs = raw.split(/\r?\n/);
  const lines = [];

  for (const p of paragraphs) {
    const words = p.split(/\s+/).filter(Boolean);
    let cur = "";
    for (const w of words) {
      const test = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(test).width <= maxWidth) {
        cur = test;
        continue;
      }
      if (cur) lines.push(cur);

      // If a single word is too long, hard-break it.
      if (ctx.measureText(w).width > maxWidth) {
        let chunk = "";
        for (const ch of w) {
          const t = chunk + ch;
          if (ctx.measureText(t).width <= maxWidth) {
            chunk = t;
          } else {
            if (chunk) lines.push(chunk);
            chunk = ch;
          }
        }
        cur = chunk;
      } else {
        cur = w;
      }
    }
    if (cur) lines.push(cur);
  }

  return lines;
}

async function postDecision({ prompt_id, node_id, action, rect }) {
  const body = new FormData();
  body.append("prompt_id", prompt_id);
  body.append("node_id", node_id);
  body.append("action", action);

  if (rect) {
    body.append("x0", rect.x0);
    body.append("y0", rect.y0);
    body.append("x1", rect.x1);
    body.append("y1", rect.y1);
  }

  await api.fetchApi("/interactive_crop/submit", { method: "POST", body });
}

function getNodeById(nodeId) {
  const g = app.graph;
  if (!g) return null;
  for (const n of g._nodes) {
    if (String(n.id) === String(nodeId)) return n;
  }
  return null;
}

function isNodeSelected(node) {
  const c = app?.canvas;

  if (c?.selected_node && String(c.selected_node.id) === String(node.id)) return true;
  if (c?.selected_nodes && c.selected_nodes[node.id]) return true;

  const g = node?.graph;
  if (g?._selected_nodes && g._selected_nodes[node.id]) return true;
  if (g?._selected_node && String(g._selected_node.id) === String(node.id)) return true;

  return false;
}

function findWidget(node, exactNameLower) {
  if (!node.widgets) return null;
  return node.widgets.find(w => String(w?.name ?? "").toLowerCase() === exactNameLower) || null;
}

function setWidgetDisabled(widget, disabled) {
  if (!widget) return;
  widget.disabled = !!disabled;
}

function calcWidgetAreaY(node) {
  // Try to place content below the actual rendered widget stack.
  // In LiteGraph, widgets often have a `y` assigned during layout.
  const widgets = node?.widgets ?? [];
  let maxWidgetY = -1;
  for (const w of widgets) {
    const wy = Number(w?.y);
    if (Number.isFinite(wy)) maxWidgetY = Math.max(maxWidgetY, wy);
  }

  const titleH = Number(globalThis?.LiteGraph?.NODE_TITLE_HEIGHT ?? 30);
  const widgetH = Number(globalThis?.LiteGraph?.NODE_WIDGET_HEIGHT ?? 20);
  const pad = 10;

  // If we have concrete widget y positions, use them.
  if (maxWidgetY >= 0) return maxWidgetY + widgetH + pad;

  // Fallback estimate.
  const count = widgets.length;
  const spacing = 4;
  return titleH + count * (widgetH + spacing) + pad;
}

// -------------------------
// Global safety release
// -------------------------
let ACTIVE_DRAG_NODE = null;

function forceReleaseDrag() {
  if (!ACTIVE_DRAG_NODE) return;
  const st = ACTIVE_DRAG_NODE.__interactive_crop_state;
  if (st) {
    st.dragging = false;
    st.dragMode = null;
    st.resizeHandle = null;
  }
  try {
    ACTIVE_DRAG_NODE.setDirtyCanvas(true, true);
  } catch {}
  ACTIVE_DRAG_NODE = null;
}

let GLOBAL_LISTENERS_INSTALLED = false;
function ensureGlobalListeners() {
  if (GLOBAL_LISTENERS_INSTALLED) return;
  GLOBAL_LISTENERS_INSTALLED = true;

  window.addEventListener("mouseup", forceReleaseDrag, { capture: true });
  window.addEventListener("pointerup", forceReleaseDrag, { capture: true });
  window.addEventListener("pointercancel", forceReleaseDrag, { capture: true });
  window.addEventListener("blur", forceReleaseDrag);
}

// -------------------------
// Aspect helper
// -------------------------
function enforceAspectRect(startX, startY, curX, curY, ratio, maxW, maxH) {
  const dx = curX - startX;
  const dy = curY - startY;

  const sx = dx >= 0 ? 1 : -1;
  const sy = dy >= 0 ? 1 : -1;

  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  const candH = absDx / ratio;
  const candW = absDy * ratio;

  let endX, endY;

  if (candH <= absDy) {
    endX = startX + sx * absDx;
    endY = startY + sy * candH;
  } else {
    endX = startX + sx * candW;
    endY = startY + sy * absDy;
  }

  endX = clamp(endX, 0, maxW);
  endY = clamp(endY, 0, maxH);

  const ndx = endX - startX;
  const ndy = endY - startY;

  if (Math.abs(ndx) > 0.0001) {
    const adjDy = (Math.abs(ndx) / ratio) * (ndy >= 0 ? 1 : -1);
    endY = clamp(startY + adjDy, 0, maxH);
  } else {
    const adjDx = (Math.abs(ndy) * ratio) * (ndx >= 0 ? 1 : -1);
    endX = clamp(startX + adjDx, 0, maxW);
  }

  return { endX, endY };
}

// -------------------------
// Resize handles
// -------------------------
const HANDLE_HALF = 4; // 8x8 squares (tiny)

function getRectHandles(rect) {
  const x = rect.x;
  const y = rect.y;
  const w = rect.w;
  const h = rect.h;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return [
    { key: "nw", x: x, y: y },
    { key: "n", x: cx, y: y },
    { key: "ne", x: x + w, y: y },
    { key: "e", x: x + w, y: cy },
    { key: "se", x: x + w, y: y + h },
    { key: "s", x: cx, y: y + h },
    { key: "sw", x: x, y: y + h },
    { key: "w", x: x, y: cy },
  ];
}

function hitTestHandle(localX, localY, rect) {
  const handles = getRectHandles(rect);
  for (const h of handles) {
    if (Math.abs(localX - h.x) <= HANDLE_HALF && Math.abs(localY - h.y) <= HANDLE_HALF) {
      return h.key;
    }
  }
  return null;
}

function normalizeRect(r) {
  const x0 = Math.min(r.x, r.x + r.w);
  const y0 = Math.min(r.y, r.y + r.h);
  const x1 = Math.max(r.x, r.x + r.w);
  const y1 = Math.max(r.y, r.y + r.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function clampRectToBox(rect, boxW, boxH, minSize = 2) {
  let r = normalizeRect(rect);
  r.x = clamp(r.x, 0, boxW);
  r.y = clamp(r.y, 0, boxH);
  r.w = clamp(r.w, 0, boxW - r.x);
  r.h = clamp(r.h, 0, boxH - r.y);
  if (r.w < minSize) r.w = minSize;
  if (r.h < minSize) r.h = minSize;
  if (r.x + r.w > boxW) r.x = Math.max(0, boxW - r.w);
  if (r.y + r.h > boxH) r.y = Math.max(0, boxH - r.h);
  return r;
}

function applyResize(rect, handle, curX, curY, boxW, boxH, forceRatio, imgW, imgH) {
  // curX/curY are in the same coordinate space as rect (we use image pixels).
  const minSize = 2;
  const r0 = normalizeRect(rect);
  const left = r0.x;
  const top = r0.y;
  const right = r0.x + r0.w;
  const bottom = r0.y + r0.h;

  let x0 = left;
  let y0 = top;
  let x1 = right;
  let y1 = bottom;

  // Corner handles can preserve ratio cleanly by using the opposite corner as anchor.
  if (forceRatio && (handle === "nw" || handle === "ne" || handle === "sw" || handle === "se")) {
    const ratio = imgW / imgH;
    let anchorX = 0;
    let anchorY = 0;
    if (handle === "nw") {
      anchorX = right;
      anchorY = bottom;
    } else if (handle === "ne") {
      anchorX = left;
      anchorY = bottom;
    } else if (handle === "sw") {
      anchorX = right;
      anchorY = top;
    } else {
      anchorX = left;
      anchorY = top;
    }
    const out = enforceAspectRect(anchorX, anchorY, curX, curY, ratio, boxW, boxH);
    const endX = out.endX;
    const endY = out.endY;
    x0 = Math.min(anchorX, endX);
    y0 = Math.min(anchorY, endY);
    x1 = Math.max(anchorX, endX);
    y1 = Math.max(anchorY, endY);
  } else {
    if (handle.includes("w")) x0 = curX;
    if (handle.includes("e")) x1 = curX;
    if (handle.includes("n")) y0 = curY;
    if (handle.includes("s")) y1 = curY;
  }

  // Enforce minimum size before clamping.
  if (x1 - x0 < minSize) {
    const mid = (x0 + x1) / 2;
    x0 = mid - minSize / 2;
    x1 = mid + minSize / 2;
  }
  if (y1 - y0 < minSize) {
    const mid = (y0 + y1) / 2;
    y0 = mid - minSize / 2;
    y1 = mid + minSize / 2;
  }

  const outRect = clampRectToBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, boxW, boxH, minSize);
  return outRect;
}

function ensureButtons(node) {
  if (node.__interactive_crop_buttons_added) return;
  node.__interactive_crop_buttons_added = true;

  const apply = node.addWidget("button", "Apply Crop / Skip", "apply", async () => {
    const st = node.__interactive_crop_state;
    if (!st || !st.ready || !st.sessionActive || st.submitted) return;

    st.submitted = true;
    node.setDirtyCanvas(true, true);

    if (!st.rect || st.rect.w < 2 || st.rect.h < 2) {
      await postDecision({ prompt_id: st.prompt_id, node_id: st.node_id, action: "passthrough" });
      st.sessionActive = false;
      node.setDirtyCanvas(true, true);
      return;
    }

    const x0 = Math.round(st.rect.x);
    const y0 = Math.round(st.rect.y);
    const x1 = Math.round(st.rect.x + st.rect.w);
    const y1 = Math.round(st.rect.y + st.rect.h);

    await postDecision({
      prompt_id: st.prompt_id,
      node_id: st.node_id,
      action: "continue",
      rect: { x0, y0, x1, y1 },
    });

    // Replace the preview with the cropped result for user confirmation.
    // This is a purely client-side crop of the preview image (server crop still happens).
    try {
      const cw = Math.max(1, x1 - x0);
      const ch = Math.max(1, y1 - y0);
      const c = document.createElement("canvas");
      c.width = cw;
      c.height = ch;
      const cctx = c.getContext("2d");
      if (cctx && st.img) {
        cctx.imageSmoothingEnabled = false;
        cctx.drawImage(st.img, x0, y0, cw, ch, 0, 0, cw, ch);
        const url = c.toDataURL("image/png");
        const img2 = new Image();
        img2.onload = () => {
          st.img = img2;
          st.imgW = img2.width;
          st.imgH = img2.height;
          st.rect = null;
          st.dragging = false;
          st.dragMode = null;
          st.resizeHandle = null;
          st.resizeStartRect = null;
          st.__cursor = "";
          node.setDirtyCanvas(true, true);
        };
        img2.src = url;
      }
    } catch {}

    st.sessionActive = false;
    node.setDirtyCanvas(true, true);
  });

  const cancel = node.addWidget("button", "Cancel Run", "cancel", async () => {
    const st = node.__interactive_crop_state;
    if (!st || !st.ready || !st.sessionActive || st.submitted) return;

    st.submitted = true;
    node.setDirtyCanvas(true, true);

    await postDecision({ prompt_id: st.prompt_id, node_id: st.node_id, action: "cancel" });

    st.sessionActive = false;
    node.setDirtyCanvas(true, true);
  });

  node.__interactive_crop_apply_widget = apply;
  node.__interactive_crop_cancel_widget = cancel;

  setWidgetDisabled(apply, true);
  setWidgetDisabled(cancel, true);
}

function attachInlineHandlers(node) {
  if (node.__interactive_crop_handlers_attached) return;
  node.__interactive_crop_handlers_attached = true;

  ensureGlobalListeners();

  const origDraw = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    if (origDraw) origDraw.call(this, ctx);

    const st = this.__interactive_crop_state;
    const applyW = this.__interactive_crop_apply_widget;
    const cancelW = this.__interactive_crop_cancel_widget;

    const active = !!(st && st.ready && st.sessionActive && !st.submitted);

    // Apply enabled when active
    setWidgetDisabled(applyW, !active);

    // Cancel enabled when active (no selection requirement anymore)
    setWidgetDisabled(cancelW, !active);

    if (!st || !st.ready || !st.img || !st.sessionActive) return;

    // Live-read force ratio toggle while session active
    const ratioWidget = findWidget(this, "force_original_ratio");
    if (ratioWidget) st.forceOriginalRatio = !!ratioWidget.value;

    const padding = 8;
    const contentTop = calcWidgetAreaY(this);
    const x = padding;
    const y = contentTop;
    const w = this.size[0] - padding * 2;

    // Allow user resizing to control preview height (do NOT auto-resize node).
    // Reserve a little room for instruction text below the image.
    const maxH = clamp((this.size[1] ?? 0) - y - 48, 20, 2000);
    const imgAR = st.imgW / st.imgH;
    let drawW = w;
    let drawH = Math.round(drawW / imgAR);
    if (drawH > maxH) {
      drawH = maxH;
      drawW = Math.round(drawH * imgAR);
    }

    const drawX = x + Math.round((w - drawW) / 2);
    const drawY = y;

    st.drawBox = { x: drawX, y: drawY, w: drawW, h: drawH };
    st.scale = drawW / st.imgW;

    // frame
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.fillRect(drawX - 2, drawY - 2, drawW + 4, drawH + 4);
    ctx.strokeRect(drawX - 2, drawY - 2, drawW + 4, drawH + 4);
    ctx.restore();

    // base image
    ctx.drawImage(st.img, drawX, drawY, drawW, drawH);

    // selection overlay (dim outside, keep inside visible)
    if (st.rect) {
      const rectDraw = {
        x: st.rect.x * st.scale,
        y: st.rect.y * st.scale,
        w: st.rect.w * st.scale,
        h: st.rect.h * st.scale,
      };

      const rx = drawX + rectDraw.x;
      const ry = drawY + rectDraw.y;
      const rw = rectDraw.w;
      const rh = rectDraw.h;

      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(drawX, drawY, drawW, drawH);
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      ctx.rect(rx, ry, rw, rh);
      ctx.clip();
      ctx.drawImage(st.img, drawX, drawY, drawW, drawH);
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = 1;
      ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
      ctx.restore();

      // Resize handles
      ctx.save();
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 1;
      for (const h of getRectHandles(rectDraw)) {
        const hx = drawX + h.x;
        const hy = drawY + h.y;
        const s = HANDLE_HALF;
        ctx.fillRect(Math.round(hx - s), Math.round(hy - s), s * 2, s * 2);
        ctx.strokeRect(Math.round(hx - s) + 0.5, Math.round(hy - s) + 0.5, s * 2, s * 2);
      }
      ctx.restore();
    }

    // Instruction text (wrapped + clipped to node bounds)
    const msg = "Drag in the preview to select a crop area. Drag handles to resize; drag inside the box to move.";
    const textPaddingTop = 10;
    const lineH = 14;
    const textMaxW = Math.max(10, w);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.size[0], this.size[1]);
    ctx.clip();

    ctx.font = "12px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    const lines = wrapTextLines(ctx, msg, textMaxW);
    const baseY = drawY + drawH + textPaddingTop + lineH;
    const cx = x + w / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], cx, baseY + i * lineH);
    }
    ctx.restore();

    // Do not change node size here; keep all drawing clipped to node bounds.
  };

  const origMouseDown = node.onMouseDown;
  node.onMouseDown = function (e, pos, graphcanvas) {
    const st = this.__interactive_crop_state;

    // Still require selection for mouse interactions to avoid “it keeps trying to crop”
    if (!st || !st.ready || !st.sessionActive || st.submitted || !st.drawBox || !isNodeSelected(this)) {
      return origMouseDown ? origMouseDown.call(this, e, pos, graphcanvas) : false;
    }

    const box = st.drawBox;
    const lx = pos[0];
    const ly = pos[1];

    if (!(lx >= box.x && lx <= box.x + box.w && ly >= box.y && ly <= box.y + box.h)) {
      return origMouseDown ? origMouseDown.call(this, e, pos, graphcanvas) : false;
    }

    const localX = clamp(lx - box.x, 0, box.w);
    const localY = clamp(ly - box.y, 0, box.h);

    const imgX = localX / (st.scale || 1);
    const imgY = localY / (st.scale || 1);

    // If clicking a handle => resize
    if (st.rect) {
      const rectDraw = {
        x: st.rect.x * st.scale,
        y: st.rect.y * st.scale,
        w: st.rect.w * st.scale,
        h: st.rect.h * st.scale,
      };
      const handle = hitTestHandle(localX, localY, rectDraw);
      if (handle) {
        st.dragging = true;
        st.dragMode = "resize";
        st.resizeHandle = handle;
        st.resizeStartRect = { ...st.rect }; // image coords

        const cur = cursorForHandle(handle);
        if (cur) setCanvasCursor(graphcanvas, cur);

        ACTIVE_DRAG_NODE = this;
        this.setDirtyCanvas(true, true);
        return true;
      }
    }

    // If clicking inside existing rect => move
    if (st.rect) {
      const rectDraw = {
        x: st.rect.x * st.scale,
        y: st.rect.y * st.scale,
        w: st.rect.w * st.scale,
        h: st.rect.h * st.scale,
      };
      const inside =
        localX >= rectDraw.x &&
        localX <= rectDraw.x + rectDraw.w &&
        localY >= rectDraw.y &&
        localY <= rectDraw.y + rectDraw.h;

      if (inside) {
        st.dragging = true;
        st.dragMode = "move";
        st.resizeHandle = null;
        st.moveOffsetX = imgX - st.rect.x;
        st.moveOffsetY = imgY - st.rect.y;

        setCanvasCursor(graphcanvas, "move");

        ACTIVE_DRAG_NODE = this;
        this.setDirtyCanvas(true, true);
        return true;
      }
    }

    // Else start new rect
    st.dragging = true;
    st.dragMode = "new";
    st.resizeHandle = null;
    st.startX = imgX;
    st.startY = imgY;
    st.rect = { x: st.startX, y: st.startY, w: 0, h: 0 }; // image coords

    ACTIVE_DRAG_NODE = this;
    this.setDirtyCanvas(true, true);
    return true;
  };

  const origMouseMove = node.onMouseMove;
  node.onMouseMove = function (e, pos, graphcanvas) {
    const st = this.__interactive_crop_state;
    // Hover cursor updates when active (even if not dragging)
    if (st && st.ready && st.sessionActive && !st.submitted && st.drawBox && isNodeSelected(this)) {
      const box = st.drawBox;
      const lx = pos[0];
      const ly = pos[1];
      let desired = "";

      const over = lx >= box.x && lx <= box.x + box.w && ly >= box.y && ly <= box.y + box.h;
      if (over) {
        const localX = clamp(lx - box.x, 0, box.w);
        const localY = clamp(ly - box.y, 0, box.h);

        if (st.dragging) {
          if (st.dragMode === "resize" && st.resizeHandle) {
            desired = cursorForHandle(st.resizeHandle) || desired;
          } else if (st.dragMode === "move") {
            desired = "move";
          } else {
            desired = st.forceOriginalRatio ? "crosshair" : "crosshair";
          }
        } else if (st.rect) {
          const rectDraw = {
            x: st.rect.x * st.scale,
            y: st.rect.y * st.scale,
            w: st.rect.w * st.scale,
            h: st.rect.h * st.scale,
          };
          const handle = hitTestHandle(localX, localY, rectDraw);
          if (handle) {
            desired = cursorForHandle(handle) || desired;
          } else {
            const inside =
              localX >= rectDraw.x &&
              localX <= rectDraw.x + rectDraw.w &&
              localY >= rectDraw.y &&
              localY <= rectDraw.y + rectDraw.h;
            desired = inside ? "move" : "crosshair";
          }
        } else {
          desired = "crosshair";
        }
      } else {
        desired = "";
      }

      if (st.__cursor !== desired) {
        st.__cursor = desired;
        setCanvasCursor(graphcanvas, desired);
      }
    } else {
      // If we previously set a cursor for this node/session, reset it.
      if (st && st.__cursor) {
        st.__cursor = "";
        setCanvasCursor(graphcanvas, "");
      }
    }

    if (!st || !st.dragging || !st.drawBox) {
      return origMouseMove ? origMouseMove.call(this, e, pos, graphcanvas) : false;
    }

    // If the browser/litegraph missed mouseup, stop dragging as soon as no button is held.
    // This addresses the "stuck updating selection" issue.
    if (!hasPrimaryButton(e)) {
      st.dragging = false;
      st.dragMode = null;
      st.resizeHandle = null;
      ACTIVE_DRAG_NODE = null;
      this.setDirtyCanvas(true, true);
      // Reset cursor on forced release
      setCanvasCursor(graphcanvas, "");
      return false;
    }

    // If deselected mid-drag, release.
    if (!isNodeSelected(this)) {
      forceReleaseDrag();
      return false;
    }

    const box = st.drawBox;
    const localX0 = clamp(pos[0] - box.x, 0, box.w);
    const localY0 = clamp(pos[1] - box.y, 0, box.h);

    const imgX0 = localX0 / (st.scale || 1);
    const imgY0 = localY0 / (st.scale || 1);

    if (st.dragMode === "move" && st.rect) {
      const newX = clamp(imgX0 - st.moveOffsetX, 0, st.imgW - st.rect.w);
      const newY = clamp(imgY0 - st.moveOffsetY, 0, st.imgH - st.rect.h);
      st.rect = { ...st.rect, x: newX, y: newY };
      this.setDirtyCanvas(true, true);
      return true;
    }

    if (st.dragMode === "resize" && st.rect && st.resizeHandle) {
      const baseRect = st.resizeStartRect ? st.resizeStartRect : st.rect;
      st.rect = applyResize(
        baseRect,
        st.resizeHandle,
        imgX0,
        imgY0,
        st.imgW,
        st.imgH,
        !!st.forceOriginalRatio,
        st.imgW,
        st.imgH
      );
      this.setDirtyCanvas(true, true);
      return true;
    }

    // dragMode === "new"
    let endX = imgX0;
    let endY = imgY0;

    if (st.forceOriginalRatio) {
      const ratio = st.imgW / st.imgH;
      const out = enforceAspectRect(st.startX, st.startY, imgX0, imgY0, ratio, st.imgW, st.imgH);
      endX = out.endX;
      endY = out.endY;
    }

    const x0 = Math.min(st.startX, endX);
    const y0 = Math.min(st.startY, endY);
    const x1 = Math.max(st.startX, endX);
    const y1 = Math.max(st.startY, endY);

    st.rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    this.setDirtyCanvas(true, true);
    return true;
  };

  const origMouseUp = node.onMouseUp;
  node.onMouseUp = function (e, pos, graphcanvas) {
    const st = this.__interactive_crop_state;
    if (st && st.dragging) {
      st.dragging = false;
      st.dragMode = null;
      st.resizeHandle = null;
      st.resizeStartRect = null;
      ACTIVE_DRAG_NODE = null;
      this.setDirtyCanvas(true, true);
      setCanvasCursor(graphcanvas, st.__cursor || "");
      return true;
    }
    return origMouseUp ? origMouseUp.call(this, e, pos, graphcanvas) : false;
  };
}

app.registerExtension({
  name: "interactive.crop.inline",

  async setup() {
    api.addEventListener("interactive.crop.request", async (event) => {
      const d = event.detail || {};
      const prompt_id = String(d.prompt_id ?? "");
      const node_id = String(d.node ?? "");
      const image = d.image;

      const imgW = Number(d.width ?? 0);
      const imgH = Number(d.height ?? 0);
      const forceOriginalRatio = !!d.force_original_ratio;

      if (!prompt_id || !node_id || !image) return;

      const node = getNodeById(node_id);
      if (!node) return;

      ensureButtons(node);
      attachInlineHandlers(node);

      if (ACTIVE_DRAG_NODE && ACTIVE_DRAG_NODE.id === node.id) {
        forceReleaseDrag();
      }

      // Start session immediately
      const st = (node.__interactive_crop_state = {
        ready: false,
        prompt_id,
        node_id,
        imgW,
        imgH,
        img: null,
        rect: null,
        dragging: false,
        dragMode: null, // "new" | "move" | null
        resizeHandle: null, // "nw"|"n"|"ne"|"e"|"se"|"s"|"sw"|"w"|null
        resizeStartRect: null,
        moveOffsetX: 0,
        moveOffsetY: 0,
        drawBox: null,
        scale: 1,
        startX: 0,
        startY: 0,
        sessionActive: true,
        submitted: false,
        forceOriginalRatio,
      });

      const qs = new URLSearchParams({
        filename: image.filename,
        type: image.type,
        subfolder: image.subfolder || "",
      });

      const img = new Image();
      img.onload = () => {
        st.img = img;
        st.ready = true;
        node.setDirtyCanvas(true, true);
      };
      img.src = `/view?${qs.toString()}`;
    });
  },
});
