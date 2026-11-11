// The email an AI wants to send, on its card (views.ts buildApproval): read
// as it came, and changed right there before Send. At rest it looks as the
// card always did; a click on a field turns the card into a form: who it goes
// to as addresses with their ×, Cc, the subject, the text, the files with
// their × and Attach for more, and From when there are several accounts.
// Nothing goes without the Send button; mail.rs checks what comes back.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { formatSize } from "../core/screen";
import { Bridge } from "../core/bridge";
import type { OutgoingEmail } from "../core/state";
import {
  DEFAULT_MAIL_LIMITS, draftChanged, draftOf, draftProblems, parseAddresses, revisionOf, validAddress, withAddresses, withFiles,
  type MailDraft, type MailProblem, type MailRevision,
} from "../core/mail-edit";
import { N_, t } from "../i18n/i18n";

const TEXT = {
  from: N_("From"),
  to: N_("To"),
  cc: N_("Cc"),
  subject: N_("Subject"),
  attachments: N_("Attachments"),
  noSubject: N_("(no subject)"),
  attach: N_("Attach"),
  remove: N_("Remove"),
  add: N_("Add…"),
  hint: N_("Click a field to change it before sending"),
  edited: N_("Edited by you"),
  undo: N_("Undo changes"),
  address: N_("{address} isn't a complete email address"),
  nobody: N_("Add who it goes to"),
  people: N_("At most {count} people, To and Cc together"),
  noText: N_("The email has no text"),
  tooLong: N_("The subject or the text is too long"),
  files: N_("At most {count} files"),
  bytes: N_("The files weigh more than {mb} MB together"),
};

/** What Send does with the card as it is. */
export type MailSend =
  | { kind: "same" }
  | { kind: "changed"; revised: MailRevision }
  | { kind: "blocked" };

export interface MailEditor {
  /** The email itself, in the card's mail slot. */
  el: HTMLElement;
  /** The line beside Send: a hint, "Edited by you · Undo changes", or what keeps it from going. */
  note: HTMLElement;
  /** Attach, at the end of the buttons. */
  attach: HTMLElement;
  /** The card as Send finds it; an address still being typed counts. */
  send(): MailSend;
}

function problemText(p: MailProblem): string {
  switch (p.kind) {
    case "address": return t(TEXT.address, { address: p.address });
    case "nobody": return t(TEXT.nobody);
    case "people": return t(TEXT.people, { count: p.count });
    case "noText": return t(TEXT.noText);
    case "tooLong": return t(TEXT.tooLong);
    case "fileCount": return t(TEXT.files, { count: p.count });
    case "bytes": return t(TEXT.bytes, { mb: p.mb });
  }
}

/**
 * The card's email, editable. `onChange(blocked)` after every change, with
 * whether something keeps it from going (Send is dimmed then).
 */
