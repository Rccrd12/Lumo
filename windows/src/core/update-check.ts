// The look at GitHub when Lumo opens (Settings → Updates → Check when Lumo
// opens): one request, a note on the island when a newer Lumo is out, and
// Settings → Updates ready with it, Update now included, when opened next.
// With Beta versions on, a newer beta build is said the same way.
// Nothing is downloaded or installed without a click there.

import type { BetaInfo, UpdateInfo } from "./bridge";

/** Where the island leaves what it found for the Settings page (same origin, own document). */
export const FOUND_KEY = "lumo.update.found";
/** The Settings page shown next time Settings opens (settings/main.ts PAGE_KEY). */
const PAGE_KEY = "lumo.settings.page";
/** Long enough after opening for the greeting to end and the network to be up. */
export const CHECK_DELAY_MS = 8000;
/** The note stays on the island this long. */
export const NOTICE_MS = 30_000;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Something to install: a newer release, or a newer beta build. */
export function hasNewer(info: UpdateInfo | null): boolean {
  return !!info && (info.newer || info.beta?.newer === true);
}

/** Keeps a newer release (or beta) for Settings → Updates, or forgets it when there is none. */
export function rememberFound(info: UpdateInfo | null) {
  const store = storage();
  if (!store) return;
  try {
    if (hasNewer(info)) store.setItem(FOUND_KEY, JSON.stringify(info));
    else store.removeItem(FOUND_KEY);
  } catch {
    // Settings will ask again when clicked.
  }
}

/**
 * The newer release found while `version` runs. One found before an update
 * (another `current`) or that is not newer is stale: none.
 */
export function foundFor(version: string): UpdateInfo | null {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(FOUND_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const info = JSON.parse(raw) as Partial<UpdateInfo>;
    if (typeof info?.latest !== "string" || typeof info.current !== "string") return null;
    if (!version || info.current !== version) return null;
    const beta = betaFrom(info.beta);
    if (info.newer !== true && !beta?.newer) return null;
    return {
      current: info.current,
      latest: info.latest,
      newer: info.newer === true,
      notes: typeof info.notes === "string" ? info.notes : "",
      assetUrl: typeof info.assetUrl === "string" ? info.assetUrl : null,
      currentBeta: info.currentBeta === true,
      beta,
    };
  } catch {
    return null;
  }
}

/** A beta build as it was kept, or null when it does not read as one. */
function betaFrom(value: unknown): BetaInfo | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Partial<BetaInfo>;
  if (typeof b.version !== "string") return null;
  const pulls = (list: unknown) =>
    Array.isArray(list)
      ? list
          .filter((p) => p && typeof p === "object" && typeof p.number === "number")
          .map((p) => ({
            number: p.number as number,
            title: typeof p.title === "string" ? p.title : "",
            updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : "",
            ...(typeof p.with === "string" ? { with: p.with } : {}),
            ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
          }))
      : [];
  return {
    version: b.version,
    newer: b.newer === true,
    publishedAt: typeof b.publishedAt === "string" ? b.publishedAt : "",
    assetUrl: typeof b.assetUrl === "string" ? b.assetUrl : null,
    included: pulls(b.included),
    excluded: pulls(b.excluded),
  };
}

export interface OpenCheck {
  /** Settings → Updates → Check when Lumo opens. */
  enabled: boolean;
  check(): Promise<UpdateInfo>;
  /** Says it on the island: the release's version, or the beta's. */
  notify(latest: string, beta: boolean): void;
  log(line: string): void;
}

/**
 * The check itself: quiet when it is off, when Lumo is up to date and when
 * GitHub cannot be reached (Settings → Updates says why, when clicked).
 * Returns what it found.
 */
export async function checkOnOpen(run: OpenCheck): Promise<UpdateInfo | null> {
  if (!run.enabled) return null;
  let info: UpdateInfo;
  try {
    info = await run.check();
  } catch (err) {
    run.log(`update check on open: ${String(err)}`);
    return null;
  }
  rememberFound(info);
  if (!hasNewer(info)) return info;
  // Settings opens on Updates, with the release and its Update now.
  try {
    storage()?.setItem(PAGE_KEY, "updates");
  } catch {
    // It opens on the page it was on.
  }
  if (info.newer) run.notify(info.latest, false);
  else if (info.beta) run.notify(info.beta.version, true);
  return info;
}
