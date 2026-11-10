// The upload canvas.
//
// While the sequence engine is active this canvas draws the whole island body:
// card, dashed drop frame, drop text, progress bar and the file going up into
// Lumo's eyes. The island draws Lumo himself, in the top bar.

import { lerp } from "../core/anim";
import { NEW_LOOK_BOT } from "../core/layout";
import { fileCells, fileProgress, uploadingLabel } from "./files";
import { State } from "../core/state";
import { SCRIPT_FONTS } from "../core/fonts";
import { N_, isRtl, t } from "../i18n/i18n";
import {
  USC, eIn, eInOut, progressAt,
  type UploadFrame,
} from "./sequence";

const FONT = `system-ui, "Segoe UI Variable Text", "Segoe UI", ${SCRIPT_FONTS}, sans-serif`;

/**
 * How wide the drop text may run, centred on the card: clear of Lumo and his
 * wings in the top-left corner, and as far from the right edge.
 */
const TEXT_MAX_W = 2 * (USC.TEXT_CX - (USC.REST_X + USC.D_BOX * 0.9));
/** The scene never shrinks below this, even while the island is still opening. */
const MIN_SCALE = 0.6;
/** Drop-zone chips (English keys, shown with `t()`). */
const CHIPS = [N_("PDF"), N_("Images"), N_("Code"), N_("Docs")];

/** Mirrors the reference `rr()`: a rounded rect, radius clamped to the box. */
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rad);
}

function text(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  font: string,
  color: string,
  align: CanvasTextAlign = "left",
) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  // Arabic orders its words right to left; the anchor (left, centre, right) stays put.
  ctx.direction = isRtl() ? "rtl" : "ltr";
  // Every text is anchored on its vertical centre.
  ctx.textBaseline = "middle";
  ctx.fillText(s, x, y);
}

/**
 * The font that fits `s` in `maxW`: `weight size FONT`, or smaller down to
 * `minSize` for a longer translation. English was laid out for these widths
 * and keeps its size (only an overlong file name can make it shrink).
 */
export function fitFont(
  ctx: CanvasRenderingContext2D,
  s: string,
  maxW: number,
  weight: number,
  size: number,
  minSize = size * 0.75,
): string {
  let px = size;
  ctx.font = `${weight} ${px}px ${FONT}`;
  while (ctx.measureText(s).width > maxW && px > minSize) {
    px = Math.max(minSize, px - 0.5);
    ctx.font = `${weight} ${px}px ${FONT}`;
  }
  return ctx.font;
}

/** `s` cut with an ellipsis so it fits `maxW` in `font` (a file name that is too long). */
export function ellipsize(ctx: CanvasRenderingContext2D, s: string, maxW: number, font: string): string {
  ctx.font = font;
  if (ctx.measureText(s).width <= maxW) return s;
  let cut = s;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxW) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** A label that fits `maxW`: a smaller font first, then an ellipsis. */
function fitted(ctx: CanvasRenderingContext2D, s: string, maxW: number, weight: number, size: number) {
  const font = fitFont(ctx, s, maxW, weight, size);
  return { font, s: ellipsize(ctx, s, maxW, font) };
}

/**
 * Where the 640 × 176 scene sits in the island. The card always reaches the
 * island's edges, whatever size it was given; the text, the bar and Lumo sit
 * in its middle, at their own size on a bigger island and scaled down by `s`
 * on one smaller than the scene (the smallest island is 560 × 160), so the
 * dashed frame and the bar never run past the card. `ox`/`oy` is where the
 * scene's corner lands in the island, `reachX`/`reachY` how much farther than
 * the scene's card the island's card reaches on each side, in scene points.
 */
export interface UploadStage {
  w: number;
  h: number;
  s: number;
  ox: number;
  oy: number;
  reachX: number;
  reachY: number;
}

/** The card drawn on an island of `w` × `h`: inset like the scene's. */
export function uploadCard(w: number, h: number): { x: number; y: number; w: number; h: number } {
  return {
    x: USC.CARD_X,
    y: USC.CARD_Y,
    w: Math.max(0, w - 2 * USC.CARD_X),
    h: Math.max(0, h - USC.CARD_Y - (USC.ISL_H - USC.CARD_Y - USC.CARD_H)),
  };
}

export function uploadStage(islandW: number, islandH: number): UploadStage {
  const w = Math.max(1, Math.round(islandW));
  const h = Math.max(1, Math.round(islandH));
  const card = uploadCard(w, h);
  const s = Math.max(MIN_SCALE, Math.min(1, card.w / USC.CARD_W, card.h / USC.CARD_H));
  // The scene's card centre on the island's card centre.
  const ox = card.x + card.w / 2 - (USC.CARD_X + USC.CARD_W / 2) * s;
  const oy = card.y + card.h / 2 - (USC.CARD_Y + USC.CARD_H / 2) * s;
  return {
    w, h, s, ox, oy,
    reachX: Math.max(0, (card.w / s - USC.CARD_W) / 2),
    reachY: Math.max(0, (card.h / s - USC.CARD_H) / 2),
  };
}

