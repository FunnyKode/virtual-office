// Entry point of the 3D office: SSE stream → seats → robots, beams, HUD.
import * as THREE from 'three';
import { activityOf, displayName } from './logic/activity.js';
import { formatTokens } from './logic/format.js';
import { liftBubbles } from './logic/bubbles.js';
import { DOOR, PODS, assignSeats, pathTo, samePlace } from './logic/layout.js';
import { connectStream, refreshStale } from './logic/stream.js';
import { summarize } from './logic/summary.js';
import { createHud } from './hud.js';
import { Robot } from './scene/robot.js';
import { POD_COLORS, createWorld } from './scene/world.js';

/** @typedef {import('../../src/domain/types.ts').AgentView} AgentView */
/** @typedef {import('./logic/layout.js').Seat} Seat */

const STALE_REFRESH_MS = 30_000;
const container = /** @type {HTMLElement} */ (document.getElementById('scene'));
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
let motionOff = readPreference('mouvements-reduits') ?? motionQuery.matches;
const reducedMotion = () => motionOff;

/** @type {Map<string, Robot>} */
const robots = new Map();
/** @type {Map<string, { mesh: THREE.Mesh, key: string }>} */
const beams = new Map();
/** @type {ReadonlyMap<string, AgentView>} */
let agents = new Map();
/** @type {Map<string, Seat>} */
let seats = new Map();
let silenceMs = 15 * 60_000;
let firstSnapshot = true;

const world = createWorldOrFallback();
const hud = createHud({ onSelect: select, onClose: () => world.requestRender() });

/**
 * Without WebGL (disabled GPU, locked-down browser) the office still works as a live list:
 * the HUD, the alert and the detail panel do not depend on the 3D scene.
 * @returns {ReturnType<typeof createWorld>}
 */
function createWorldOrFallback() {
  try {
    return createWorld(container, { reducedMotion, onFrame });
  } catch (error) {
    console.warn('Bureau 3D indisponible, affichage en liste seule :', error);
    document.body.classList.add('sans-3d');
    const notice = document.createElement('p');
    notice.className = 'verre avis-3d';
    notice.setAttribute('role', 'status');
    notice.textContent = 'La 3D n’est pas disponible dans ce navigateur (WebGL désactivé). Les agents restent suivis en direct dans la liste.';
    document.body.append(notice);
    const scene = new THREE.Scene();
    const noop = () => {};
    return {
      available: false,
      scene,
      camera: new THREE.OrthographicCamera(),
      canvas: document.createElement('canvas'),
      requestRender: noop,
      resetCamera: noop,
      setScreen: noop,
      drawBoard: noop,
      setTour: noop,
      focus: noop,
    };
  }
}

/** @param {string} key */
function readPreference(key) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? null : value === '1';
  } catch {
    return null;
  }
}

/** @param {string} key @param {boolean} value */
function writePreference(key, value) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Private browsing or blocked storage: the preference simply lasts until reload.
  }
}

const accentOf = (/** @type {Seat | undefined} */ seat) => (seat?.kind === 'pod' ? POD_COLORS[seat.pod % POD_COLORS.length] : 0x7a86a8);

// ---------- Stream → scene ----------
const SYNC_BATCH_MS = 100;
/** @type {ReturnType<typeof setTimeout> | null} */
let pendingSync = null;
let beamsDirty = true;
let boardKey = '';

/** Bursts of events (one per tool call) are applied together, at most every 100 ms. */
function scheduleSync() {
  pendingSync ??= setTimeout(() => {
    pendingSync = null;
    sync();
  }, SYNC_BATCH_MS);
}

/**
 * @param {ReadonlyMap<string, Seat>} next
 * @param {ReadonlyMap<string, AgentView>} byId
 */
function placeRobots(next, byId) {
  for (const [id, robot] of robots) {
    if (!next.has(id) && !robot.leaving) robot.leave([...pathTo(robot.group.position, DOOR), { x: DOOR.x, z: DOOR.z + 1 }]);
  }
  for (const [id, seat] of next) {
    const agent = byId.get(id);
    if (!agent) continue;
    let robot = robots.get(id);
    if (!robot) {
      robot = new Robot({ id, kind: agent.kind, accent: accentOf(seat) });
      world.scene.add(robot.group);
      robots.set(id, robot);
      if (firstSnapshot || reducedMotion()) robot.place(seat, seat.face);
      else {
        robot.place(DOOR, Math.PI);
        robot.walk(pathTo(DOOR, seat), seat.face);
      }
    } else if (robot.leaving || !samePlace(seats.get(id), seat)) {
      robot.revive();
      robot.walk(pathTo(robot.group.position, seat), seat.face);
    }
    robot.show(displayName(agent, 34), activityOf(agent));
  }
}

