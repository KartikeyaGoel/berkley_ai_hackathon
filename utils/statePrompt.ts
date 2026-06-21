import type { PhysicalObject } from "@/types/topo";

/**
 * Deterministic state-delta compression for the prior-scene prompt.
 *
 * The naive approach resends `JSON.stringify(priorObjects)` on every commit —
 * that grows linearly with scene complexity and repeats every JSON key.
 *
 * Topo instead sends:
 *   - In-view objects (intersecting the changed crop region): full compact row,
 *     because these are the only objects that could plausibly have changed.
 *   - Out-of-view objects: id + label only. Their coordinates are *provably
 *     unchanged* (they're outside the pixels that changed), so we DELETE the
 *     coordinates from the prompt rather than summarizing them.
 *
 * Nothing is paraphrased or summarized — we only delete tokens we can prove are
 * redundant. This mirrors the Token Company "delete, never rewrite" philosophy.
 */

const GRID = 10;
/** Rough char→token ratio for English/JSON; good enough for relative savings. */
const CHARS_PER_TOKEN = 4;
/** Pad the in-view band by 1 grid unit so objects on the crop edge stay in detail. */
const GRID_PAD = 1;

export function approxTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface PriorStatePrompt {
  prompt: string;
  charsSent: number;
  charsNaive: number;
  inViewObjects: number;
  omittedObjects: number;
  /**
   * Objects outside the changed crop. These are carried forward verbatim by the
   * caller — we never ask the LLM to re-place objects it cannot see.
   */
  outViewObjects: PhysicalObject[];
}

function compactRow(o: PhysicalObject): string {
  return `${o.id},${o.label},${o.x},${o.y},${o.z},${o.status}`;
}

interface GridBand {
  gx0: number;
  gy0: number;
  gx1: number;
  gy1: number;
}

/** Map a pixel-space bbox on the normalized frame into 0-10 grid coordinates. */
function bboxToGridBand(
  bbox: { x0: number; y0: number; x1: number; y1: number },
  imageWidth: number,
  imageHeight: number,
): GridBand {
  const w = imageWidth || 1;
  const h = imageHeight || 1;
  return {
    gx0: (bbox.x0 / w) * GRID - GRID_PAD,
    gy0: (bbox.y0 / h) * GRID - GRID_PAD,
    gx1: (bbox.x1 / w) * GRID + GRID_PAD,
    gy1: (bbox.y1 / h) * GRID + GRID_PAD,
  };
}

function inBand(o: PhysicalObject, band: GridBand): boolean {
  return (
    o.x >= band.gx0 && o.x <= band.gx1 && o.y >= band.gy0 && o.y <= band.gy1
  );
}

export function buildPriorStatePrompt(
  priorObjects: PhysicalObject[],
  bbox: { x0: number; y0: number; x1: number; y1: number } | null,
  imageWidth: number,
  imageHeight: number,
): PriorStatePrompt {
  const charsNaive = JSON.stringify(priorObjects).length;

  if (priorObjects.length === 0) {
    const prompt = "prior: none (first frame)";
    return {
      prompt,
      charsSent: prompt.length,
      charsNaive,
      inViewObjects: 0,
      omittedObjects: 0,
      outViewObjects: [],
    };
  }

  // No bbox (first real frame or forceFull): everything is in view, send all rows.
  // Terse CSV beats JSON purely by dropping repeated keys.
  if (!bbox) {
    const rows = priorObjects.map(compactRow).join("\n");
    const prompt = `prior csv[id,label,x,y,z,status]\n${rows}`;
    return {
      prompt,
      charsSent: prompt.length,
      charsNaive,
      inViewObjects: priorObjects.length,
      omittedObjects: 0,
      outViewObjects: [],
    };
  }

  const band = bboxToGridBand(bbox, imageWidth, imageHeight);
  const inView: PhysicalObject[] = [];
  const outView: PhysicalObject[] = [];
  for (const o of priorObjects) {
    (inBand(o, band) ? inView : outView).push(o);
  }

  // Terse, machine-readable, low fixed-overhead. Keys are explained once.
  const lines: string[] = ["prior csv[id,label,x,y,z,status]"];

  lines.push(
    inView.length > 0
      ? `changed-region:\n${inView.map(compactRow).join("\n")}`
      : "changed-region: (none known)",
  );

  if (outView.length > 0) {
    // Coordinates deleted: provably unchanged (outside changed pixels). Keep ids.
    lines.push(`keep-unchanged: ${outView.map((o) => o.id).join(",")}`);
  }

  const prompt = lines.join("\n");
  return {
    prompt,
    charsSent: prompt.length,
    charsNaive,
    inViewObjects: inView.length,
    omittedObjects: outView.length,
    outViewObjects: outView,
  };
}
