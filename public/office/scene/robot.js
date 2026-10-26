// One agent as a robot. Each robot owns its materials (fading it out never touches the furniture,
// unlike the reference project) and releases them when it leaves. Geometries are shared and kept.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { STATUS_COLORS } from './world.js';

const SPEED = 2.8;
const CLAUDE_CORAL = 0xe8845c;
const SUBAGENT_GREY = 0xc9ced9;

/** Geometries shared by every robot, created on first use. */
let shapes = null;
function sharedShapes() {
  shapes ??= {
    torso: new THREE.CapsuleGeometry(0.28, 0.34, 8, 18),
    head: new THREE.SphereGeometry(0.3, 26, 18),
    visor: new THREE.SphereGeometry(0.255, 26, 14, -1.05, 2.1, 1.0, 1.15),
    eye: new THREE.CapsuleGeometry(0.035, 0.05, 4, 8),
    arm: new THREE.CapsuleGeometry(0.07, 0.3, 4, 10),
    leg: new THREE.CapsuleGeometry(0.08, 0.2, 4, 10),
    chest: new THREE.CircleGeometry(0.09, 20),
    antenna: new THREE.CylinderGeometry(0.012, 0.012, 0.22),
    bulb: new THREE.SphereGeometry(0.055, 12, 12),
    beacon: new THREE.ConeGeometry(0.16, 0.34, 4),
    halo: new THREE.RingGeometry(0.44, 0.52, 40),
  };
  return shapes;
}

