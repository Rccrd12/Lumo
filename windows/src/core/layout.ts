// Island geometry: the size of each view and where Lumo sits in it. All values
// are logical pixels.

export type IslandMode = "hidden" | "compact" | "expanded";

export type IslandViewName =
  | "overview"
  | "empty"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "upload"
  | "uploading"
  | "prompt"
  | "note"
  | "settings"
  | "greeting"
  | "recap"
  | "wardrobe"
  | "live"
  | "tools";

export type BotStateName =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "sleeping"
  | "dizzy";

export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

export type AgentLayoutMode = "none" | "grid" | "pills" | "column";

export interface ViewLayout {
  height: number;
  botX: number;
  botY: number | null; // null = auto-centred
  botDiameter: number;
  agentMode: AgentLayoutMode;
}

/** The island's zoom range and default — island.rs has the same. */
export const DEFAULT_ISLAND_ZOOM = 1.15;
export const MIN_ISLAND_ZOOM = 0.8;
export const MAX_ISLAND_ZOOM = 1.6;

// No notch on a PC: these are the hidden/compact sizes from docs/SPEC.md.
export const NOTCH_W = 184;
export const NOTCH_H = 32;
export const COMPACT_W = 288; // NOTCH_W + 104
/**
 * Lumo's centre from the compact island's left end: close to it, about as
 * far as he is from its top and bottom.
 */
export const COMPACT_BOT_X = 18;
/**
 * The closed island grows to say something (core/compact.ts), as wide as what
 * it says and no wider, up to these: one live activity, two, more side by
 * side; a new email opens it into a small card. Only on the top and bottom
 * edges; standing upright on a side it stays as it is.
 */
export const COMPACT_SIZES = {
  one: { w: 460, h: NOTCH_H },
  two: { w: 540, h: NOTCH_H },
  many: { w: 620, h: NOTCH_H },
  mail: { w: 452, h: 120 },
  approval: { w: 452, h: 92 },
} as const;
export const EXPANDED_W = 640;
/** The uploading view's track: 36 pt in from either side of the island (views/upload.ts). */
export const UPLOAD_TRACK_INSET = 36;

export const ROUNDED_CORNER = 14; // hidden / compact
/** Between the island and the edge of the screen it is docked to (island.rs EDGE_GAP). */
export const EDGE_GAP = 10;

/**
 * Settings → Island → Distance from the edge (island.rs edge_gap_of): "none";
 * "light", the usual one (EDGE_GAP); "medium", just enough for the cursor to
 * cross the top of the screen above the island without opening it (past the
 * island's 14 px hover margin); "wide".
 */
export function edgeGap(name: string | undefined): number {
  switch (name) {
    case "none": return 0;
    case "medium": return 18;
    case "wide": return 28;
    default: return EDGE_GAP;
  }
}export const EXPANDED_CORNER = 22;

