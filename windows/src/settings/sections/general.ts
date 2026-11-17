// Settings → General: its rows, Energy and the island's right-click menu. It
// also shows the weekly recap's rows (shortcuts.ts) and the language (island.ts).

import { h } from "../../views/dom";
import { sectionHead, setting } from "../parts";
import { ENERGY_MODES, ENERGY_ON_POWER, effectiveEffort, parseEnergyMode, parseOnPower } from "../../core/energy";
import { MENU_ITEMS, pickedItems, withItem } from "../../core/context-menu";
import { N_, t } from "../../i18n/i18n";
import { languageRow } from "./island";
import { recapRows } from "./shortcuts";
import { onBattery, save, settings, toggle } from "../store";

/** Redraws General → Energy's line about the power source. */
export let energyRedraw: (() => void) | null = null;
// ── General section ───────────────────────────────────────────────────────────

export function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  // The volume as a percentage of its range, beside the bar.
  const percent = h("span", { class: "volume-pct" });
  const showPercent = () => {
    percent.textContent = `${Math.round((Number(volume.value) / 0.2) * 100)}%`;
  };
  showPercent();
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    showPercent();
    void save();
  });

  return h(
    "section",
    {},
    ...sectionHead(t("General")),
    setting(t("Sound"), null,
      volume,
      percent,
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
    ),
    languageRow(),
    setting(t("Launch at startup"), null,
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
    ...energyRows(),
    ...recapRows(),
    ...contextMenuRows(),
  );
}

/** What General → Energy says of the power source, with Automatic. */
const ENERGY_NOW = {
  battery: N_("On battery now: saving energy."),
  realtime: N_("Plugged in now: near real time."),
  usual: N_("Plugged in now: as usual."),
};

/**
 * Settings → General → Energy (core/energy.ts, energy.rs): how hard Lumo
 * works, and with "Automatic" what it does on mains power.
 */
function energyRows(): HTMLElement[] {
  const mode = h("select", {}) as HTMLSelectElement;
  for (const m of ENERGY_MODES) mode.append(h("option", { value: m.id, text: t(m.label) }));
  mode.value = parseEnergyMode(settings.energyMode);
  const onPower = h("select", {}) as HTMLSelectElement;
  for (const m of ENERGY_ON_POWER) onPower.append(h("option", { value: m.id, text: t(m.label) }));
  onPower.value = parseOnPower(settings.energyOnPower);
  const now = h("span", { class: "hint" });
  const powerRow = setting(t("On mains power"), t("with Automatic, what Lumo does while the computer is plugged in; on battery it saves energy"), onPower);
  const redraw = () => {
    const auto = mode.value === "auto";
    powerRow.hidden = !auto;
    const effort = effectiveEffort(mode.value, onPower.value, onBattery);
    now.textContent = !auto ? ""
      : t(onBattery ? ENERGY_NOW.battery : effort === "realtime" ? ENERGY_NOW.realtime : ENERGY_NOW.usual);
  };
  mode.addEventListener("change", () => {
    settings.energyMode = mode.value;
    redraw();
    void save();
  });
  onPower.addEventListener("change", () => {
    settings.energyOnPower = onPower.value;
    redraw();
    void save();
  });
  energyRedraw = redraw;
  redraw();
  return [
    setting(
      t("Energy saving"),
      h("span", {},
        t("How often Lumo checks the inbox, the calendar and the services, and how much he moves on the closed island. Automatic saves energy on battery."),
        h("br"), now),
      mode,
    ),
    powerRow,
  ];
}

/**
 * Settings → General → Right-click menu: what it offers besides Refresh and
 * the text actions, one switch each, in the menu's order.
 */
function contextMenuRows(): HTMLElement[] {
  const items = MENU_ITEMS.map((item) =>
    setting(t(item.label), null, toggle(pickedItems(settings.contextMenu).some((i) => i.id === item.id), (v) => {
      settings.contextMenu = withItem(settings.contextMenu, item.id, v);
      void save();
    })));
  // Named like the other settings of General (Weekly recap…), its switches under it.
  return [
    setting(t("Right-click menu"), t("Pick what the right-click menu on the island offers, besides Refresh (Ctrl+R) and, in a text field, Cut, Copy and Paste.")),
    h("div", { class: "setting-list" }, ...items),
  ];
}
