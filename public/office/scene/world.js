// The office room: renderer, camera, light, furniture, and a render loop that sleeps when nothing moves.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { BENCH_SIZE, BENCH_Z, DOOR, PODS, SATELLITES, benchSeat, podSeat } from '../logic/layout.js';

export const POD_COLORS = [0x6ea8ff, 0xb18cff, 0x4fd6a5, 0xffc15e, 0xff8fa3, 0x5fd3e8];
export const STATUS_COLORS = { working: 0x4ff0a0, waiting: 0xffa43a, idle: 0x7a86a8, stale: 0xb58a3c, ended: 0x5a6070, empty: 0x1c2233 };

const VIEW = 12;
const MAX_FRAME_SECONDS = 0.25;
const AMBIENT_FRAME_MS = 33;
const SMALL_SCREEN = 760;
/** Small screens are usually phones: full pixel density costs more battery than it shows. */
const pixelRatio = () => Math.min(devicePixelRatio, innerWidth < SMALL_SCREEN ? 1 : 2);
const CAMERA_HOME = new THREE.Vector3(20, 19, 23);
const TARGET_HOME = new THREE.Vector3(0, 0.6, 1.2);

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, ...extra });
const glow = (color, intensity = 1.5) => new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: intensity, roughness: 0.5 });

function box(parent, size, material, position, { shadow = true } = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function label(scene, text, x, z) {
  const element = document.createElement('div');
  element.className = 'etiquette-zone';
  element.textContent = text;
  const object = new CSS2DObject(element);
  object.position.set(x, 0.05, z);
  scene.add(object);
}

function buildRoom(scene) {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 22), mat(0x161a26, { roughness: 0.35, metalness: 0.2 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(30, 30, 0x252b3d, 0x1d2231);
  grid.position.y = 0.003;
  scene.add(grid);
  const wall = mat(0x232838, { roughness: 0.9 });
  box(scene, [30, 4, 0.3], wall, [0, 2, -9.6]);
  box(scene, [0.3, 4, 22], wall, [-15, 2, 0]);
  // Windows on the left wall
  for (const z of [-6, -1, 4]) {
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(3, 2), new THREE.MeshBasicMaterial({ color: 0x1b2a4a }));
    pane.position.set(-14.83, 2.3, z);
    pane.rotation.y = Math.PI / 2;
    scene.add(pane);
  }
}

/** Desks, satellite tables and rugs; returns each pod's monitor material so it can show the session state. */
function buildPods(scene) {
  const wood = mat(0x8a6446, { roughness: 0.55 });
  const metal = mat(0x4a5163, { metalness: 0.6, roughness: 0.35 });
  const dark = mat(0x0f1118, { roughness: 0.3, metalness: 0.3 });
  const tableTop = new THREE.CylinderGeometry(0.42, 0.42, 0.05, 28);
  const tableFoot = new THREE.CylinderGeometry(0.05, 0.05, 1.0, 10);
  const tops = new THREE.InstancedMesh(tableTop, wood, PODS.length * SATELLITES);
  const feet = new THREE.InstancedMesh(tableFoot, metal, PODS.length * SATELLITES);
  tops.castShadow = feet.castShadow = true;
  tops.receiveShadow = true;
  const matrix = new THREE.Matrix4();
  const screens = PODS.map((centre, pod) => {
    const color = POD_COLORS[pod % POD_COLORS.length];
    const rug = box(scene, [7, 0.02, 5.4], mat(new THREE.Color(color).multiplyScalar(0.1), { roughness: 0.95 }), [centre.x, 0.011, centre.z + 0.5], { shadow: false });
    rug.receiveShadow = true;
    const edge = glow(color, 0.9);
    for (const [w, d, dx, dz] of [[7, 0.05, 0, -2.2], [7, 0.05, 0, 3.2], [0.05, 5.4, -3.5, 0.5], [0.05, 5.4, 3.5, 0.5]]) box(scene, [w, 0.025, d], edge, [centre.x + dx, 0.024, centre.z + dz], { shadow: false });
    box(scene, [2.3, 0.07, 0.95], wood, [centre.x, 1.0, centre.z]);
    for (const dx of [-1.05, 1.05]) box(scene, [0.07, 1.0, 0.85], metal, [centre.x + dx, 0.5, centre.z]);
    box(scene, [1.1, 0.62, 0.05], dark, [centre.x, 1.45, centre.z - 0.3]);
    const screen = glow(STATUS_COLORS.empty, 0.4);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.02, 0.54), screen);
    plane.position.set(centre.x, 1.45, centre.z - 0.27);
    scene.add(plane);
    for (let slot = 0; slot < SATELLITES; slot++) {
      const seat = podSeat(pod, slot);
      const towardDesk = new THREE.Vector3(centre.x - seat.x, 0, centre.z - seat.z).normalize().multiplyScalar(0.55);
      const index = pod * SATELLITES + slot;
      tops.setMatrixAt(index, matrix.makeTranslation(seat.x + towardDesk.x, 1.0, seat.z + towardDesk.z));
      feet.setMatrixAt(index, matrix.makeTranslation(seat.x + towardDesk.x, 0.5, seat.z + towardDesk.z));
    }
    return screen;
  });
  scene.add(tops, feet);
  return screens;
}

