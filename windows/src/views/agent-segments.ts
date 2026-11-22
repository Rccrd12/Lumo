// The agents at a glance: a segment each, in the colours of the Agents card
// (views/agents-card.ts), in the card's header and on the closed island
// (island/compact.ts). With many agents a segment each no longer fits
// (concepts/segnale-agenti, 50 agents): past MAX_AGENT_SEGMENTS only those
// still at work have one, and past MAX_AGENT_SEGMENTS at work, how many,
// a number per colour.

import { h } from "./dom";

/** The most segments shown. */
export const MAX_AGENT_SEGMENTS = 8;

/** The looks of an agent that ended. */
const ENDED = new Set(["done", "failed"]);

/** The numbers shown past MAX_AGENT_SEGMENTS at work, in this order: at work, waiting for the user, to check. */
const COUNTED: [string, string[]][] = [["working", ["working", "queued"]], ["waiting", ["waiting"]], ["stalled", ["stalled"]]];

/**
 * One segment per look (`lookOf`, or "queued"), in the agents' order: all of
 * them up to MAX_AGENT_SEGMENTS, else those still at work; more at work than
 * that, a number per colour.
 */
export function agentSegments(looks: string[]): HTMLElement {
  if (looks.length <= MAX_AGENT_SEGMENTS) return segs(looks);
  const open = looks.filter((l) => !ENDED.has(l));
  if (open.length <= MAX_AGENT_SEGMENTS) return segs(open);
  const counts = COUNTED.map(([cls, of]) => [cls, open.filter((l) => of.includes(l)).length] as const).filter(([, n]) => n > 0);
  return h("span", { class: "agents-counts" }, ...counts.map(([cls, n]) => h("span", { class: `agents-count ${cls}` }, h("i"), String(n))));
}

function segs(looks: string[]): HTMLElement {
  return h("span", { class: "agents-segs" }, ...looks.map((l) => h("i", { class: l })));
}
