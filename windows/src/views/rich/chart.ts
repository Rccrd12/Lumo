// The ```lumo-chart card: numbers from an answer drawn as horizontal bars or
// as lines, with the same numbers as a table one click away.
//
//   ```lumo-chart bar Resistivity at 20 °C
//   unit: 10⁻⁸ Ω·m
//   Silver: 1.59
//   Copper: 1.68
//   Gold: 2.44
//   ```
//
//   ```lumo-chart line Average temperatures in Milan
//   unit: °C
//   series: High, Low
//   Jan: 6, -1
//   Feb: 9, 0
//   ```
//
// The first word of the title, in lowercase, picks the kind (bar or line,
// also bars, lines and the Italian barre, linee); without one it is bar. Each row is a label
// and its value, or one value per series when a `series:` line names them
// (up to four). A row of labels, `x: Jan Feb Mar`, turns it around: then
// each row is a series and its values, one per label. Between 2 and 30
// labels.
//
// Forgiving where models slip: a decimal comma (1,59), thousands written
// with commas, dots or spaces, a unit written after every value (12 %, 6 °C),
// a list marker before a row, `=` for `:`, a missing value (-, n/a) as a
// gap. A block with too few or too many labels or series, or no number at
// all, is no card: null, and markdown.ts shows it as code.
//
// The bars are DOM nodes; the lines are SVG nodes built one by one (never
// markup), redrawn only when the card's width changes or the pointer moves to
// another point. The numbers are shown in the app's language (Intl).

import { h } from "../dom";
import { N_, t, language } from "../../i18n/i18n";
import { head, remember, type RichContext } from "./index";
import "./chart.css";
import { onResize } from "./resize";

export const CHART_STRINGS = {
  bars: N_("Bars"),
  lines: N_("Lines"),
  table: N_("Table"),
  showChart: N_("Show as a chart"),
  showTable: N_("Show as a table"),
};

export const MIN_LABELS = 2;
export const MAX_LABELS = 30;
export const MAX_SERIES = 4;
/** One series is drawn in the cards' accent; several in these, in order. */
export const ACCENT = "#8fc7ff";
export const SERIES_COLORS = ["#ff9a6b", "#8fc7ff", "#34d399", "#a5b4fc"];
/** The line chart's height, in CSS pixels, its labels included. */
export const LINES_HEIGHT = 128;

export type ChartKind = "bar" | "line";

export interface Series {
  /** Its name, "" for the only series of a chart without a `series:` line. */
  name: string;
  /** One value per label, NaN where it has none. */
  values: number[];
}

export interface Chart {
  kind: ChartKind;
  title: string;
  /** What the values are in, "" when unknown. */
  unit: string;
  labels: string[];
  series: Series[];
  /** The decimals the values were written with (the most any has), so 5.6 shows as 5.60 beside 1.59. */
  digits: number;
}

// The syntax's words, English and Italian, as one string each: they are
// keys, not text, and some (`lines`, `unit`) are also translated strings.
const words = (list: string) => new Set(list.split(" "));
const BAR_WORDS = words("bar bars barre barra barchart hbar column columns");
const LINE_WORDS = words("line lines linee linea linechart trend");
const UNIT_KEYS = words("unit units unita");
const SERIES_KEYS = words("series serie legend legenda columns");
const X_KEYS = words("x labels label etichette categories categorie");
const TYPE_KEYS = words("type kind tipo chart");
/** What a model writes for a value it doesn't have. */
const MISSING = /^(?:-|–|—|\?|…|\.\.\.|n\/?a|null|none|nd|n\.d\.|)$/i;

const keyName = (k: string) => k.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

function kindOf(word: string): ChartKind | null {
  const w = keyName(word).replace(/[:,;]$/, "");
  return BAR_WORDS.has(w) ? "bar" : LINE_WORDS.has(w) ? "line" : null;
}