export function mailEditor(email: OutgoingEmail, onChange: (blocked: boolean) => void): MailEditor {
  const limits = email.limits ?? DEFAULT_MAIL_LIMITS;
  let draft: MailDraft = draftOf(email);
  let ccOpen = false;

  const card = h("div", { class: "mail-card mail-edit" });
  const note = h("span", { class: "mail-note" });
  const editing = () => card.classList.contains("editing");
  const startEditing = () => {
    if (editing()) return;
    card.classList.add("editing");
    update();
  };
  card.addEventListener("focusin", startEditing);

  const pen = () => h("span", { class: "mail-pen", "aria-hidden": "true" }, svg(ICONS.pencil, 11, { stroke: 1.8 }));
  /** A line of the card: its label, what it holds, and a click anywhere on it to edit it. */
  const field = (label: string, value: HTMLElement, focus: () => void, extra?: HTMLElement) => {
    const line = h("div", { class: "mail-line mail-field" }, h("span", { class: "mail-label", text: t(label) }), value, extra ?? null, pen());
    line.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("input, textarea, select, button")) return;
      e.preventDefault();
      startEditing();
      focus();
    });
    return line;
  };

  // ── From ──
  const accounts = email.accounts && email.accounts.length > 1 ? email.accounts : null;
  let fromValue: HTMLElement;
  let fromSelect: HTMLSelectElement | null = null;
  if (accounts) {
    fromSelect = h("select", { class: "mail-input mail-from" }, ...accounts.map((a) => h("option", { value: a, text: a })));
    fromSelect.value = accounts.includes(draft.from) ? draft.from : accounts[0];
    fromSelect.addEventListener("change", () => {
      draft = { ...draft, from: fromSelect!.value };
      update();
    });
    fromValue = h("span", { class: "mail-from-box" }, fromSelect, h("span", { class: "mail-from-arrow", "aria-hidden": "true" }, svg(ICONS.chevronUpDown, 10, { stroke: 2 })));
  } else {
    fromValue = h("span", { class: "mail-value", text: draft.from, title: draft.from });
  }
  const fromLine = field(TEXT.from, fromValue, () => fromSelect?.focus());
  fromLine.hidden = !draft.from;

  // ── To and Cc: each address a chip, and a field for more ──
  const people = (kind: "to" | "cc") => {
    const box = h("div", { class: "mail-value mail-people" });
    const input = h("input", { class: "mail-add", type: "text", spellcheck: "false", autocomplete: "off", placeholder: t(TEXT.add) });
    const list = () => draft[kind];
    const set = (next: string[]) => {
      draft = { ...draft, [kind]: next };
      render();
      update();
    };
    const commit = () => {
      const typed = parseAddresses(input.value);
      input.value = "";
      if (typed.length) set(withAddresses(list(), typed));
    };
    const render = () => {
      clear(box);
      list().forEach((a, i) => {
        const chip = h("span", { class: validAddress(a) ? "mail-chip" : "mail-chip bad", title: a },
          h("span", { class: "mail-chip-text", text: a }),
          h("button", {
            class: "mail-chip-x", title: t(TEXT.remove), "aria-label": `${t(TEXT.remove)} ${a}`,
            onclick: (e: Event) => {
              e.stopPropagation();
              set(list().filter((_, j) => j !== i));
              input.focus();
            },
          }, svg(ICONS.xmark, 8)),
        );
        // A click on an address puts it back in the field, to fix it.
        chip.addEventListener("mousedown", (e) => {
          if ((e.target as HTMLElement).closest(".mail-chip-x")) return;
          e.preventDefault();
          e.stopPropagation();
          // The first click only opens the form.
          if (!editing()) {
            startEditing();
            input.focus();
            return;
          }
          commit();
          const at = list().findIndex((b) => b === a);
          if (at >= 0) set(list().filter((_, j) => j !== at));
          input.value = a;
          input.focus();
          input.select();
        });
        box.append(chip);
      });
      box.append(input);
    };
    input.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === "," || e.key === ";") && input.value.trim()) {
        e.preventDefault();
        commit();
      } else if (e.key === "Enter") {
        e.preventDefault();
      } else if (e.key === "Backspace" && !input.value && list().length) {
        e.preventDefault();
        const last = list()[list().length - 1];
        set(list().slice(0, -1));
        input.value = last;
      }
    });
    input.addEventListener("input", () => {
      // A pasted list goes in at once; a single address waits for Enter, a comma or leaving the field.
      if (/[,;\n]/.test(input.value)) commit();
    });
    input.addEventListener("blur", commit);
    render();
    return { box, input, render, commit };
  };
  const to = people("to");
  const cc = people("cc");
  const ccLink = h("button", { class: "mail-cc-link", text: `+ ${t(TEXT.cc)}`, onclick: (e: Event) => {
    e.stopPropagation();
    ccOpen = true;
    update();
    cc.input.focus();
  } });
  const toLine = field(TEXT.to, to.box, () => to.input.focus(), ccLink);
  const ccLine = field(TEXT.cc, cc.box, () => cc.input.focus());

  // ── Subject ──
  const subject = h("input", { class: "mail-input mail-subject", type: "text", spellcheck: "true", placeholder: t(TEXT.noSubject) });
  subject.value = draft.subject;
  subject.title = draft.subject;
  subject.addEventListener("input", () => {
    draft = { ...draft, subject: subject.value };
    update();
  });
  const subjectLine = field(TEXT.subject, subject, () => subject.focus());

  // ── Files ──
  const files = h("div", { class: "mail-value mail-files" });
  const renderFiles = () => {
    clear(files);
    draft.files.forEach((f, i) => {
      files.append(h("span", { class: "mail-chip mail-file", title: f.path || f.name },
        h("span", { class: "mail-chip-text", text: `${f.name} (${formatSize(f.size)})` }),
        h("button", {
          class: "mail-chip-x", title: t(TEXT.remove), "aria-label": `${t(TEXT.remove)} ${f.name}`,
          onclick: (e: Event) => {
            e.stopPropagation();
            startEditing();
            draft = { ...draft, files: draft.files.filter((_, j) => j !== i) };
            renderFiles();
            update();
          },
        }, svg(ICONS.xmark, 8)),
      ));
    });
  };
  renderFiles();
  const filesLine = field(TEXT.attachments, files, () => {});

  // ── The text ──
  const body = h("textarea", { class: "mail-body", spellcheck: "true" });
  body.value = draft.body;
  body.addEventListener("input", () => {
    draft = { ...draft, body: body.value };
    update();
  });
  // A text longer than the card fades at its foot until it is scrolled to the end.
  const more = () => body.classList.toggle("more", body.scrollTop + body.clientHeight < body.scrollHeight - 2);
  body.addEventListener("scroll", more);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(more).observe(body);

  // ── Attach ──
  let picking = false;
  const attach = h("button", { class: "btn secondary mail-attach", onclick: async () => {
    if (picking) return;
    picking = true;
    try {
      const picked = await Bridge.pickAttachments();
      if (!picked.length) return;
      startEditing();
      draft = withFiles(draft, picked);
      renderFiles();
      update();
    } finally {
      picking = false;
    }
  } }, svg(ICONS.paperclip, 13, { stroke: 1.8 }), h("span", { text: t(TEXT.attach) }));

  const undo = () => {
    draft = draftOf(email);
    ccOpen = false;
    if (fromSelect) fromSelect.value = accounts!.includes(draft.from) ? draft.from : accounts![0];
    subject.value = draft.subject;
    body.value = draft.body;
    to.input.value = "";
    cc.input.value = "";
    to.render();
    cc.render();
    renderFiles();
    card.classList.remove("editing");
    update();
  };

  function update() {
    ccLine.hidden = !draft.cc.length && !ccOpen;
    ccLink.hidden = !ccLine.hidden;
    filesLine.hidden = !draft.files.length;
    card.classList.toggle("has-files", draft.files.length > 0);
    const problems = draftProblems(draft, limits);
    clear(note);
    note.className = "mail-note";
    if (problems.length) {
      note.classList.add("bad");
      note.textContent = problemText(problems[0]);
    } else if (draftChanged(email, draft)) {
      note.classList.add("edited");
      note.append(
        h("span", { text: `${t(TEXT.edited)} · ` }),
        h("button", { class: "mail-undo", text: t(TEXT.undo), onclick: (e: Event) => {
          e.stopPropagation();
          undo();
        } }),
      );
    } else if (!editing()) {
      note.textContent = t(TEXT.hint);
    }
    onChange(problems.length > 0);
  }

  card.append(fromLine, toLine, ccLine, subjectLine, filesLine, body);
  update();

  return {
    el: card,
    note,
    attach,
    send() {
      // An address typed and not yet turned into a chip goes too.
      to.commit();
      cc.commit();
      if (draftProblems(draft, limits).length) {
        startEditing();
        update();
        return { kind: "blocked" };
      }
      return draftChanged(email, draft) ? { kind: "changed", revised: revisionOf(draft) } : { kind: "same" };
    },
  };
}