export class UploadCanvas {
  /** The layer holding the canvas. */
  readonly el: HTMLElement;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private sizedFor = "";
  private stage: UploadStage = uploadStage(USC.W, USC.ISL_H);

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.id = "upload-canvas";

    this.el = document.createElement("div");
    this.el.id = "upload-layer";
    this.el.append(this.canvas);

    this.ctx = this.canvas.getContext("2d");
  }

  /** The island's size: the layer covers it, the scene in its middle. */
  place(islandW: number, islandH: number): UploadStage {
    const st = uploadStage(islandW, islandH);
    const was = this.stage;
    this.stage = st;
    if (st.w !== was.w || st.h !== was.h || !this.el.style.width) {
      this.el.style.left = "0px";
      this.el.style.width = `${st.w}px`;
      this.el.style.height = `${st.h}px`;
    }
    return st;
  }

  /** A point in the island (page pixels from its corner) in scene points. */
  toScene(x: number, y: number): { x: number; y: number } {
    const st = this.stage;
    return { x: (x - st.ox) / st.s, y: (y - st.oy) / st.s };
  }

  /** `wallTime` in seconds drives the marching dashes. */
  draw(f: UploadFrame, wallTime: number) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const st = this.stage;
    const key = `${dpr}|${st.w}|${st.h}`;
    if (this.sizedFor !== key) {
      this.sizedFor = key;
      this.canvas.width = Math.round(st.w * dpr);
      this.canvas.height = Math.round(st.h * dpr);
      this.canvas.style.width = `${st.w}px`;
      this.canvas.style.height = `${st.h}px`;
    }
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, st.w, st.h);

    this.drawScene(ctx, f, wallTime);
  }

  // ── Scene ─────────────────────────────────────────────────────────────────

  private drawScene(ctx: CanvasRenderingContext2D, f: UploadFrame, wallTime: number) {
    const st = this.stage;
    // The card reaches the island's edges, however big or small it was made.
    const { w: cardW, h: cardH } = uploadCard(st.w, st.h);

    // Island background.
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, st.w, st.h);

    // Card.
    ctx.save();
    rr(ctx, USC.CARD_X, USC.CARD_Y, cardW, cardH, USC.CARD_R);
    ctx.clip();
    ctx.fillStyle = "#0D0E10";
    ctx.fillRect(USC.CARD_X, USC.CARD_Y, cardW, cardH);

    // Green glow, fanning up from the bottom edge of the card.
    if (f.greenWash > 0) {
      const gx = USC.CARD_X + cardW / 2;
      const gy = USC.CARD_Y + cardH;
      const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, USC.CARD_H * 1.5);
      g.addColorStop(0, `rgba(40,212,130,${f.greenWash * 0.9})`);
      g.addColorStop(0.55, `rgba(40,212,130,${f.greenWash * 0.3})`);
      g.addColorStop(1, "rgba(40,212,130,0)");
      ctx.fillStyle = g;
      ctx.fillRect(USC.CARD_X, USC.CARD_Y, cardW, cardH);
    }
    ctx.restore();

    // Dashed border, marching left to right at ~20 pt/s.
    if (f.zoneAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = f.zoneAlpha;
      ctx.strokeStyle = f.zoneOver ? "rgba(52,212,153,0.55)" : "rgba(255,255,255,0.14)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -wallTime * 20;
      rr(ctx, USC.CARD_X + 0.75, USC.CARD_Y + 0.75, Math.max(0, cardW - 1.5), Math.max(0, cardH - 1.5), USC.CARD_R - 0.5);
      ctx.stroke();
      ctx.restore();
    }

    // The rest is drawn in scene points, in the middle of the card.
    ctx.save();
    ctx.translate(st.ox, st.oy);
    ctx.scale(st.s, st.s);
    if (f.zoneAlpha > 0 && f.textAlpha > 0) this.drawDropText(ctx, f);
    if (f.barAlpha > 0 || f.barReveal > 0) this.drawProgressBar(ctx, f);

    // Lumo stays in the top bar, two eyes, and the file goes up into them;
    // the island draws him (island.ts), this canvas does not.
    if (f.fileVisible) this.drawFileToEyes(ctx, f);
    ctx.restore();
  }

  // ── Drop zone text and chips ──────────────────────────────────────────────

  private drawDropText(ctx: CanvasRenderingContext2D, f: UploadFrame) {
    ctx.save();
    ctx.globalAlpha = f.textAlpha;
    const title = fitted(ctx, t("Drop your files here"), TEXT_MAX_W, 500, 13);
    text(ctx, title.s, USC.TEXT_CX, USC.TEXT_Y - 4, title.font, "#D5D7DB", "center");

    // Chips are measured roughly, so the row lines up; a translation wider
    // than that estimate gets the room it needs.
    const labels = CHIPS.map((chip) => t(chip));
    let chipPx = 11;
    const widths = () => {
      ctx.font = `500 ${chipPx}px ${FONT}`;
      return labels.map((l) => Math.max(l.length * 6.5 + 16, Math.ceil(ctx.measureText(l).width) + 16));
    };
    let ws = widths();
    const rowW = () => ws.reduce((a, b) => a + b, 0) + 6 * (ws.length - 1);
    while (rowW() > TEXT_MAX_W && chipPx > 8.5) {
      chipPx -= 0.5;
      ws = widths();
    }
    // The row centred under the title, each label centred in its chip.
    let cx = USC.TEXT_CX - rowW() / 2;
    labels.forEach((chip, i) => {
      const w = ws[i];
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      rr(ctx, cx, USC.TEXT_Y + 9, w, 18, 9);
      ctx.fill();
      text(ctx, chip, cx + w / 2, USC.TEXT_Y + 18, `500 ${chipPx}px ${FONT}`, "#B9BDC4", "center");
      cx += w + 6;
    });
    ctx.restore();
  }

  // ── Progress bar ──────────────────────────────────────────────────────────

  private drawProgressBar(ctx: CanvasRenderingContext2D, f: UploadFrame) {
    ctx.save();
    ctx.globalAlpha = Math.max(f.barAlpha, 0.001);

    const x0 = USC.BAR_X0;
    const x1 = USC.BAR_X1;
    const by = f.barY;
    const barLen = (x1 - x0) * f.barReveal;

    // Room up to the percentage (or the check mark) at the bar's right end.
    const names = State.uploadNames.length > 1 ? State.uploadNames : [State.droppedFile?.name ?? t("file")];
    const uploading = uploadingLabel(names);
    const label = fitted(ctx, uploading, x1 - x0 - 56, 500, 12.5);
    text(ctx, label.s, x0, by - 30, label.font, "#A9ADB5");

    if (f.check > 0) {
      ctx.save();
      ctx.translate(x1 - 8, by - 30);
      ctx.scale(f.check, f.check);
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.fillStyle = "#34D399";
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-3.6, 0.2);
      ctx.lineTo(-1, 2.8);
      ctx.lineTo(3.8, -2.6);
      ctx.strokeStyle = "#07130E";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();
    } else {
      text(ctx, `${Math.round(f.progress * 100)} %`, x1, by - 30, `500 12.5px ${FONT}`, "#A9ADB5", "right");
    }

    // Track.
    if (barLen > 0) {
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      rr(ctx, x0, by - 3, barLen, 6, 3);
      ctx.fill();
    }

    // Fill.
    const fx = lerp(x0, x1, f.progress);
    if (fx > x0 + 1) {
      const flashGreen = `rgb(${Math.round(lerp(52, 110, f.flash))},${Math.round(
        lerp(211, 231, f.flash),
      )},${Math.round(lerp(153, 183, f.flash))})`;
      const g = ctx.createLinearGradient(x0, 0, fx, 0);
      g.addColorStop(0, "#1FA87A");
      g.addColorStop(1, flashGreen);
      ctx.fillStyle = g;
      rr(ctx, x0, by - 3, fx - x0, 6, 3);
      ctx.fill();
    }

    // Glow trail, its length driven by how fast the bar is moving.
    if (f.progress > 0.01 && f.progress < 1) {
      const v =
        (progressAt(f.t + 0.01, USC.T_PROG_START, f.progEnd) -
          progressAt(f.t, USC.T_PROG_START, f.progEnd)) / 0.01;
      const tl = Math.max(8, Math.min(34, 8 + v * 40));
      const g = ctx.createLinearGradient(fx - tl, 0, fx, 0);
      g.addColorStop(0, "rgba(52,212,153,0)");
      g.addColorStop(1, "rgba(110,231,183,0.6)");
      ctx.save();
      ctx.filter = "blur(3px)";
      ctx.fillStyle = g;
      rr(ctx, fx - tl, by - 4, tl, 8, 4);
      ctx.fill();
      ctx.restore();
    }
    this.drawFileBars(ctx, f, names);
    ctx.restore();
  }

  /** Several files dropped together: a small bar each under the main one, two by two, "+X" for the rest. */
  private drawFileBars(ctx: CanvasRenderingContext2D, f: UploadFrame, names: readonly string[]) {
    const cells = fileCells(names);
    if (cells.length === 0) return;
    const x0 = USC.BAR_X0;
    const gap = 24;
    const cellW = (USC.BAR_X1 - x0 - gap) / 2;
    const reveal = Math.max(0, Math.min(1, f.barReveal));
    cells.forEach((cell, i) => {
      const cx = x0 + (i % 2) * (cellW + gap);
      const ty = f.barY + 22 + Math.floor(i / 2) * 22;
      if (cell.kind === "more") {
        text(ctx, `+${cell.count}`, cx, ty + 3, `600 11px ${FONT}`, "#8E939B");
        return;
      }
      const p = fileProgress(f.progress, cell.index, names.length);
      const done = p >= 0.999;
      const pct = done ? "✓" : `${Math.round(p * 100)} %`;
      text(ctx, pct, cx + cellW, ty, `500 10.5px ${FONT}`, done ? "#34D399" : "#8E939B", "right");
      const label = fitted(ctx, cell.name, cellW - 44, 500, 10.5);
      text(ctx, label.s, cx, ty, label.font, "#8E939B");
      const len = cellW * reveal;
      if (len > 0) {
        ctx.fillStyle = "rgba(255,255,255,0.07)";
        rr(ctx, cx, ty + 6, len, 3, 1.5);
        ctx.fill();
      }
      const fw = cellW * p;
      if (fw > 1) {
        ctx.fillStyle = done ? "#34D399" : "#1FA87A";
        rr(ctx, cx, ty + 6, fw, 3, 1.5);
        ctx.fill();
      }
    });
  }

  // ── The file, and the suction ─────────────────────────────────────────────

  /**
   * The file: under the cursor until the drop, then drawn up to
   * Lumo's eyes in the middle of the top bar (layout.ts NEW_LOOK_BOT),
   * smaller and fainter on the way, as if he breathed it in.
   */
  private drawFileToEyes(ctx: CanvasRenderingContext2D, f: UploadFrame) {
    const cx = f.cursorX;
    const cy = f.cursorY + 14;
    if (f.suck <= 0) {
      ctx.save();
      ctx.globalAlpha = 0.92;
      drawDoc(ctx, cx, cy, 1, 1);
      ctx.restore();
      return;
    }
    const st = this.stage;
    const tx = (st.w / 2 - st.ox) / st.s;
    const ty = (NEW_LOOK_BOT.cy - st.oy) / st.s;
    const p = eIn(f.suck);
    // A little arc: out to the side it came from, then in.
    const x = lerp(cx, tx, eInOut(f.suck)) + Math.sin(Math.PI * f.suck) * (cx < tx ? -14 : 14);
    const y = lerp(cy, ty, p);
    const sc = lerp(1, 0.18, p);
    ctx.save();
    ctx.globalAlpha = 0.92 * (1 - Math.max(0, (f.suck - 0.7) / 0.3));
    ctx.translate(x, y);
    ctx.rotate((cx < tx ? 1 : -1) * 0.35 * Math.sin(Math.PI * f.suck));
    ctx.translate(-x, -y);
    drawDoc(ctx, x, y, sc, sc);
    ctx.restore();
  }
}

