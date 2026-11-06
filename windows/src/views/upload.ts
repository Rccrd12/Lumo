// Drop zone and upload progress. Once the bar is full the file goes straight into
// the chat (island.ts uploadFinished): there is no card asking what to do.

import { h } from "./dom";
import { State } from "../core/state";
import type { ViewHost } from "./views";
import { N_, t, tl, tn } from "../i18n/i18n";
import { fileCells, fileProgress, uploadingLabel } from "../upload/files";

/** Dashed rounded rect drawn as SVG so the dashes can march. */
function dashedFrame(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(ns, "svg");
  el.setAttribute("class", "drop-frame");
  el.setAttribute("preserveAspectRatio", "none");
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", "0.75");
  rect.setAttribute("y", "0.75");
  rect.setAttribute("width", "calc(100% - 1.5px)");
  rect.setAttribute("height", "calc(100% - 1.5px)");
  rect.setAttribute("rx", "20");
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke-width", "1.5");
  rect.setAttribute("stroke-dasharray", "6 5");
  el.append(rect);
  return el;
}

export function buildUpload(): ViewHost {
  const frame = dashedFrame();
  const title = h("div", { class: "drop-title", text: tl("Drop your files here") });
  const tags = h(
    "div",
    { class: "drop-tags" },
    ...[N_("PDF"), N_("Images"), N_("Code"), N_("Docs")].map((chip) => h("span", { text: tl(chip) })),
  );
  const card = h(
    "div",
    { class: "card drop-card" },
    frame,
    h("div", { class: "drop-body" }, title, tags),
  );
  const el = h("div", { class: "view" }, card);

  return {
    el,
    sync() {
      card.classList.toggle("over", State.fileDragOver);
    },
  };
}

export function buildUploading(): ViewHost {
  const label = h("span", { class: "up-name" });
  const percent = h("span", { class: "up-pct" });
  const fill = h("div", { class: "up-fill" });
  const glow = h("div", { class: "up-glow" });
  // Several files dropped together: a small bar each, under the main one.
  const files = h("div", { class: "up-files" });
  const card = h(
    "div",
    { class: "card up-card" },
    h("div", { class: "up-row" }, label, percent),
    h("div", { class: "up-track" }, fill, glow),
    files,
  );
  let filesKey = "";
  let fileFills: { el: HTMLElement; pct: HTMLElement; index: number }[] = [];
  const el = h("div", { class: "view" }, card);

  return {
    el,
    sync() {
      const done = State.uploadProgress >= 0.999;
      const pct = Math.round(State.uploadProgress * 100);
      const names = State.uploadNames.length > 1 ? State.uploadNames : [State.droppedFile?.name ?? t("file")];
      label.textContent = done
        ? `✓  ${names.length > 1 ? tn("{count} file", "{count} files", names.length) : State.droppedFile?.name ?? t("File")}`
        : uploadingLabel(names);
      label.classList.toggle("done", done);
      percent.textContent = done ? "" : `${pct} %`;
      // The track spans the card, as far from either side.
      const along = Math.max(0, Math.min(1, State.uploadProgress)) * 100;
      fill.style.width = `${along}%`;
      glow.style.left = `max(14px, ${along}%)`;
      glow.style.opacity = State.uploadProgress > 0.01 ? "1" : "0";
      card.classList.toggle("done", done);

      const key = names.length > 1 ? names.join("\n") : "";
      if (key !== filesKey) {
        filesKey = key;
        fileFills = [];
        files.replaceChildren(...fileCells(names).map((cell) => {
          if (cell.kind === "more") return h("div", { class: "up-file more", text: `+${cell.count}` });
          const fileFill = h("i");
          const filePct = h("span", { class: "up-file-pct" });
          fileFills.push({ el: fileFill, pct: filePct, index: cell.index });
          return h(
            "div",
            { class: "up-file" },
            h("div", { class: "up-file-row" }, h("span", { class: "up-file-name", text: cell.name, title: cell.name }), filePct),
            h("div", { class: "up-file-track" }, fileFill),
          );
        }));
      }
      for (const { el: fileFill, pct: filePct, index } of fileFills) {
        const p = fileProgress(State.uploadProgress, index, names.length);
        const fileDone = p >= 0.999;
        fileFill.style.width = `${p * 100}%`;
        filePct.textContent = fileDone ? "✓" : `${Math.round(p * 100)} %`;
        filePct.classList.toggle("done", fileDone);
      }
    },
  };
}
