// Keeps speech bubbles from covering each other: the bubble of the robot closest to the camera
// (lowest on screen) stays put, the others are lifted just enough to clear what is below them.

/** @typedef {{ id: string, x: number, y: number, w: number, h: number }} Bubble x, y: anchor on screen (bottom centre) */

export const GAP = 6;
const MAX_STEPS = 40;

/**
 * @param {readonly Bubble[]} bubbles
 * @returns {Map<string, number>} upward offset in pixels for each bubble
 */
export function liftBubbles(bubbles) {
  /** @type {Map<string, number>} */
  const offsets = new Map();
  /** @type {Array<{ left: number, right: number, top: number, bottom: number }>} */
  const placed = [];
  const ordered = [...bubbles].sort((a, b) => b.y - a.y || a.x - b.x || a.id.localeCompare(b.id));
  for (const bubble of ordered) {
    let lift = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      const box = { left: bubble.x - bubble.w / 2, right: bubble.x + bubble.w / 2, bottom: bubble.y - lift, top: bubble.y - lift - bubble.h };
      const blocker = placed.find((other) => box.left < other.right + GAP && box.right > other.left - GAP && box.top < other.bottom + GAP && box.bottom > other.top - GAP);
      if (!blocker) break;
      lift += box.bottom - (blocker.top - GAP);
    }
    placed.push({ left: bubble.x - bubble.w / 2, right: bubble.x + bubble.w / 2, bottom: bubble.y - lift, top: bubble.y - lift - bubble.h });
    offsets.set(bubble.id, lift);
  }
  return offsets;
}
