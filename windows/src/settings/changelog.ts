// Settings → Updates → Changelog: the repository's CHANGELOG.md, built into
// the app (vite.config.ts, `virtual:lumo-changelog`), so it is there offline
// and always matches the build. One entry per `## ` heading, newest first,
// the installed one marked. Drawn from text only, never as HTML.

import { h } from "../views/dom";

export interface ChangelogEntry {
  /** The heading as written: "Windows 0.8.0 — October 15, 2026". */
  title: string;
  /** The heading's version ("0.8.0"), when it has one. */
  version: string | null;
  /** Its date, when the heading has one after a dash. */
  date: string;
  /** Its bullets (`- …`) and plain paragraphs, in order. */
  lines: { kind: "item" | "text"; text: string }[];
}

const VERSION = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/;

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let entry: ChangelogEntry | null = null;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      const title = heading[1].trim();
      const [name, ...rest] = title.split(/\s+[—–-]\s+/);
      entry = {
        title,
        version: VERSION.exec(name)?.[1] ?? null,
        date: rest.join(" — ").trim(),
        lines: [],
      };
      entries.push(entry);
      continue;
    }
    // The file's own title, and anything before the first version.
    if (!entry || !line.trim() || /^#\s/.test(line)) continue;
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) entry.lines.push({ kind: "item", text: item[1].trim() });
    else if (/^\s{2,}\S/.test(line) && entry.lines.length) {
      // A bullet carried on to the next line.
      entry.lines[entry.lines.length - 1].text += ` ${line.trim()}`;
    } else entry.lines.push({ kind: "text", text: line.trim() });
  }
  return entries;
}

/** `**bold**` and `` `code` ``, the only marks the changelog uses; the rest stays text. */
export function inlineParts(text: string): { kind: "text" | "strong" | "code"; text: string }[] {
  const out: { kind: "text" | "strong" | "code"; text: string }[] = [];
  const re = /\*\*([^*]+?)\*\*|`([^`\n]+)`/g;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > at) out.push({ kind: "text", text: text.slice(at, m.index) });
    out.push(m[1] != null ? { kind: "strong", text: m[1] } : { kind: "code", text: m[2] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

function inline(text: string): (string | HTMLElement)[] {
  return inlineParts(text).map((p) =>
    p.kind === "strong" ? h("strong", { text: p.text }) : p.kind === "code" ? h("code", { text: p.text }) : p.text,
  );
}

/**
 * The entries, each folded under its heading; the newest and the installed
 * one start open. `installedLabel` marks the version that runs.
 */
export function changelogList(entries: ChangelogEntry[], installed: string, installedLabel: string): HTMLElement {
  const list = h("div", { class: "changelog" });
  entries.forEach((entry, i) => {
    const mine = entry.version != null && entry.version === installed;
    const name = entry.version ?? entry.title;
    const summary = h("summary", {},
      h("span", { class: "changelog-version", text: name }),
      entry.version && entry.date ? h("span", { class: "changelog-date", text: entry.date }) : null,
      mine ? h("span", { class: "changelog-installed", text: installedLabel }) : null,
    );
    const body = h("div", { class: "changelog-body" });
    let ul: HTMLElement | null = null;
    for (const line of entry.lines) {
      if (line.kind === "item") {
        if (!ul) {
          ul = h("ul", {});
          body.append(ul);
        }
        ul.append(h("li", {}, ...inline(line.text)));
      } else {
        ul = null;
        body.append(h("p", {}, ...inline(line.text)));
      }
    }
    const details = h("details", { class: "changelog-entry" }, summary, body);
    details.open = i === 0 || mine;
    list.append(details);
  });
  return list;
}