/** @param {ReadonlyMap<string, Seat>} next @param {ReadonlyMap<string, AgentView>} byId @param {ReturnType<typeof summarize>} summary */
function paintRoom(next, byId, summary) {
  for (const [pod] of PODS.entries()) {
    const owner = [...next.entries()].find(([, seat]) => seat.kind === 'pod' && seat.pod === pod && seat.slot === 'desk');
    const agent = owner ? byId.get(owner[0]) : undefined;
    world.setScreen(pod, agent ? activityOf(agent).tone : 'empty');
  }
  /** @type {Array<[string, string, string]>} */
  const cells = [
    ['AU TRAVAIL', String(summary.working), '#4ff0a0'],
    ['AUTORISATIONS', String(summary.waiting.length), summary.waiting.length ? '#ffa43a' : '#7a86a8'],
    ['EN ATTENTE', String(summary.idle + summary.stale), '#9aa1b8'],
    ['JETONS', formatTokens(summary.outputTokens), '#b18cff'],
  ];
  const key = cells.map(([, value]) => value).join('|');
  if (key === boardKey) return; // the wall texture is re-uploaded only when a figure changes
  boardKey = key;
  world.drawBoard(cells);
}

function sync() {
  const now = Date.now();
  const list = [...agents.values()].map((agent) => refreshStale(agent, now, silenceMs));
  const byId = new Map(list.map((agent) => [agent.id, agent]));
  const { seats: next, overflow } = assignSeats(seats, list, now);
  // Counts describe what the office shows; tokens add up every agent active in the last 24 hours.
  const shown = [...next.keys()].flatMap((id) => byId.get(id) ?? []);
  const summary = { ...summarize(shown, now), outputTokens: summarize(list, now).outputTokens };

  if (world.available) {
    placeRobots(next, byId);
    paintRoom(next, byId, summary);
  }
  seats = next;
  firstSnapshot = false;
  beamsDirty = true;
  hud.update(summary, shown, overflow.length, now);
  hud.refresh(byId, now);
  world.requestRender();
}

// ---------- Beams: a session is linked to the subagents seated around it ----------
function updateBeams() {
  const wanted = new Map();
  for (const [id, seat] of seats) {
    const agent = agents.get(id);
    const child = robots.get(id);
    const parent = agent?.parentId ? robots.get(agent.parentId) : undefined;
    if (seat.kind !== 'pod' || seat.slot === 'desk' || !child || !parent || child.moving || parent.moving || child.leaving) continue;
    const from = parent.group.position;
    const to = child.group.position;
    wanted.set(id, { from, to, key: `${from.x},${from.z}>${to.x},${to.z}`, color: accentOf(seat) });
  }
  for (const [id, beam] of beams) {
    if (wanted.get(id)?.key === beam.key) continue;
    beam.mesh.removeFromParent();
    beam.mesh.geometry.dispose();
    /** @type {THREE.Material} */ (beam.mesh.material).dispose();
    beams.delete(id);
  }
  for (const [id, { from, to, key, color }] of wanted) {
    if (beams.has(id)) continue;
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(from.x, 2.0, from.z),
      new THREE.Vector3((from.x + to.x) / 2, 2.9, (from.z + to.z) / 2),
      new THREE.Vector3(to.x, 1.75, to.z),
    );
    const mesh = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 24, 0.025, 6, false),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    world.scene.add(mesh);
    beams.set(id, { mesh, key });
  }
}


// ---------- Per frame ----------
const projected = new THREE.Vector3();

/**
 * @param {number} dt
 * @param {number} time
 * @returns {'moving' | 'ambient' | false}
 */
function onFrame(dt, time) {
  /** @type {'moving' | 'ambient' | false} */
  let need = false;
  for (const [id, robot] of robots) {
    const wasMoving = robot.moving;
    if (robot.update(dt, time, reducedMotion()) === 'gone') {
      robot.dispose();
      robots.delete(id);
      beamsDirty = true;
      continue;
    }
    if (wasMoving && !robot.moving) beamsDirty = true; // a robot reached its seat
    const animation = robot.animation(reducedMotion());
    if (animation === 'moving' || (animation === 'ambient' && need === false)) need = animation;
  }
  if (beamsDirty) {
    beamsDirty = false;
    updateBeams();
  }
  return layoutBubbles() ? 'moving' : need;
}