export class Robot {
  /**
   * @param {{ id: string, kind: 'session' | 'subagent', accent: number }} options
   */
  constructor({ id, kind, accent }) {
    const s = sharedShapes();
    this.id = id;
    this.kind = kind;
    this.group = new THREE.Group();
    this.group.scale.setScalar(kind === 'subagent' ? 1.0 : 1.25);
    this.body = new THREE.Group();
    this.group.add(this.body);

    this.materials = {
      skin: new THREE.MeshStandardMaterial({ color: kind === 'session' ? CLAUDE_CORAL : SUBAGENT_GREY, roughness: 0.5, metalness: 0.2 }),
      legs: new THREE.MeshStandardMaterial({ color: 0x2b2f3d, roughness: 0.7 }),
      visor: new THREE.MeshPhysicalMaterial({ color: 0x0b0d14, roughness: 0.08, metalness: 0.2, clearcoat: 1 }),
      eyes: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x7df9ff, emissiveIntensity: 2.6 }),
      accent: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: accent, emissiveIntensity: 2 }),
      beacon: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: STATUS_COLORS.waiting, emissiveIntensity: 3, transparent: true }),
      halo: new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false }),
    };
    const m = this.materials;
    const add = (geometry, material, x, y, z, parent = this.body) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.userData.robotId = id;
      parent.add(mesh);
      return mesh;
    };
    add(s.torso, m.skin, 0, 0.74, 0);
    add(s.chest, m.accent, 0, 0.8, 0.282);
    this.head = new THREE.Group();
    this.head.position.y = 1.25;
    this.body.add(this.head);
    add(s.head, m.skin, 0, 0, 0, this.head).scale.set(1.15, 0.92, 1);
    add(s.visor, m.visor, 0, 0, 0.03, this.head).scale.set(1.18, 0.9, 1.05);
    this.eyes = [-0.1, 0.1].map((x) => add(s.eye, m.eyes, x, 0.02, 0.27, this.head));
    add(s.antenna, m.legs, 0, 0.36, 0, this.head);
    add(s.bulb, m.accent, 0, 0.49, 0, this.head);
    this.arms = [-1, 1].map((side) => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.37, 0.94, 0);
      add(s.arm, m.skin, 0, -0.2, 0, pivot);
      this.body.add(pivot);
      return pivot;
    });
    this.legs = [-1, 1].map((side) => add(s.leg, m.legs, side * 0.13, 0.2, 0));
    this.beacon = add(s.beacon, m.beacon, 0, 2.05, 0, this.group);
    this.beacon.rotation.x = Math.PI;
    this.beacon.visible = false;
    this.halo = new THREE.Mesh(s.halo, m.halo);
    this.halo.rotation.x = -Math.PI / 2;
    this.halo.position.y = 0.02;
    this.group.add(this.halo);

    this.bubble = document.createElement('div');
    this.bubble.className = `bulle ${kind}`;
    this.nameLine = document.createElement('div');
    this.nameLine.className = 'bulle-nom';
    this.activityLine = document.createElement('div');
    this.activityLine.className = 'bulle-activite';
    this.bubble.append(this.nameLine, this.activityLine);
    // CSS2DRenderer positions the anchor; the bubble inside is shifted to avoid its neighbours.
    this.anchor = document.createElement('div');
    this.anchor.className = 'ancre';
    this.stem = document.createElement('div');
    this.stem.className = 'tige';
    this.anchor.append(this.stem, this.bubble);
    /** @type {{ w: number, h: number } | null} */
    this.size = null;
    this.offset = 0;
    this.label = new CSS2DObject(this.anchor);
    this.label.position.y = kind === 'subagent' ? 2.15 : 2.3;
    this.group.add(this.label);

    /** @type {THREE.Vector3[]} */
    this.path = [];
    this.face = 0;
    this.tone = 'idle';
    this.alpha = 1;
    this.leaving = false;
    this.hovered = false;
    this.seed = Math.random() * 10;
  }

  /** @param {{ x: number, z: number }} point @param {number} face */
  place(point, face) {
    this.group.position.set(point.x, 0, point.z);
    this.group.rotation.y = face;
    this.face = face;
    this.path = [];
  }

  /** @param {Array<{ x: number, z: number }>} points @param {number} face */
  walk(points, face) {
    this.path = points.map((point) => new THREE.Vector3(point.x, 0, point.z));
    this.face = face;
  }

  /** @param {Array<{ x: number, z: number }>} points */
  leave(points) {
    this.leaving = true;
    this.walk(points, Math.PI);
  }

  /**
   * @param {string} name
   * @param {{ icon: string, label: string, tone: string }} activity
   */
  show(name, activity) {
    const text = `${activity.icon} ${activity.label}`;
    if (this.nameLine.textContent !== name || this.activityLine.textContent !== text) {
      this.nameLine.textContent = name;
      this.activityLine.textContent = text;
      this.size = null; // re-measured on the next layout of bubbles
    }
    this.bubble.dataset.ton = activity.tone;
    this.tone = activity.tone;
    this.beacon.visible = activity.tone === 'waiting';
    const eye = activity.tone === 'waiting' ? STATUS_COLORS.waiting : activity.tone === 'stale' ? STATUS_COLORS.stale : 0x7df9ff;
    this.materials.eyes.emissive.setHex(eye);
  }

  get moving() {
    return this.path.length > 0;
  }

  /**
   * What the robot still needs: full-rate frames while it walks or fades, fewer for an animated pose.
   * @param {boolean} reducedMotion
   * @returns {'moving' | 'ambient' | false}
   */
  animation(reducedMotion) {
    if (this.moving || this.leaving || this.alpha < 1) return 'moving';
    return !reducedMotion && (this.tone === 'working' || this.tone === 'waiting') ? 'ambient' : false;
  }

  /** An agent back while its robot was walking out: the same robot turns around. */
  revive() {
    this.leaving = false;
    this.alpha = 1;
    this.applyAlpha();
  }

  /**
   * @param {number} dt seconds
   * @param {number} time milliseconds
   * @param {boolean} reducedMotion
   * @returns {'gone' | void}
   */
  update(dt, time, reducedMotion) {
    if (reducedMotion && this.path.length) {
      const last = this.path.at(-1);
      if (last) this.group.position.copy(last);
      this.path = [];
    }
    const walking = this.step(dt);
    this.turn(dt, walking);
    this.pose(time * 0.001 + this.seed, walking, reducedMotion);
    if (this.leaving && !walking) {
      this.alpha = Math.max(0, this.alpha - dt * (reducedMotion ? 10 : 1.6));
      this.applyAlpha();
      if (this.alpha === 0) return 'gone';
    }
  }

  step(dt) {
    const target = this.path[0];
    if (!target) return false;
    const delta = target.clone().sub(this.group.position);
    const distance = delta.length();
    const travel = SPEED * dt;
    if (distance <= travel || distance < 0.02) {
      this.group.position.copy(target);
      this.path.shift();
    } else {
      this.group.position.addScaledVector(delta.normalize(), travel);
      this.heading = Math.atan2(delta.x, delta.z);
    }
    return true;
  }

  turn(dt, walking) {
    const aim = walking && this.heading !== undefined ? this.heading : this.face;
    const diff = ((aim - this.group.rotation.y + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this.group.rotation.y += diff * Math.min(1, dt * 8);
  }

  pose(s, walking, reducedMotion) {
    const [left, right] = this.arms;
    const [legL, legR] = this.legs;
    const still = reducedMotion ? 0 : 1;
    this.body.position.y = walking ? Math.abs(Math.sin(s * 11)) * 0.07 : Math.sin(s * 2) * 0.012 * still;
    legL.position.z = walking ? Math.sin(s * 11) * 0.1 : 0;
    legR.position.z = walking ? -Math.sin(s * 11) * 0.1 : 0;
    this.head.rotation.set(0, 0, 0);
    this.beacon.position.y = 2.05 + Math.sin(s * 4) * 0.08 * still;
    this.beacon.rotation.y = s * 2 * still;
    this.materials.halo.opacity = (this.hovered ? 0.85 : this.tone === 'waiting' ? 0.55 : 0.15) * this.alpha;
    if (walking) {
      left.rotation.set(Math.sin(s * 11) * 0.6, 0, 0);
      right.rotation.set(-Math.sin(s * 11) * 0.6, 0, 0);
      return;
    }
    switch (this.tone) {
      case 'working':
        left.rotation.set(-1.1 + Math.sin(s * 18) * 0.18 * still, 0, 0);
        right.rotation.set(-1.1 + Math.cos(s * 16) * 0.18 * still, 0, 0);
        this.head.rotation.y = Math.sin(s * 0.7) * 0.2 * still;
        break;
      case 'waiting':
        left.rotation.set(-0.1, 0, 0);
        right.rotation.set(Math.PI - 0.25, 0, -0.25 + Math.sin(s * 6) * 0.25 * still);
        this.head.rotation.x = -0.15;
        break;
      case 'stale':
        left.rotation.set(-0.05, 0, 0);
        right.rotation.set(-0.05, 0, 0);
        this.head.rotation.x = 0.4;
        break;
      default:
        left.rotation.set(-0.08, 0, 0.05);
        right.rotation.set(-0.08, 0, -0.05);
        this.head.rotation.y = Math.sin(s * 0.4) * 0.3 * still;
    }
  }

  applyAlpha() {
    for (const material of Object.values(this.materials)) {
      if (this.alpha === 1 && material !== this.materials.halo && material !== this.materials.beacon) {
        material.transparent = false;
        material.opacity = 1;
        material.needsUpdate = true;
        continue;
      }
      if (!material.transparent) {
        material.transparent = true;
        material.needsUpdate = true; // switching blending recompiles the shader
      }
      if (material !== this.materials.halo) material.opacity = this.alpha;
    }
    this.anchor.style.opacity = String(this.alpha);
  }

  /**
   * Lifts the bubble towards `offset` pixels (eased); the stem keeps it attached to the robot.
   * @param {number} offset
   * @returns {boolean} true while still sliding
   */
  setOffset(offset) {
    if (this.offset === offset) return false;
    this.offset += (offset - this.offset) * 0.3;
    if (Math.abs(this.offset - offset) < 0.5) this.offset = offset;
    this.bubble.style.transform = `translate(-50%, ${(-this.offset).toFixed(1)}px)`;
    this.stem.style.height = `${Math.max(0, this.offset).toFixed(1)}px`;
    return this.offset !== offset;
  }

  /** Detaches the robot and frees what it owns; shared geometries stay for the next robots. */
  dispose() {
    this.group.removeFromParent();
    this.anchor.remove();
    for (const material of Object.values(this.materials)) material.dispose();
  }
}
