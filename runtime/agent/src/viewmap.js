export function clamp(n, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n));
}

export function imageRect(viewW, viewH, imgW, imgH, panX, panY, zoom) {
  const fit = Math.min(viewW / Math.max(1, imgW), viewH / Math.max(1, imgH));
  const baseW = imgW * fit;
  const baseH = imgH * fit;
  const ox = (viewW - baseW) / 2;
  const oy = (viewH - baseH) / 2;
  const cx = viewW / 2;
  const cy = viewH / 2;
  const z = Math.max(0.01, zoom);
  return {
    left: cx + (ox - cx) * z + panX,
    top: cy + (oy - cy) * z + panY,
    width: baseW * z,
    height: baseH * z,
  };
}

export function mapPageToNorm(pageX, pageY, originX, originY, viewW, viewH, imgW, imgH, panX, panY, zoom) {
  const lx = pageX - originX;
  const ly = pageY - originY;
  const r = imageRect(viewW, viewH, imgW, imgH, panX, panY, zoom);
  return {
    x: clamp((lx - r.left) / Math.max(1, r.width)),
    y: clamp((ly - r.top) / Math.max(1, r.height)),
  };
}

export function visibleNorm(viewW, viewH, imgW, imgH, panX, panY, zoom) {
  const r = imageRect(viewW, viewH, imgW, imgH, panX, panY, zoom);
  const visLeft = Math.max(r.left, 0);
  const visTop = Math.max(r.top, 0);
  const visRight = Math.min(r.left + r.width, viewW);
  const visBottom = Math.min(r.top + r.height, viewH);
  return {
    x: clamp((visLeft - r.left) / Math.max(1, r.width)),
    y: clamp((visTop - r.top) / Math.max(1, r.height)),
    w: clamp((visRight - visLeft) / Math.max(1, r.width)),
    h: clamp((visBottom - visTop) / Math.max(1, r.height)),
  };
}

export function cursorOnRect(rect, cx, cy) {
  return {
    left: rect.left + clamp(cx) * rect.width,
    top: rect.top + clamp(cy) * rect.height,
  };
}

export function placeCrop(desktop, crop) {
  const x = crop && crop.w > 0 && crop.h > 0 ? crop.x : 0;
  const y = crop && crop.w > 0 && crop.h > 0 ? crop.y : 0;
  const w = crop && crop.w > 0 && crop.h > 0 ? crop.w : 1;
  const h = crop && crop.h > 0 ? crop.h : 1;
  return {
    left: desktop.left + x * desktop.width,
    top: desktop.top + y * desktop.height,
    width: Math.max(1, w * desktop.width),
    height: Math.max(1, h * desktop.height),
  };
}

export function expandNorm(vis, pad = 0.9) {
  const w = Math.min(1, vis.w * (1 + pad));
  const h = Math.min(1, vis.h * (1 + pad));
  return {
    x: clamp(vis.x - (w - vis.w) / 2, 0, 1 - w),
    y: clamp(vis.y - (h - vis.h) / 2, 0, 1 - h),
    w,
    h,
  };
}

/**
 * Can the region we already asked the PC for still serve this view? Panning
 * must not re-crop every frame, or the picture's size and origin change many
 * times a second and the view shakes. Returns false only when the view has
 * reached the edge of what we hold, or has zoomed in far enough that holding on
 * would waste resolution.
 */
export function regionStillUsable(region, vis, maxStretch = 2.4) {
  if (!region) return false;
  const slack = 0.004;
  const covers =
    vis.x >= region.x - slack &&
    vis.y >= region.y - slack &&
    vis.x + vis.w <= region.x + region.w + slack &&
    vis.y + vis.h <= region.y + region.h + slack;
  return covers && region.w <= vis.w * maxStretch;
}