function buildEntrance(scene) {
  const seatMat = mat(0x34406b, { roughness: 0.85 });
  const first = benchSeat(0);
  const last = benchSeat(BENCH_SIZE - 1);
  box(scene, [last.x - first.x + 1.2, 0.35, 0.6], seatMat, [(first.x + last.x) / 2, 0.3, BENCH_Z + 0.75]);
  label(scene, 'SALLE D’ATTENTE', first.x - 0.4, BENCH_Z + 1.5);
  const frame = mat(0x2b3142);
  box(scene, [0.18, 2.8, 0.18], frame, [DOOR.x - 1.1, 1.4, DOOR.z - 0.3]);
  box(scene, [0.18, 2.8, 0.18], frame, [DOOR.x + 1.1, 1.4, DOOR.z - 0.3]);
  box(scene, [2.4, 0.18, 0.18], frame, [DOOR.x, 2.8, DOOR.z - 0.3]);
  const portal = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2.7),
    new THREE.MeshBasicMaterial({ color: 0x7ab8ff, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  portal.position.set(DOOR.x, 1.35, DOOR.z - 0.3);
  scene.add(portal);
}

/** Wall board drawn on a canvas: the office's figures at a glance. */
function buildBoard(scene) {
  const canvas = document.createElement('canvas');
  canvas.width = 1400;
  canvas.height = 420;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  box(scene, [10.4, 3.2, 0.1], mat(0x0f1118), [0, 2.2, -9.42]);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(10.2, 3.06), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  board.position.set(0, 2.2, -9.36);
  scene.add(board);
  /** @param {Array<[string, string, string]>} cells label, value, css colour */
  return function draw(cells) {
    const context = canvas.getContext('2d');
    if (!context) return;
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#0c1424');
    gradient.addColorStop(1, '#151030');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#7ab8ff';
    context.font = '700 40px system-ui, sans-serif';
    context.fillText('BUREAU VIRTUEL', 60, 80);
    const width = (canvas.width - 120) / cells.length;
    cells.forEach(([name, value, colour], index) => {
      const x = 60 + index * width;
      context.fillStyle = 'rgba(255,255,255,.55)';
      context.font = '600 28px system-ui, sans-serif';
      context.fillText(name, x, 190);
      context.fillStyle = colour;
      context.font = '700 96px system-ui, sans-serif';
      context.fillText(value, x, 300);
    });
    texture.needsUpdate = true;
  };
}

/**
 * @param {HTMLElement} container
 * @param {{ reducedMotion: () => boolean, onFrame: (dt: number, time: number) => 'moving' | 'ambient' | false }} options
 *   onFrame says what still needs frames: walking robots ('moving', full rate), animated poses only
 *   ('ambient', about 30 per second), or nothing, which lets the loop sleep
 */
export function createWorld(container, { reducedMotion, onFrame }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.setSize(innerWidth, innerHeight);
  labels.domElement.className = 'calque-etiquettes';
  container.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d14);
  scene.fog = new THREE.Fog(0x0b0d14, 40, 75);
  const aspect = () => innerWidth / innerHeight;
  const camera = new THREE.OrthographicCamera(-VIEW * aspect(), VIEW * aspect(), VIEW, -VIEW, 0.1, 200);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minPolarAngle = 0.3;
  controls.maxPolarAngle = 1.2;
  controls.minZoom = 0.5;
  controls.maxZoom = 3;
  controls.autoRotateSpeed = 0.4;

  scene.add(new THREE.HemisphereLight(0xdbe8ff, 0x3a2c22, 1.5));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.position.set(-10, 18, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -17, right: 17, top: 13, bottom: -13, near: 1, far: 50 });
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  buildRoom(scene);
  const screens = buildPods(scene);
  buildEntrance(scene);
  const drawBoard = buildBoard(scene);

  const timer = new THREE.Timer();
  let running = false;

  let lastDraw = 0;

  /** @param {number} timestamp */
  function frame(timestamp) {
    try {
      timer.update(timestamp);
      // A slow machine renders few frames: let each one cover more time so robots keep real-time speed.
      const dt = Math.min(MAX_FRAME_SECONDS, timer.getDelta());
      const activity = onFrame(dt, performance.now());
      const orbiting = controls.update() || controls.autoRotate;
      if (!activity && !orbiting) stop();
      // Typing arms and pulsing beacons do not need 60 frames a second: spare the battery.
      if (activity === 'ambient' && !orbiting && timestamp - lastDraw < AMBIENT_FRAME_MS) return;
      lastDraw = timestamp;
      renderer.render(scene, camera);
      labels.render(scene, camera);
    } catch (error) {
      // Never leave the loop flagged as running after a failure, or no later change would be drawn.
      stop();
      console.error('Image du bureau en échec :', error);
    }
  }
  function start() {
    if (running || document.hidden) return;
    running = true;
    timer.reset();
    renderer.setAnimationLoop(frame);
  }
  function stop() {
    running = false;
    renderer.setAnimationLoop(null);
  }

  function resetCamera() {
    camera.position.copy(CAMERA_HOME);
    controls.target.copy(TARGET_HOME);
    camera.zoom = innerWidth < SMALL_SCREEN ? 0.62 : 0.95;
    camera.updateProjectionMatrix();
    start();
  }

  controls.addEventListener('change', start);
  addEventListener('resize', () => {
    camera.left = -VIEW * aspect();
    camera.right = VIEW * aspect();
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(innerWidth, innerHeight);
    labels.setSize(innerWidth, innerHeight);
    start();
  });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  resetCamera();

  return {
    available: true,
    scene,
    camera,
    canvas: renderer.domElement,
    /** Wakes the loop after a change; it goes back to sleep on its own. */
    requestRender: start,
    resetCamera,
    /** @param {number} pod @param {keyof typeof STATUS_COLORS} tone */
    setScreen(pod, tone) {
      const screen = screens[pod];
      if (!screen) return;
      screen.emissive.setHex(STATUS_COLORS[tone]);
      screen.emissiveIntensity = tone === 'empty' ? 0.4 : tone === 'idle' ? 0.8 : 1.6;
    },
    drawBoard,
    /** @param {boolean} on */
    setTour(on) {
      controls.autoRotate = on && !reducedMotion();
      start();
    },
    /** Moves the camera target to a point, keeping the current angle. */
    focus(x, z) {
      const shift = new THREE.Vector3(x, TARGET_HOME.y, z).sub(controls.target);
      controls.target.add(shift);
      camera.position.add(shift);
      start();
    },
  };
}