/** Spreads bubbles so they never overlap; returns true while they are still sliding. */
function layoutBubbles() {
  const bubbles = [];
  for (const robot of robots.values()) {
    robot.label.getWorldPosition(projected).project(world.camera);
    if (projected.z > 1) continue;
    // Measured once per text change (reading sizes forces a layout, so never every frame).
    robot.size ??= robot.bubble.offsetWidth ? { w: robot.bubble.offsetWidth, h: robot.bubble.offsetHeight } : null;
    if (!robot.size) continue;
    bubbles.push({ id: robot.id, x: ((projected.x + 1) / 2) * innerWidth, y: ((1 - projected.y) / 2) * innerHeight, w: robot.size.w, h: robot.size.h });
  }
  const lifts = liftBubbles(bubbles);
  let sliding = false;
  for (const [id, lift] of lifts) sliding = robots.get(id)?.setOffset(lift) || sliding;
  return sliding;
}

// ---------- Interaction ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const DRAG_TOLERANCE_PX = 4;
/** @type {Robot | null} */
let hovered = null;
/** @type {{ x: number, y: number } | null} */
let pressedAt = null;

/** @param {PointerEvent | MouseEvent} event */
function robotUnder(event) {
  pointer.set((event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, world.camera);
  const bodies = [...robots.values()].flatMap((robot) => (robot.leaving ? [] : [robot.body]));
  const id = raycaster.intersectObjects(bodies, true)[0]?.object.userData.robotId;
  return id ? robots.get(id) ?? null : null;
}

world.canvas.addEventListener('pointermove', (event) => {
  const robot = robotUnder(event);
  if (robot === hovered) return;
  if (hovered) hovered.hovered = false;
  hovered = robot;
  if (robot) robot.hovered = true;
  world.canvas.style.cursor = robot ? 'pointer' : 'grab';
  world.requestRender();
});
world.canvas.addEventListener('pointerdown', (event) => {
  pressedAt = { x: event.clientX, y: event.clientY };
});
world.canvas.addEventListener('click', (event) => {
  // The end of a camera drag over a robot is not a click on it.
  const dragged = pressedAt && Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > DRAG_TOLERANCE_PX;
  pressedAt = null;
  if (dragged) return;
  const robot = robotUnder(event);
  if (robot) select(robot.id);
});
world.canvas.addEventListener('dblclick', () => world.resetCamera());

/** @param {string} id */
function select(id) {
  const agent = agents.get(id);
  if (!agent) return;
  hud.open(refreshStale(agent, Date.now(), silenceMs), Date.now());
  const seat = seats.get(id);
  if (seat) world.focus(seat.x, seat.z);
}

const tourButton = /** @type {HTMLButtonElement} */ (document.getElementById('b-tour'));
const motionButton = /** @type {HTMLButtonElement} */ (document.getElementById('b-mouvements'));
let touring = false;
function setTouring(/** @type {boolean} */ on) {
  touring = on && !reducedMotion();
  tourButton.setAttribute('aria-pressed', String(touring));
  world.setTour(touring);
}
function showMotionState() {
  motionButton.setAttribute('aria-pressed', String(motionOff));
  // A camera tour is motion too: unavailable while motion is reduced, and said so.
  tourButton.disabled = motionOff || !world.available;
  tourButton.title = motionOff ? 'Indisponible en mouvements réduits' : 'Raccourci : T';
}
function toggleMotion() {
  motionOff = !motionOff;
  writePreference('mouvements-reduits', motionOff);
  if (motionOff) setTouring(false);
  showMotionState();
  world.requestRender();
}
showMotionState();
tourButton.addEventListener('click', () => setTouring(!touring));
motionButton.addEventListener('click', toggleMotion);
document.getElementById('b-recentrer')?.addEventListener('click', () => world.resetCamera());
addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(event.target.tagName)) return;
  if ((event.key === 't' || event.key === 'T') && !tourButton.disabled) setTouring(!touring);
});

// ---------- Start ----------
const LOADING_TIMEOUT_MS = 8000;
const loading = document.getElementById('chargement');
const hideLoading = () => loading?.remove();
// If the stream never answers, show the (empty, offline) office rather than a loading screen forever.
setTimeout(hideLoading, LOADING_TIMEOUT_MS);

connectStream({
  createSource: (url) => new EventSource(url),
  onAgents: (next, silence) => {
    agents = next;
    silenceMs = silence;
    if (firstSnapshot) sync();
    else scheduleSync();
    hideLoading();
  },
  onConnection: (state) => {
    hud.setConnection(state);
    if (state === 'offline') hideLoading();
  },
});
setInterval(scheduleSync, STALE_REFRESH_MS);

// Read-only handle for debugging and browser checks.
Object.defineProperty(window, '__office', {
  value: Object.freeze({ robots: () => robots.size, agents: () => agents.size, beams: () => beams.size, seats: () => new Map(seats) }),
});