/** Markdown's emphasis and code marks around a label, which the card shows plain. */
function plain(text: string): string {
  return text.replace(/\*\*|__|`/g, "").replace(/^\*(.+)\*$/, "$1").trim();
}

export interface Reading {
  value: number;
  /** Digits after the decimal mark, as written. */
  decimals: number;
  /** What came after the number (a unit), or a currency before it. */
  unit: string;
}

/** A number group: `1 234`, `1'234` (thousands by spaces or apostrophes), or digits with dots and commas. */
const NUMBER = /^([^\p{L}\p{N}\s+\-−.,]{0,2})\s*([+\-−]?)\s*(\d{1,3}(?:[   '’]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)*|[.,]\d+)(?:[eE]([+\-]?\d+))?\s*(.*)$/u;

/**
 * One value as a model writes it: 1.59, 1,59, -1, −1, 1,234.5, 1.234,5,
 * 1 234, 12 %, 6 °C, $40, 1.2e-3. Null when it isn't a number.
 */
export function parseNumber(text: string): Reading | null {
  const m = NUMBER.exec(text.trim());
  if (!m) return null;
  const [, before, sign, raw, exp, after] = m;
  if (/^[,;]?\s*[+\-−]?\p{N}/u.test(after)) return null;
  let digits = raw.replace(/[   '’]/g, "");
  const dot = digits.lastIndexOf(".");
  const comma = digits.lastIndexOf(",");
  let decimal = "";
  if (dot >= 0 && comma >= 0) decimal = dot > comma ? "." : ",";
  else if (dot >= 0 || comma >= 0) {
    const mark = dot >= 0 ? "." : ",";
    const parts = digits.split(mark);
    // 1,234 and 1.234.567 group thousands; 1,59 and 1.59 have decimals, and
    // so has 0,250: a group of thousands never follows a leading zero.
    const grouped = parts.length > 2 || (mark === "," && parts[0].length > 0 && parts[0].length <= 3 && !parts[0].startsWith("0") && parts[1].length === 3);
    decimal = grouped ? "" : mark;
    if (parts.length > 2 && parts.slice(1).some((p) => p.length !== 3)) return null;
  }
  const other = decimal === "." ? "," : decimal === "," ? "." : null;
  if (other) digits = digits.split(other).join("");
  else digits = digits.replace(/[.,]/g, "");
  const at = decimal ? digits.indexOf(decimal) : -1;
  if (at >= 0 && digits.indexOf(decimal, at + 1) >= 0) return null;
  const written = at >= 0 ? digits.length - at - 1 : 0;
  const number = Number((sign && sign !== "+" ? "-" : "") + digits.replace(",", ".") + (exp ? `e${exp}` : ""));
  if (!Number.isFinite(number)) return null;
  const decimals = Math.max(0, written - (exp ? Number(exp) : 0));
  return { value: number, decimals, unit: (after || before).trim() };
}

/** A value, or a gap (null) where the model wrote none; undefined when it isn't one. */
function readValue(text: string): Reading | null | undefined {
  const s = text.trim();
  if (MISSING.test(s)) return null;
  return parseNumber(s) ?? undefined;
}

/** Labels in a row: `a; b`, `a, b`, or `a b c` when there is no comma. */
function splitLabels(text: string): string[] {
  const s = text.trim();
  const parts = /[;|\t]/.test(s) ? s.split(/\s*[;|\t]\s*/) : s.includes(",") ? s.split(/\s*,\s*/) : s.split(/\s+/);
  return parts.map(plain).filter(Boolean);
}

/**
 * Values in a row: `1, 2`, `1; 2`, `1 | 2`, `1 2 3`. A bare comma (`1,2`)
 * splits only when several values are expected (`many`): alone, it is a
 * decimal comma.
 */
function splitValues(text: string, many: boolean): string[] {
  const s = text.trim().replace(/^\[(.*)\]$/, "$1");
  if (/[;|\t]/.test(s)) return s.split(/\s*[;|\t]\s*/);
  if (/,\s/.test(s)) return s.split(/\s*,\s+/);
  const words = s.split(/\s+/);
  if (words.length > 1 && words.every((w) => readValue(w) !== undefined)) return words;
  if (many && s.includes(",")) return s.split(/\s*,\s*/);
  return [s];
}

interface Row {
  label: string;
  value: string;
}

/** A body line as `key: value`, split at its last colon (or `=`), so `10:30: 5` keeps its label. */
function splitLine(line: string): Row | null {
  const s = line.replace(/^\s*(?:[-*•+]\s+|\d+[.)]\s+)/, "").trim();
  // `Q1 | 1200, 1450` and `label: Q1 | 1200, 1450`, as small models write a
  // row: the label before the bar, the values after it.
  // A label that reads as a number is a row of labels (`label: 2021 | 2022`).
  const bar = /^(?:(?:label|row|item|point)\s*[:=]\s*)?([^|:=]+?)\s*\|\s*(.+)$/i.exec(s);
  if (bar && readValue(bar[1]) === undefined && splitValues(bar[2], true).every((c) => readValue(c) !== undefined)) return { label: bar[1], value: bar[2] };
  const m = /^(.+?)\s*[:=]\s*(.*)$/.exec(s);
  if (!m) return null;
  const last = /^(.+)[:=]\s*(.*)$/.exec(s)!;
  // The first colon for a key (`x: 10:00, 11:00`), the last for a label.
  return { label: m[1], value: m[2], ...(keyLike(m[1]) ? {} : { label: last[1].trim(), value: last[2] }) };
}

const keyLike = (k: string) => {
  const n = keyName(k);
  return UNIT_KEYS.has(n) || SERIES_KEYS.has(n) || X_KEYS.has(n) || TYPE_KEYS.has(n);
};

/** The ```lumo-chart block as a chart, or null when it can't be drawn. */
export function parseChart(title: string, body: string): Chart | null {
  let name = title.trim();
  let kind: ChartKind | null = null;
  const first = /^(\S+)\s*(.*)$/.exec(name);
  // Lowercase, as the syntax has it: `Line count by file` is a title.
  if (first && first[1] === first[1].toLowerCase() && (kind = kindOf(first[1]))) name = first[2].trim();

  let unit = "";
  let seriesNames: string[] | null = null;
  let xLabels: string[] | null = null;
  let xLines = 0;
  const rows: Row[] = [];
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || /^```/.test(line) || /^#/.test(line)) continue;
    const row = splitLine(line);
    if (!row) continue;
    const key = keyName(row.label);
    // A `label:` line of words, not numbers: two of them name no columns.
    if (X_KEYS.has(key) && splitValues(row.value, true).some((c) => readValue(c) === undefined)) xLines++;
    // A key only when its value fits it: `X: 550` (the network) and `Unit: 5` are data.
    const bare = parseNumber(row.value)?.unit === "";
    if (UNIT_KEYS.has(key) && !unit && !bare) unit = plain(row.value);
    else if (TYPE_KEYS.has(key) && kindOf(row.value)) kind = kindOf(row.value);
    else if (SERIES_KEYS.has(key) && !seriesNames && !bare) seriesNames = splitLabels(row.value);
    else if (X_KEYS.has(key) && !xLabels && splitLabels(row.value).length >= MIN_LABELS) xLabels = splitLabels(row.value);
    else rows.push({ label: plain(row.label), value: row.value });
  }

  const readings: (Reading | null)[] = [];
  let labels: string[];
  let series: Series[];
  // One row of labels: two `label:` lines of words (`label: Value for A`,
  // then B) name no columns.
  if (xLines > 1) xLabels = null;
  if (xLabels) {
    // Turned around: a row of labels, then a series per row.
    labels = xLabels;
    series = [];
    for (const row of rows) {
      const cells = splitValues(row.value, true).map(readValue);
      if (cells.some((c) => c === undefined) || cells.every((c) => c === null)) continue;
      const values = labels.map((_, i) => (cells[i] as Reading | null | undefined)?.value ?? NaN);
      readings.push(...(cells.slice(0, labels.length) as (Reading | null)[]));
      series.push({ name: row.label, values });
    }
  } else {
    // Without a `series:` line, as many series as the first row has values, named by number.
    const count = seriesNames?.length || Math.max(1, ...rows.slice(0, 1).map((r) => (parseNumber(r.value) ? 1 : splitValues(r.value, false).length)));
    if (count > MAX_SERIES) return null;
    if (!seriesNames && count > 1) seriesNames = Array.from({ length: count }, (_, i) => String(i + 1));
    labels = [];
    series = Array.from({ length: count }, (_, i) => ({ name: seriesNames?.[i] ?? "", values: [] as number[] }));
    for (const row of rows) {
      const cells = (count > 1 ? splitValues(row.value, true) : [row.value]).map(readValue);
      // A row of gaps keeps its label: the line skips it, the bars leave it empty.
      if (cells.some((c) => c === undefined)) continue;
      labels.push(row.label);
      series.forEach((s, i) => s.values.push((cells[i] as Reading | null | undefined)?.value ?? NaN));
      readings.push(...(cells.slice(0, count) as (Reading | null)[]));
    }
  }

  if (labels.length < MIN_LABELS || labels.length > MAX_LABELS) return null;
  if (!series.length || series.length > MAX_SERIES) return null;
  if (!series.every((s) => s.values.some(Number.isFinite))) return null;

  // A unit written after every value, the same each time, is the chart's unit.
  const read = readings.filter((r): r is Reading => r !== null);
  if (!unit && read.length && read[0].unit && read.every((r) => r.unit === read[0].unit)) unit = read[0].unit;
  const digits = Math.min(4, Math.max(0, ...read.map((r) => r.decimals)));
  return { kind: kind ?? "bar", title: name, unit, labels, series, digits };
}

// ── Numbers ───────────────────────────────────────────────────────────────────

const formats = new Map<string, Intl.NumberFormat>();

function format(options: Intl.NumberFormatOptions, n: number): string {
  const id = `${language()}|${JSON.stringify(options)}`;
  let f = formats.get(id);
  if (!f) {
    try {
      f = new Intl.NumberFormat(language(), options);
    } catch {
      f = new Intl.NumberFormat(undefined, options);
    }
    formats.set(id, f);
  }
  return f.format(n);
}

/** A value with the chart's decimals, in the app's language; very large or small ones in scientific notation. */
export function formatValue(n: number, digits: number): string {
  if (!Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a >= 1e12 || (a > 0 && a < 1e-4)) return minus(format({ notation: "scientific", maximumSignificantDigits: 3 }, n));
  return minus(format({ minimumFractionDigits: digits, maximumFractionDigits: digits }, n));
}

/** The minus sign, not a hyphen: with tabular figures a hyphen sits a figure's width from its number. */
const minus = (s: string) => s.replace(/-/g, "\u2212");

/** The value axis of the line chart: round steps, half a step of room beyond the values, the lines at round numbers. */
export function valueAxis(lo: number, hi: number): { min: number; max: number; ticks: number[]; step: number } {
  // Values a few units in the last place apart (or the same) are one value: a
  // step smaller than that would never move the ticks along.
  if (!(hi - lo > Math.max(Math.abs(lo), Math.abs(hi)) * 1e-12)) {
    const pad = Math.abs(lo) || 1;
    lo -= pad / 2;
    hi += pad / 2;
  }
  const raw = (hi - lo) / 3;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const step = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  const half = step / 2;
  const min = Math.floor((lo - step / 4) / half) * half;
  const max = Math.ceil((hi + step / 4) / half) * half;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9 && ticks.length < 50; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { min, max, ticks, step };
}

/** A tick's number: as many decimals as its step needs (steps are 1, 2 or 5 times a power of ten). */
function tickLabel(v: number, step: number, big: boolean): string {
  if (big) return minus(format({ notation: "compact", maximumFractionDigits: 1 }, v));
  const digits = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
  return minus(format({ minimumFractionDigits: digits, maximumFractionDigits: digits }, v));
}

/** The month names, when the labels are the twelve months' initials or short names in order (G F M A … for Italian). */
export function monthNames(labels: string[]): string[] | null {
  if (labels.length !== 12) return null;
  const names = (lang: string) => {
    try {
      const f = new Intl.DateTimeFormat(lang, { month: "long", timeZone: "UTC" });
      return Array.from({ length: 12 }, (_, i) => f.format(new Date(Date.UTC(2020, i, 1))));
    } catch {
      return null;
    }
  };
  const ours = names(language());
  for (const list of [ours, names("en")]) {
    if (!list) continue;
    const fits = labels.every((l, i) => {
      const s = l.toLocaleLowerCase().replace(/\.$/, "");
      return s.length > 0 && list[i].toLocaleLowerCase().startsWith(s);
    });
    if (fits && ours) return ours.map((n) => n.charAt(0).toLocaleUpperCase(language()) + n.slice(1));
  }
  return null;
}

/** The chart as CSV, a label column then a column per series, numbers with a dot. */
export function chartCsv(chart: Chart): string {
  const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const one = chart.series.length === 1;
  const header = ["", ...chart.series.map((s) => (one ? s.name || chart.unit || chart.title : s.name))];
  const lines = [header.map(cell).join(",")];
  chart.labels.forEach((l, i) => lines.push([cell(l), ...chart.series.map((s) => (Number.isFinite(s.values[i]) ? String(s.values[i]) : ""))].join(",")));
  return lines.join("\n") + "\n";
}

// ── The card ──────────────────────────────────────────────────────────────────

interface View {
  table: boolean;
}

const colorOf = (chart: Chart, i: number) => (chart.series.length === 1 ? ACCENT : SERIES_COLORS[i % SERIES_COLORS.length]);
const swatch = (color: string) => h("i", { class: "rc-chart-sw", style: `background:${color}` });

/**
 * The card: its top line (title, legend or unit, the chart/table switch,
 * copy as CSV), then the bars, the lines or the table. Which one is shown is
 * remembered across the chat's redraws.
 */
export function renderChart(chart: Chart, ctx: RichContext, key: string): HTMLElement {
  const view = remember<View>(key, () => ({ table: false }));
  const many = chart.series.length > 1;
  const legend = many
    ? h("span", { class: "rc-chart-legend", title: chart.series.map((s) => s.name).join(", ") }, ...chart.series.map((s, i) => h("span", {}, swatch(colorOf(chart, i)), h("span", { text: s.name }))))
    : chart.unit
      ? h("span", { class: "rc-chart-unit", text: chart.unit, title: chart.unit })
      : null;
  const chartLabel = t(chart.kind === "line" ? CHART_STRINGS.lines : CHART_STRINGS.bars);
  const chartBtn = h("button", { type: "button", text: chartLabel, title: t(CHART_STRINGS.showChart) });
  const tableBtn = h("button", { type: "button", text: t(CHART_STRINGS.table), title: t(CHART_STRINGS.showTable) });
  const toggle = h("span", { class: "rc-chart-view", role: "group" }, chartBtn, tableBtn);
  const copy = ctx.copyButton(chartCsv(chart));
  const body = h("div", { class: "rc-chart-body" });
  const card = h("div", { class: `rc-card rc-chart rc-chart-${chart.kind}` }, head("chart", chart.title, ctx, legend, toggle, copy), body);

  let built: { chart: HTMLElement | null; table: HTMLElement | null } = { chart: null, table: null };
  const show = () => {
    chartBtn.classList.toggle("on", !view.table);
    tableBtn.classList.toggle("on", view.table);
    chartBtn.setAttribute("aria-pressed", String(!view.table));
    tableBtn.setAttribute("aria-pressed", String(view.table));
    const part = view.table
      ? (built.table ??= renderTable(chart))
      : (built.chart ??= chart.kind === "line" ? renderLines(chart) : renderBars(chart, body));
    body.replaceChildren(part);
  };
  chartBtn.addEventListener("click", () => {
    view.table = false;
    show();
  });
  tableBtn.addEventListener("click", () => {
    view.table = true;
    show();
  });
  show();
  return card;
}

/** The value under the pointer: the label on top, then each series' value in its colour. */
function tooltip(chart: Chart, title: string, i: number): HTMLElement {
  const unit = chart.unit ? ` ${chart.unit}` : "";
  return h(
    "div",
    { class: "rc-chart-tip" },
    h("b", { text: title }),
    ...chart.series.map((s, n) =>
      h("span", {}, swatch(colorOf(chart, n)), s.name ? h("span", { text: s.name }) : null, h("em", { text: formatValue(s.values[i], chart.digits) + unit })),
    ),
  );
}

/**
 * Horizontal bars, one row per label: its name, the bar, its value. The row
 * under the pointer is lit and the others dim (chart.css). With several
 * series each row holds a thin bar per series, and the values show beside
 * the row under the pointer.
 */
function renderBars(chart: Chart, body: HTMLElement): HTMLElement {
  const many = chart.series.length > 1;
  const all = chart.series.flatMap((s) => s.values.filter(Number.isFinite));
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const span = hi - lo || 1;
  const box = h("div", { class: "rc-bars" + (many ? ` many s${chart.series.length}` : "") });
  const unit = chart.unit ? ` ${chart.unit}` : "";
  let tip: HTMLElement | null = null;
  chart.labels.forEach((label, i) => {
    const track = h("span", { class: "rc-brow-track" });
    chart.series.forEach((s, n) => {
      const v = s.values[i];
      const bar = h("i", {});
      if (Number.isFinite(v)) {
        const left = ((Math.min(v, 0) - lo) / span) * 100;
        const width = (Math.abs(v) / span) * 100;
        bar.setAttribute("style", `margin-left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;background:${colorOf(chart, n)}`);
      } else bar.className = "gap";
      track.append(h("span", { class: "rc-brow-lane" }, bar));
    });
    const row = h("div", { class: "rc-brow" }, h("span", { class: "rc-brow-k", text: label, title: label }), track);
    if (!many) row.append(h("span", { class: "rc-brow-v", text: formatValue(chart.series[0].values[i], chart.digits) }));
    else {
      row.setAttribute("aria-label", `${label}: ${chart.series.map((s) => `${s.name} ${formatValue(s.values[i], chart.digits)}${unit}`).join(", ")}`);
      row.addEventListener("pointerenter", () => {
        tip?.remove();
        tip = tooltip(chart, label, i);
        // In the card's body, not in the rows' box: that one scrolls and would clip it.
        body.append(tip);
        place(tip, row, track, i);
      });
      row.addEventListener("pointerleave", () => {
        tip?.remove();
        tip = null;
      });
    }
    box.append(row);
  });

  // Beside the row's longest bar, or before it when there is no room; inside
  // the body when it fits there, from the body's top when it doesn't.
  function place(tip: HTMLElement, row: HTMLElement, track: HTMLElement, i: number) {
    if (typeof track.getBoundingClientRect !== "function") return;
    const b = body.getBoundingClientRect();
    const r = track.getBoundingClientRect();
    const end = Math.max(...chart.series.map((s) => (Number.isFinite(s.values[i]) ? (Math.max(s.values[i], 0) - lo) / span : 0)));
    let left = r.left - b.left + r.width * end + 12;
    if (left + tip.offsetWidth > body.clientWidth - 4) left = Math.max(4, r.left - b.left + r.width * end - 12 - tip.offsetWidth);
    let top = row.getBoundingClientRect().top - b.top - 6;
    top = Math.min(top, body.clientHeight - tip.offsetHeight - 2);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(0, top)}px`;
  }
  return box;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function node(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const el = document.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * The lines: a value axis on the left at round numbers, the labels along
 * the bottom (every other one, or fewer, when they would touch), a line per
 * series. Under the pointer, or with ← → once focused: a dashed line at the
 * nearest label, a dot on each series and their values beside it.
 */
function renderLines(chart: Chart): HTMLElement {
  const H = LINES_HEIGHT;
  const B = 16;
  const T = 6;
  const n = chart.labels.length;
  const all = chart.series.flatMap((s) => s.values.filter(Number.isFinite));
  const axis = valueAxis(Math.min(...all), Math.max(...all));
  const big = Math.max(...axis.ticks.map(Math.abs)) >= 1e4;
  const ticks = axis.ticks.map((v) => ({ v, text: tickLabel(v, axis.step, big) }));
  const L = Math.max(26, Math.max(...ticks.map((t) => t.text.length)) * 5.4 + 10);
  const R = 12;
  const months = monthNames(chart.labels);
  const longest = Math.max(...chart.labels.map((l) => Math.min(l.length, 12)));

  const svgEl = node("svg", { height: H, role: "img", "aria-label": chart.title || chart.labels.join(", ") }) as SVGSVGElement;
  const frame = h("div", { class: "rc-lines", tabindex: 0 });
  frame.append(svgEl);
  let width = 0;
  let hover = -1;
  let tip: HTMLElement | null = null;

  const draw = () => {
    if (width <= 0) return;
    const pw = Math.max(10, width - L - R);
    const ph = H - B - T;
    const X = (i: number) => L + (n > 1 ? (i / (n - 1)) * pw : pw / 2);
    const Y = (v: number) => T + ph - ((v - axis.min) / (axis.max - axis.min)) * ph;
    svgEl.setAttribute("width", String(width));
    svgEl.setAttribute("viewBox", `0 0 ${width} ${H}`);
    const parts: SVGElement[] = [];
    for (const tk of ticks) {
      const y = Y(tk.v).toFixed(1);
      parts.push(node("line", { x1: L, x2: L + pw, y1: y, y2: y, class: tk.v === 0 ? "zero" : "grid" }));
      parts.push(node("text", { x: L - 6, y: Number(y) + 3, "text-anchor": "end" }, tk.text));
    }
    // Labels far enough apart not to touch: every one, every other one…
    const every = Math.max(1, Math.ceil((longest * 5.6 + 8) / (pw / Math.max(1, n - 1))));
    chart.labels.forEach((label, i) => {
      if (i % every && i !== hover) return;
      if (i !== hover && hover >= 0 && Math.abs(i - hover) < every) return;
      const text = label.length > 12 ? label.slice(0, 11) + "…" : label;
      parts.push(node("text", { x: X(i).toFixed(1), y: H - 3, "text-anchor": "middle", class: i === hover ? "on" : "" }, text));
    });
    if (hover >= 0) parts.push(node("line", { x1: X(hover).toFixed(1), x2: X(hover).toFixed(1), y1: T, y2: T + ph, class: "cursor" }));
    chart.series.forEach((s, c) => {
      const color = colorOf(chart, c);
      let d = "";
      let pen = false;
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) {
          pen = false;
          return;
        }
        d += `${pen ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`;
        // A point alone between gaps is a dot.
        if (!pen && !Number.isFinite(s.values[i + 1])) parts.push(node("circle", { cx: X(i).toFixed(1), cy: Y(v).toFixed(1), r: 2, fill: color }));
        pen = true;
      });
      if (d) parts.push(node("path", { d, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    });
    if (hover >= 0) {
      chart.series.forEach((s, c) => {
        const v = s.values[hover];
        if (Number.isFinite(v)) parts.push(node("circle", { cx: X(hover).toFixed(1), cy: Y(v).toFixed(1), r: 4, fill: colorOf(chart, c), class: "dot" }));
      });
    }
    svgEl.replaceChildren(...parts);

    tip?.remove();
    tip = null;
    if (hover < 0) return;
    tip = tooltip(chart, months?.[hover] ?? chart.labels[hover], hover);
    frame.append(tip);
    // Beside the point, on its roomier side; at the first series' value.
    const firstV = chart.series.map((s) => s.values[hover]).find(Number.isFinite) ?? axis.min;
    const fw = frame.clientWidth || width + 12;
    const tw = tip.offsetWidth || 0;
    let left = X(hover) + 24;
    if (left + tw > fw - 4) left = Math.max(4, X(hover) - 12 - tw);
    // Level with the point, within the plot: off the labels along the bottom
    // (the frame's padding puts the plot 8px lower than in the svg).
    const th = tip.offsetHeight || 0;
    const top = Math.max(2, Math.min(Y(firstV) + 2, T + ph + 8 - th));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const at = (clientX: number) => {
    if (typeof svgEl.getBoundingClientRect !== "function" || n < 2) return 0;
    const pw = Math.max(10, width - L - R);
    const x = clientX - svgEl.getBoundingClientRect().left;
    return Math.min(n - 1, Math.max(0, Math.round(((x - L) / pw) * (n - 1))));
  };
  const point = (i: number) => {
    if (i === hover) return;
    hover = i;
    draw();
  };
  frame.addEventListener("pointermove", (e) => point(at((e as PointerEvent).clientX)));
  frame.addEventListener("pointerdown", (e) => point(at((e as PointerEvent).clientX)));
  frame.addEventListener("pointerleave", () => point(-1));
  frame.addEventListener("blur", () => point(-1));
  frame.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.ctrlKey || k.altKey || k.metaKey) return;
    const to = k.key === "ArrowLeft" ? Math.max(0, (hover < 0 ? n : hover) - 1) : k.key === "ArrowRight" ? Math.min(n - 1, hover + 1) : k.key === "Escape" && hover >= 0 ? -1 : null;
    if (to == null) return;
    k.preventDefault();
    k.stopPropagation();
    point(to);
  });

  // Drawn when its width is known or changes; nothing runs in between.
  if (typeof ResizeObserver !== "undefined") {
    onResize(frame, (box) => {
      const w = Math.floor(box.width);
      if (w === width) return;
      width = w;
      draw();
    });
  } else {
    width = 560;
    draw();
  }
  return frame;
}

/**
 * The same numbers as a table. Bars read down (a row per label); lines read
 * across (a column per label, a row per series), as the chart does.
 */
function renderTable(chart: Chart): HTMLElement {
  const many = chart.series.length > 1;
  const num = (v: number) => h("td", { class: "v", text: formatValue(v, chart.digits) });
  const seriesHead = (s: Series, i: number) => h("span", { class: "rc-chart-th" }, swatch(colorOf(chart, i)), h("span", { text: s.name || chart.unit }));
  let table: HTMLElement;
  if (chart.kind === "line") {
    table = h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", {}), ...chart.labels.map((l) => h("th", { class: "v", text: l })))),
      h("tbody", {}, ...chart.series.map((s, i) => h("tr", {}, h("td", { class: "k" }, seriesHead(s, i)), ...s.values.map(num)))),
    );
  } else {
    const headRow = many ? h("thead", {}, h("tr", {}, h("th", {}), ...chart.series.map((s, i) => h("th", { class: "v" }, seriesHead(s, i))))) : null;
    table = h(
      "table",
      {},
      headRow,
      h("tbody", {}, ...chart.labels.map((l, i) => h("tr", {}, h("td", { class: "k", text: l }), ...chart.series.map((s) => num(s.values[i]))))),
    );
  }
  return h("div", { class: "rc-chart-table" + (chart.kind === "line" ? " across" : "") }, table);
}
