// The icons a project can have (concept progetti v2): simple line icons on a
// 24×24 grid, drawn for Lumo (no library), each with words to find it by in
// the icon picker's search (English and Italian). And the colours an icon
// takes, "" first for none. views/projects.ts draws them.

import { svg } from "./dom";

export const PROJECT_ICONS: Record<string, { d: string; words: string }> = {
  folder: { d: "M3.5 7.5V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5V9.5A1.5 1.5 0 0 0 19 8h-7l-2-2.5H5A1.5 1.5 0 0 0 3.5 7v.5z", words: "files cartella file" },
  code: { d: "M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15", words: "programming software dev codice programmazione" },
  house: { d: "M4 11 12 4l8 7M6 9.5V20h12V9.5M10 20v-5.5h4V20", words: "home casa affitto rent" },
  doc: { d: "M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4M9 12.5h6M9 16h6", words: "document text paper documento testo" },
  bars: { d: "M4.5 20h15M7.5 20v-6M12 20V8M16.5 20v-9", words: "chart stats grafico statistiche" },
  trend: { d: "M4 19.5h16M5 15l4.5-4.5 3.5 3 6-6.5M15 7h4v4", words: "growth chart crescita andamento" },
  book: { d: "M12 6.5c-1.8-1.5-4.5-2-7.5-2v13c3 0 5.7.5 7.5 2 1.8-1.5 4.5-2 7.5-2v-13c-3 0-5.7.5-7.5 2zM12 6.5v13", words: "read study libro leggere studio" },
  flask: { d: "M9.5 3.5h5M10.5 3.5v6L5 18.5a1.3 1.3 0 0 0 1.1 2h11.8a1.3 1.3 0 0 0 1.1-2L13.5 9.5v-6M7.5 15h9", words: "science lab experiment scienza esperimento" },
  bulb: { d: "M9.5 18h5M10.2 20.5h3.6M12 3.5a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.6c0-.8.4-1.5 1-2A6 6 0 0 0 12 3.5z", words: "idea light idea lampadina" },
  star: { d: "M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z", words: "favorite stella preferito" },
  heart: { d: "M12 19.5s-7.5-4.4-7.5-9.7A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.5c0 5.3-7.5 9.7-7.5 9.7z", words: "love health cuore salute" },
  flag: { d: "M5.5 20.5v-16M5.5 4.5h11l-2 4 2 4h-11", words: "goal milestone bandiera traguardo" },
  bug: { d: "M8.5 10a3.5 3.5 0 0 1 7 0v4a3.5 3.5 0 0 1-7 0zM12 10.5v7M8.5 12.5h-4M19.5 12.5h-4M5.5 8l3.2 2M18.5 8l-3.2 2M5.5 18l3.2-2M18.5 18l-3.2-2M10 6.8 8.8 4.5M14 6.8l1.2-2.3", words: "fix error bug errore" },
  mail: { d: "M3.5 6h17v12h-17zM3.5 7l8.5 6.5L20.5 7", words: "email letter posta lettera" },
  calendar: { d: "M4.5 6h15v13.5h-15zM4.5 10h15M8.5 3.5v4M15.5 3.5v4", words: "date plan calendario data" },
  clock: { d: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 7.5V12l3 2", words: "time orologio tempo" },
  camera: { d: "M4 8h3.5l1.5-2.5h6L16.5 8H20v11H4zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z", words: "photo video fotocamera" },
  photo: { d: "M4 5h16v14H4zM4 16l4.5-4.5 4 4 2.5-2.5L20 18M15.5 8.5h.01", words: "image picture immagine foto" },
  music: { d: "M9 18V5.5l11-2V16M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM20 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z", words: "song audio musica canzone" },
  cart: { d: "M3.5 4.5h2l2 10h11l1.5-7H6.5M9.5 19h.01M17 19h.01", words: "shop buy carrello negozio acquisti" },
  case: { d: "M4 8h16v11H4zM9 8V5.5h6V8M4 13h16", words: "work job business lavoro valigetta" },
  people: { d: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19.5c.5-3 2.6-5 5.5-5s5 2 5.5 5M16 11a2.5 2.5 0 1 0 0-5M17 14.5c2 .4 3.3 2.2 3.5 5", words: "team users persone squadra" },
  chat: { d: "M4.5 5.5h15v10h-8l-4.5 3.5v-3.5h-2.5z", words: "message talk messaggio conversazione" },
  terminal: { d: "M4 5h16v14H4zM7.5 9.5 10.5 12l-3 2.5M12.5 15h4", words: "shell console command terminale comando" },
  database: { d: "M12 4c4.1 0 7.5 1.1 7.5 2.5S16.1 9 12 9 4.5 7.9 4.5 6.5 7.9 4 12 4zM4.5 6.5v11c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-11M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5", words: "data sql dati" },
  cloud: { d: "M7.5 18.5a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.6 1.5A3.3 3.3 0 0 1 17 18.5z", words: "server nuvola" },
  sun: { d: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4", words: "day weather sole giorno" },
  moon: { d: "M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z", words: "night luna notte" },
  leaf: { d: "M20 4c-9 0-15 4-15 10 0 3 2 5 5 5 6 0 10-6 10-15zM4 20l9-9", words: "nature green natura foglia" },
  globe: { d: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.4 2.6 3.5 5.4 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.4-3.5-8.5s1.1-5.9 3.5-8.5z", words: "web world site translation mondo sito traduzione" },
  target: { d: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM12 12h.01", words: "goal aim obiettivo bersaglio" },
  key: { d: "M8.5 11.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM11.4 12.6 19 5M15.5 8.5l2.5 2.5", words: "password access chiave accesso" },
  lock: { d: "M6 10.5h12v9.5H6zM8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5", words: "security private sicurezza lucchetto" },
  pin: { d: "M12 20.5s-6-5.6-6-10.5a6 6 0 0 1 12 0c0 4.9-6 10.5-6 10.5zM12 7.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z", words: "place map location luogo mappa" },
  palette: { d: "M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1-1.6-1-2.6 0-.9.7-1.5 1.6-1.5H17a3.5 3.5 0 0 0 3.5-3.5c0-4.3-3.8-7.7-8.5-7.7zM7.5 11.5h.01M9.5 7.8h.01M14.5 7.8h.01M17 11h.01", words: "design art colors arte colori" },
  pencil: { d: "M15.5 4.5l4 4L8.5 19.5h-4v-4zM13.5 6.5l4 4", words: "write edit scrivere modifica matita" },
  gift: { d: "M4.5 9.5h15v3h-15zM6 12.5v7h12v-7M12 9.5v10M12 9.5c-1-3-5-4-5-1.5 0 1.5 5 1.5 5 1.5zM12 9.5c1-3 5-4 5-1.5 0 1.5-5 1.5-5 1.5z", words: "present regalo" },
  cup: { d: "M5 9h11v5.5a4.5 4.5 0 0 1-4.5 4.5h-2A4.5 4.5 0 0 1 5 14.5zM16 10.5h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5v2.5M11.5 3.5v2.5", words: "coffee break caffè tazza" },
  bolt: { d: "M13 3.5 5.5 13.5h6l-1 7 7.5-10h-6z", words: "fast energy power veloce energia" },
  box: { d: "M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9zM4.5 7.5 12 11.5l7.5-4M12 11.5v9", words: "package product pacco scatola prodotto" },
  shield: { d: "M12 3.5 19 6v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6z", words: "security protect sicurezza protezione" },
  cap: { d: "M2.5 9.5 12 5l9.5 4.5L12 14zM6.5 11.5v4.5c1.5 1.5 3.5 2.3 5.5 2.3s4-.8 5.5-2.3v-4.5M21.5 9.5V14", words: "school learn education scuola studio" },
  scales: { d: "M12 4v16M8.5 20h7M5 7h14M5 7l-2.5 6a2.5 2.5 0 0 0 5 0zM19 7l-2.5 6a2.5 2.5 0 0 0 5 0z", words: "law legal contract legge contratto" },
  checklist: { d: "M10.5 6.5h9M10.5 12h9M10.5 17.5h9M4.5 6.5l1.2 1.2 2-2.2M4.5 12l1.2 1.2 2-2.2M4.5 17.5l1.2 1.2 2-2.2", words: "tasks todo list compiti lista" },
  phone: { d: "M7.5 3.5h9v17h-9zM11 17.5h2", words: "mobile app telefono" },
  display: { d: "M3.5 5h17v11h-17zM9 20h6M12 16v4", words: "screen desktop monitor schermo" },
  rocket: { d: "M12 3.5c3 2 4.5 5 4.5 8.5v4h-9v-4c0-3.5 1.5-6.5 4.5-8.5zM7.5 13 5 15.5v3h2.5M16.5 13l2.5 2.5v3h-2.5M10.5 19.5h3M12 9.5h.01", words: "launch start release lancio" },
  broom: { d: "M15.5 3.5 11.5 10M7.5 10h8l1.5 3.5H6zM6 13.5 5 20.5h14l-1-7M10 16.5l-.3 4M14 16.5l.3 4", words: "clean tidy pulizia ordine" },
};

/** The icon a project has until one is chosen. */
export const DEFAULT_ICON = "folder";

/** The colours of the icon picker, "" (none) first. */
export const PROJECT_COLORS = ["", "#9aa0a8", "#f87171", "#fb923c", "#f5b942", "#4ade80", "#2dd4bf", "#60a5fa", "#a78bfa", "#f472b6"];

/** The icon's grey with no colour. */
const PLAIN = "#c8cdd4";

/** The names of the icons that `query` finds, in their order; all of them for an empty query. */
export function findIcons(query: string): string[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return Object.keys(PROJECT_ICONS).filter((name) => {
    const hay = `${name} ${PROJECT_ICONS[name].words}`;
    return words.every((w) => hay.split(" ").some((x) => x.startsWith(w)));
  });
}

/** Icon `name` as an SVG (the default one for a name it does not know). */
export function iconSvg(name: string, size = 14, stroke = 1.8): SVGSVGElement {
  const icon = PROJECT_ICONS[name] ?? PROJECT_ICONS[DEFAULT_ICON];
  const el = svg(icon.d, size, { stroke });
  return el;
}

/** A project's mark: its icon in its colour, on a tint of that colour. */
export function projectMark(icon: string, color: string, size = 30, iconSize = 15): HTMLElement {
  const el = document.createElement("span");
  el.className = "pj-ic";
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.flex = `0 0 ${size}px`;
  el.style.color = color || PLAIN;
  el.style.background = color ? `${color}22` : "rgba(255, 255, 255, 0.07)";
  el.append(iconSvg(icon, iconSize));
  return el;
}

/** The project settings' gear and the pickers' search glass, in the same line. */
export const GEAR_LINE = "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z";
export const SEARCH_LINE = "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5 20 20";
/** A repository: a branch leaving its line (a project's environment). */
export const REPO_LINE = "M6 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6 8v8M18 10v1a4 4 0 0 1-4 4H8";
/** "No icon": a circle struck through (Reset icon and colour). */
export const NONE_LINE = "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM6 6l12 12";
