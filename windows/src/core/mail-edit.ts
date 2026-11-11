// An email the AI wants to send, as the user changes it on its card before
// Send (views/mail-editor.ts): who it goes to, its subject, its text, its
// files, and who it is from when there are several accounts. Only what the
// card holds when Send is clicked goes, and mail.rs checks it all again.

import type { OutgoingEmail } from "./state";

/** What a card checks its email against, as mail.rs sends them (card_mail). */
export interface MailLimits {
  recipients: number;
  subject: number;
  body: number;
  files: number;
  bytes: number;
}

/** smtp.rs's own, for a card that came without them. */
export const DEFAULT_MAIL_LIMITS: MailLimits = { recipients: 20, subject: 300, body: 100_000, files: 10, bytes: 18 * 1024 * 1024 };

/** A file on the card: one the AI attached (`index`, its place) or one added with Attach (`path`). */
export interface DraftFile {
  name: string;
  size: number;
  path: string;
  /** Its place among the AI's files; none for a file the user added. */
  index?: number;
}

export interface MailDraft {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  files: DraftFile[];
}

/** What Send carries back when the user changed the email (pipe.rs answer_mail). */
export interface MailRevision {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  /** The AI's files kept, by their place. */
  keep: number[];
  /** The files added with Attach, by path. */
  add: string[];
}

/** One thing that keeps the email from going, for the line under the fields. */
export type MailProblem =
  | { kind: "address"; address: string }
  | { kind: "nobody" }
  | { kind: "people"; count: number }
  | { kind: "noText" }
  | { kind: "tooLong" }
  | { kind: "fileCount"; count: number }
  | { kind: "bytes"; mb: number };

/** The email as the AI wrote it, to start from. */
export function draftOf(email: OutgoingEmail): MailDraft {
  return {
    from: email.from,
    to: [...email.to],
    cc: [...email.cc],
    subject: email.subject,
    body: email.body,
    files: email.attachments.map((f, index) => ({ ...f, index })),
  };
}

/** As smtp.rs valid_address: a plain address Lumo can send to. */
export function validAddress(a: string): boolean {
  const at = a.indexOf("@");
  if (at <= 0) return false;
  const domain = a.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".") && a.length <= 254
    && !domain.includes("@") && /^[\x21-\x7e]+$/.test(a) && !/[<>()[\],;:\\"]/.test(a);
}

/**
 * The addresses typed or pasted in a field: split at commas, semicolons and
 * spaces, and "Name <a@b.it>" taken as the address alone.
 */
export function parseAddresses(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,;]+/)) {
    const named = /<([^<>]*)>/.exec(part);
    const pieces = named ? [named[1]] : part.split(/\s+/);
    for (const p of pieces) {
      const a = p.trim().replace(/^["']+|["']+$/g, "");
      if (a) out.push(a);
    }
  }
  return out;
}

/** `list` with `more` added after it, each address once (any case). */
export function withAddresses(list: string[], more: string[]): string[] {
  const out = [...list];
  for (const a of more) if (!out.some((b) => b.toLowerCase() === a.toLowerCase())) out.push(a);
  return out;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x.toLowerCase() === b[i].toLowerCase());

/** Whether the user changed anything: if not, Send is the plain Allow. */
export function draftChanged(email: OutgoingEmail, d: MailDraft): boolean {
  const kept = d.files.filter((f) => f.index != null);
  return d.from !== email.from
    || !sameList(d.to, email.to) || !sameList(d.cc, email.cc)
    || d.subject !== email.subject || d.body !== email.body
    || kept.length !== email.attachments.length || kept.length !== d.files.length;
}

/** What keeps the email from going, in the order the card says it. */
export function draftProblems(d: MailDraft, limits: MailLimits = DEFAULT_MAIL_LIMITS): MailProblem[] {
  const out: MailProblem[] = [];
  const bad = [...d.to, ...d.cc].find((a) => !validAddress(a));
  if (bad != null) out.push({ kind: "address", address: bad });
  if (!d.to.length) out.push({ kind: "nobody" });
  if (d.to.length + d.cc.length > limits.recipients) out.push({ kind: "people", count: limits.recipients });
  if (!d.body.trim()) out.push({ kind: "noText" });
  if ([...d.subject.trim()].length > limits.subject || new TextEncoder().encode(d.body).length > limits.body) out.push({ kind: "tooLong" });
  if (d.files.length > limits.files) out.push({ kind: "fileCount", count: limits.files });
  if (d.files.reduce((n, f) => n + f.size, 0) > limits.bytes) out.push({ kind: "bytes", mb: Math.round(limits.bytes / (1024 * 1024)) });
  return out;
}

/** What Send carries back for a changed email. */
export function revisionOf(d: MailDraft): MailRevision {
  return {
    from: d.from,
    to: d.to,
    cc: d.cc,
    subject: d.subject,
    body: d.body,
    keep: d.files.flatMap((f) => (f.index != null ? [f.index] : [])),
    add: d.files.flatMap((f) => (f.index == null ? [f.path] : [])),
  };
}

/** Files picked with Attach, added after the others; one already there (same path) is not added twice. */
export function withFiles(d: MailDraft, picked: { name: string; size: number; path: string }[]): MailDraft {
  const files = [...d.files];
  for (const f of picked) {
    if (!f.path || files.some((g) => g.index == null && g.path.toLowerCase() === f.path.toLowerCase())) continue;
    files.push({ name: f.name, size: f.size, path: f.path });
  }
  return { ...d, files };
}
