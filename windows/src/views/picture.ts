// The big picture — a picture of the chat's previews, clicked (views/chat.ts
// sets State.picture). It fills the whole open island, its top bar too, and
// Lumo steps out of its way while it is up (island.ts), or he would sit on
// it. A click anywhere on it, its ×, or Esc closes it; so does leaving the
// chat or closing the island.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { State } from "../core/state";
import { PREVIEW_STRINGS } from "../core/screen";
import { tl } from "../i18n/i18n";

export interface PictureHost {
  el: HTMLElement;
  /** `shown`: the island is open on the chat, where the picture belongs. */
  sync(shown: boolean): void;
}

/** Closes the big picture, if it is up. */
export function closePicture() {
  if (!State.picture) return;
  State.picture = null;
  State.notify();
}

export function buildPicture(): PictureHost {
  const img = h("img", { class: "zoom-img", alt: "", draggable: "false" }) as HTMLImageElement;
  const caption = h("div", { class: "zoom-caption" });
  const close = h("button", { class: "zoom-close", title: tl(PREVIEW_STRINGS.close), "aria-label": tl(PREVIEW_STRINGS.close) },
    svg(ICONS.xmark, 12));
  // The picture joins it only while it is up, so a closed one holds no image.
  const el = h("div", { class: "zoom" }, caption, close);
  el.addEventListener("click", () => closePicture());
  // Before the chat's field and the island see it: Esc closes the picture only.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !State.picture) return;
    e.preventDefault();
    e.stopPropagation();
    closePicture();
  }, true);

  let showing = "";
  return {
    el,
    sync(shown) {
      // Anywhere else than the open chat, it is closed for good.
      if (!shown && State.picture) State.picture = null;
      const pic = State.picture;
      const key = pic ? `${pic.caption}\n${pic.src}` : "";
      if (key === showing) return;
      showing = key;
      if (pic) {
        img.setAttribute("src", pic.src);
        img.alt = pic.caption;
        caption.textContent = pic.caption;
        el.replaceChildren(img, caption, close);
        el.classList.add("open");
      } else {
        el.classList.remove("open");
        el.replaceChildren(caption, close);
        img.removeAttribute("src");
      }
    },
  };
}