// ── Document icon ───────────────────────────────────────────────────────────

/**
 * The generic sheet with a folded corner. The file's real icon is not reachable
 * from the webview, so this is the shape in every case.
 */
function drawDoc(ctx: CanvasRenderingContext2D, cx: number, cy: number, wsc: number, hsc: number) {
  const w = 34 * wsc;
  const h = 42 * hsc;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const fold = 8 * Math.min(wsc, hsc);

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.beginPath();
  ctx.moveTo(x + 2, y);
  ctx.lineTo(x + w - fold, y);
  ctx.lineTo(x + w, y + fold);
  ctx.lineTo(x + w, y + h - 2);
  ctx.quadraticCurveTo(x + w, y + h, x + w - 2, y + h);
  ctx.lineTo(x + 2, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - 2);
  ctx.lineTo(x, y + 2);
  ctx.quadraticCurveTo(x, y, x + 2, y);
  ctx.closePath();
  ctx.fillStyle = "#F4F4F6";
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(x + w - fold, y);
  ctx.lineTo(x + w - fold, y + fold);
  ctx.lineTo(x + w, y + fold);
  ctx.closePath();
  ctx.fillStyle = "#D5D6DB";
  ctx.fill();

  ctx.fillStyle = "#3B82F5";
  rr(ctx, x + w * 0.18, y + h * 0.58, w * 0.64, h * 0.16, 2);
  ctx.fill();
}
