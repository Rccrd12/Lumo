// The island's Email view (views/mail-view.ts): what Rust lists (mail.rs
// mail_view), and how the view sorts, labels and colours it. No DOM here, so
// tests/mail-view.test.mjs runs it as it is.

/** One of the view's buttons: an IMAP account ("imap:1"…) or Outlook on this PC ("outlook"). */
export interface MailViewAccount {
  key: string;
  label: string;
  state: "ok" | "error";
  error?: string;
  /** Unread in its inbox. */
  unread: number;
  /** Where its inbox opens: a webmail Lumo knows (https), Outlook ("lumo-outlook:inbox"), or nowhere. */
  inbox?: string;
}

/** An email in the view, with the account it is of. */
export interface MailViewMessage {
  /** Unique across the accounts: the account's key, then the email's own id. */
  id: string;
  account: string;
  from: string;
  address: string;
  subject: string;
  preview: string;
  body: string;
  date: string;
  link?: string;
  unread: boolean;
}

export interface MailViewData {
  accounts: MailViewAccount[];
  messages: MailViewMessage[];
}

/** "all", or one account's key. */
export type MailFilter = string;
export const ALL: MailFilter = "all";

/**
 * Each address's colour, in the order Settings lists them, and Outlook after:
 * on its button, as the dot on its emails' avatars, beside the address of the
 * email open. Five accounts at most, and Outlook (mail.rs MAX_ACCOUNTS).
 */
export const ACCOUNT_COLORS = ["#60a5fa", "#f472b6", "#a78bfa", "#34d399", "#fbbf24", "#22d3ee"];

export function accountColor(data: MailViewData, key: string): string {
  const i = data.accounts.findIndex((a) => a.key === key);
  return ACCOUNT_COLORS[(i < 0 ? 0 : i) % ACCOUNT_COLORS.length];
}

/**
 * What a button says: the address, or only what is before its "@" once there
 * are four addresses or more, so the row still mostly fits.
 */
export function accountLabel(data: MailViewData, account: MailViewAccount): string {
  if (data.accounts.length < 4 || !account.label.includes("@")) return account.label;
  return account.label.split("@")[0] || account.label;
}

/** The emails a button shows: every account's, or one's. */
export function visibleMessages(data: MailViewData, filter: MailFilter): MailViewMessage[] {
  return filter === ALL ? data.messages : data.messages.filter((m) => m.account === filter);
}

/** The unread of every account that could be read, for All. */
export function totalUnread(data: MailViewData): number {
  return data.accounts.filter((a) => a.state === "ok").reduce((n, a) => n + a.unread, 0);
}

/** A button that is gone (an account removed or paused meanwhile) falls back to All. */
export function keptFilter(data: MailViewData, filter: MailFilter): MailFilter {
  return filter === ALL || data.accounts.some((a) => a.key === filter) ? filter : ALL;
}

/** One or two letters for the avatar: "Ada Lovelace" → "AL", "GitHub" → "G", "ada@x.it" → "A". */
export function initials(from: string, address = ""): string {
  const name = (from || address).replace(/["'<>()]/g, " ").trim();
  if (!name) return "?";
  const words = name.includes("@") && !name.includes(" ") ? [name] : name.split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0] ?? "").join("");
  return letters.toUpperCase() || "?";
}

/** The avatar's colour: always the same for the same sender. */
const AVATAR_COLORS = ["#fbbf24", "#34d399", "#f9a8d4", "#93c5fd", "#fdba74", "#c4b5fd", "#a7f3d0", "#e5e7eb", "#fca5a5", "#86efac"];

export function avatarColor(seed: string): string {
  let hash = 0;
  for (const ch of seed.toLowerCase()) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/**
 * When an email came, as the list says it: the time today, Yesterday
 * (`yesterday`, translated by the caller), the weekday within a week, the
 * day and month before that; "" when the date can't be read.
 */
export function mailWhen(date: string, now: number, lang: string, yesterday: string): string {
  const d = new Date(date);
  if (!date || Number.isNaN(d.getTime())) return "";
  const startOf = (ms: number) => new Date(new Date(ms).toDateString()).getTime();
  const days = Math.round((startOf(now) - startOf(d.getTime())) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return yesterday;
  if (days < 7) return d.toLocaleDateString(lang, { weekday: "short" });
  return d.toLocaleDateString(lang, { day: "numeric", month: "short" });
}

/** The newer and the older email beside `id` in the list shown (for ‹ and ›). */
export function neighbours(list: MailViewMessage[], id: string): { newer: string | null; older: string | null } {
  const i = list.findIndex((m) => m.id === id);
  if (i < 0) return { newer: null, older: null };
  return { newer: list[i - 1]?.id ?? null, older: list[i + 1]?.id ?? null };
}

/** What Rust sent, made safe to draw: unknown fields dropped, the rest strings. */
export function readMailView(raw: unknown): MailViewData {
  const obj = (raw ?? {}) as { accounts?: unknown; messages?: unknown };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const accounts: MailViewAccount[] = (Array.isArray(obj.accounts) ? obj.accounts : [])
    .map((a: Record<string, unknown>) => ({
      key: str(a?.key),
      label: str(a?.label),
      state: a?.state === "error" ? "error" as const : "ok" as const,
      error: str(a?.error) || undefined,
      unread: Math.max(0, Number(a?.unread) || 0),
      inbox: str(a?.inbox) || undefined,
    }))
    .filter((a) => a.key);
  const keys = new Set(accounts.map((a) => a.key));
  const messages: MailViewMessage[] = (Array.isArray(obj.messages) ? obj.messages : [])
    .map((m: Record<string, unknown>) => ({
      id: str(m?.id),
      account: str(m?.account),
      from: str(m?.from),
      address: str(m?.address),
      subject: str(m?.subject),
      preview: str(m?.preview),
      body: str(m?.body),
      date: str(m?.date),
      link: str(m?.link) || undefined,
      unread: m?.unread === true,
    }))
    .filter((m) => m.id && keys.has(m.account));
  return { accounts, messages };
}