export const VIEW_LAYOUTS: Record<IslandViewName, ViewLayout> = {
  overview: { height: 160, botX: 68, botY: null, botDiameter: 58, agentMode: "pills" },
  empty: { height: 160, botX: 70, botY: null, botDiameter: 62, agentMode: "none" },
  approval: { height: 160, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
  question: { height: 160, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
  error: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  finished: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  // Lumo in the card's top-left corner, where the drop sequence keeps him (upload/sequence.ts USC.REST_X/Y).
  upload: { height: 176, botX: 70, botY: 90, botDiameter: 62, agentMode: "column" },
  // botY 103 = bar top (42 + 58) + 3, so the dot really rides the bar.
  uploading: { height: 176, botX: 46, botY: 103, botDiameter: 20, agentMode: "none" },
  prompt: { height: 160, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
  note: { height: 160, botX: 60, botY: null, botDiameter: 50, agentMode: "column" },
  // The whole Settings page in a frame (views/settings-frame.ts): room for it
  // (the list of sections and the search above it, whole), and Lumo steps
  // aside to leave it the full width. Within island.rs PANEL_H with the widest gap.
  settings: { height: 450, botX: 54, botY: 64, botDiameter: 0, agentMode: "none" },
  greeting: { height: 150, botX: 320, botY: 90, botDiameter: 0, agentMode: "none" },
  // 24 more than the other cards, for the two lines with top agent, project,
  // busiest day, longest session, permissions and questions.
  recap: { height: 184, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  wardrobe: { height: 160, botX: 68, botY: null, botDiameter: 58, agentMode: "none" },
  // A Gemini Live call (views/live.ts): the chat's room, Lumo where he is in it.
  live: { height: 240, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
  // The Tools tab (views/tools.ts): the list, Lumo where he is in the chat.
  tools: { height: 340, botX: 52, botY: null, botDiameter: 44, agentMode: "none" },
};

// The upload views above are only the fallback geometry. Once a file is actually
// dropped the whole sequence — Lumo included — is drawn by src/upload, which
// owns its own constants (USC, upload/sequence.ts).

/** The question view with options to pick from: room for two rows of them. */
export const QUESTION_PICKER_H = 200;

/** The permission card with an email the AI wants to send: room to read it before Send. */
export const EMAIL_CARD_H = 344;

/** Chat view grows with the conversation — IslandContainer.chatPromptHeight. */
export function chatPromptHeight(messageCount: number): number {
  return Math.min(300, 240 + messageCount * 40);
}

export const MIN_ISLAND_W = 560;
export const MAX_ISLAND_W = 1200;
/** A height the user dragged the island to — island.rs clamps it the same. */
export const MIN_ISLAND_H = 160;
export const MAX_ISLAND_H = 640;
/** The chat never gets shorter than this, whatever height was picked. */
const MIN_CHAT_H = 200;
/** The chat's message count while a list (models, past chats, screen) fills it: the most room. */
export const CHAT_PANEL_OPEN = 99;
/** A list open in the chat needs room for its rows and the text field below it. */
const MIN_PANEL_H = 340;
/** The chat's message count while the Listening panel fills it: its rows want more room than a list. */
export const CHAT_LISTENING = 149;
const MIN_LISTENING_H = 440;
/** The chat's message count in the tool workshop, whose panel needs room for its draft and buttons. */
export const CHAT_FORGE = 199;
const MIN_FORGE_H = 440;

/** The display edge the island hangs from. */
export type Dock = "top" | "bottom" | "left" | "right";

export function parseDock(v: unknown): Dock {
  return v === "bottom" || v === "left" || v === "right" ? v : "top";
}

/** On a side the closed island stands upright. */
export function isUpright(dock: Dock): boolean {
  return dock === "left" || dock === "right";
}

/** What the user dragged the grips to: the open island's width, its height (0 = each view's own). */
export interface IslandShape {
  width: number;
  height: number;
}

export const DEFAULT_SHAPE: IslandShape = { width: EXPANDED_W, height: 0 };

export function islandWidth(shape: IslandShape): number {
  return Number.isFinite(shape.width) ? Math.min(MAX_ISLAND_W, Math.max(MIN_ISLAND_W, shape.width)) : EXPANDED_W;
}

/** The picked height, in range, or 0 when none was picked. */
export function pickedHeight(shape: IslandShape): number {
  const h = shape.height;
  if (!Number.isFinite(h) || h <= 0) return 0;
  return Math.min(MAX_ISLAND_H, Math.max(MIN_ISLAND_H, h));
}

/** The chat's height: the one picked, or one that grows with the messages. */
export function chatHeight(shape: IslandShape, messageCount: number): number {
  const picked = pickedHeight(shape);
  const floor = messageCount >= CHAT_FORGE
    ? MIN_FORGE_H
    : messageCount >= CHAT_LISTENING ? MIN_LISTENING_H : messageCount >= CHAT_PANEL_OPEN ? MIN_PANEL_H : MIN_CHAT_H;
  return Math.max(floor, picked > 0 ? picked : chatPromptHeight(messageCount));
}

/** The island's resize grips: its four edges and four corners. */
export type Grip = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const GRIPS: Grip[] = ["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"];

/**
 * How a grip changes the size, given the edge the island hangs from: 2 for a
 * side whose opposite side follows it (the island stays centred), ±1 for a
 * free edge, 0 for a size it leaves alone. Null: that grip is on the docked
 * edge, so it is not offered. island.rs applies the same factors.
 */
export function gripFactors(grip: Grip, dock: Dock): { fx: number; fy: number } | null {
  const sides = grip.split("-");
  if (sides.includes(dock)) return null;
  const across = isUpright(dock);
  let fx = 0;
  let fy = 0;
  for (const side of sides) {
    if (side === "left") fx = across ? -1 : -2;
    if (side === "right") fx = across ? 1 : 2;
    if (side === "top") fy = across ? -2 : -1;
    if (side === "bottom") fy = across ? 2 : 1;
  }
  return { fx, fy };
}

export function islandSize(
  mode: IslandMode,
  view: IslandViewName,
  chatCount = 0,
  shape: IslandShape = DEFAULT_SHAPE,
  dock: Dock = "top",
  peek: { w: number; h: number } | null = null,
): { w: number; h: number } {
  const upright = isUpright(dock);
  switch (mode) {
    case "hidden":
      // No notch to hide inside on a PC: the island retracts into the edge of
      // the screen instead of sitting there as a bar.
      return upright ? { w: 0, h: NOTCH_W } : { w: NOTCH_W, h: 0 };
    case "compact":
      if (upright) return { w: NOTCH_H, h: COMPACT_W };
      return peek ? { w: Math.max(COMPACT_W, peek.w), h: Math.max(NOTCH_H, peek.h) } : { w: COMPACT_W, h: NOTCH_H };
    case "expanded": {
      // The launch greeting is drawn in a fixed 640 × 150 space
      // (character/greeting.ts): a size dragged for the other views would leave it
      // off-centre in a box too big for it.
      if (view === "greeting") return { w: EXPANDED_W, h: VIEW_LAYOUTS.greeting.height };
      const h = view === "prompt"
        ? chatHeight(shape, chatCount)
        : Math.max(VIEW_LAYOUTS[view].height, pickedHeight(shape));
      return { w: islandWidth(shape), h };
    }
  }
}

export interface BotPlacement {
  cx: number;
  cy: number;
  diameter: number;
  opacity: number;
}

/** IslandRootView.botPosition — cy is measured from the island's top edge. */
export function botPosition(
  mode: IslandMode,
  view: IslandViewName,
  islandH: number,
  uploadProgress = 0,
  islandW = EXPANDED_W,
): BotPlacement {
  switch (mode) {
    case "hidden":
      return { cx: 46, cy: 16, diameter: 6, opacity: 0 };
    case "compact":
      return { cx: COMPACT_BOT_X, cy: 16, diameter: 20, opacity: 1 };
    case "expanded": {
      const layout = VIEW_LAYOUTS[view];
      if (view === "uploading") {
        return {
          // Along the track, as wide as the card leaves it (views/upload.ts):
          // a smaller island has a shorter track.
          cx: UPLOAD_TRACK_INSET + uploadProgress * Math.max(0, islandW - 2 * UPLOAD_TRACK_INSET),
          cy: layout.botY ?? 103,
          diameter: layout.botDiameter,
          opacity: 1,
        };
      }
      if (layout.botY != null) {
        return { cx: layout.botX, cy: layout.botY, diameter: layout.botDiameter, opacity: 1 };
      }
      // Centre of the fixed 84 pt card (8 pt top inset + 34 pt header → content at y = 42)
      const headerBottom = 42;
      const cardH = 84;
      const cy = headerBottom + (islandH - headerBottom - cardH) / 2 + cardH / 2;
      return { cx: layout.botX, cy, diameter: layout.botDiameter, opacity: 1 };
    }
  }
}

export function botGlowColor(s: BotStateName): string {
  switch (s) {
    case "working":
      return "#3B9EFF";
    case "thinking":
      return "#A78BFA";
    case "searching":
      return "#6366F1";
    case "approval":
      return "#F5A524";
    case "error":
      return "#F4505E";
    case "finished":
      return "#34D399";
    case "ratelimit":
      return "#F59E0B";
    default:
      return "#FFFFFF";
  }
}

export function botGlowOpacity(s: BotStateName): number {
  switch (s) {
    case "idle":
    case "sleeping":
      return 0.15;
    case "dizzy":
      return 0;
    default:
      return 0.65;
  }
}

// Card wash colours (CardBackground.washColor)
export type Wash = "red" | "green" | "pink" | "amber" | "cyan" | "indigo" | "soft" | null;

export function washRGBA(wash: Wash): string {
  switch (wash) {
    case "red":
      return "rgba(244,80,94,0.55)";
    case "green":
      return "rgba(52,211,153,0.5)";
    case "pink":
      return "rgba(244,114,182,0.55)";
    case "amber":
      return "rgba(245,165,36,0.42)";
    case "cyan":
      return "rgba(34,211,238,0.38)";
    case "indigo":
      return "rgba(99,102,241,0.5)";
    case "soft":
      return "rgba(255,255,255,0.08)";
    default:
      return "rgba(0,0,0,0)";
  }
}

/** The island's size after Ctrl + "+", "-" or "0", or null for any other key. */
export function zoomStep(key: string, current: number): number | null {
  const now = Number.isFinite(current) ? current : DEFAULT_ISLAND_ZOOM;
  const round = (z: number) => Math.round(Math.min(MAX_ISLAND_ZOOM, Math.max(MIN_ISLAND_ZOOM, z)) * 100) / 100;
  if (key === "+" || key === "=") return round(now + 0.1);
  if (key === "-" || key === "_") return round(now - 0.1);
  if (key === "0") return DEFAULT_ISLAND_ZOOM;
  return null;
}
