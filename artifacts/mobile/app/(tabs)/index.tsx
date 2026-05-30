import { GLView } from "expo-gl";
import * as Haptics from "expo-haptics";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Dimensions,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import * as THREE from "three";

// ─── WebGL availability check (web preview may lack WebGL) ───────────────────
function useWebGLAvailable() {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (Platform.OS !== "web") {
      setAvailable(true);
      return;
    }
    try {
      const canvas = document.createElement("canvas");
      const ctx =
        (canvas.getContext("webgl") as WebGLRenderingContext | null) ||
        (canvas.getContext(
          "experimental-webgl"
        ) as WebGLRenderingContext | null);
      setAvailable(!!ctx);
    } catch {
      setAvailable(false);
    }
  }, []);
  return available;
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

// ─── Game Config ─────────────────────────────────────────────────────────────
const CELL = 1;
const BOARD_HALF = 4;
const ROAD_HALF  = BOARD_HALF + 1; // visible road half-width (5 units each side)
const HOP_MS = 160;
const HOP_ARC = 0.55;
const VISIBLE_ROWS = 24;
const SAFE_AHEAD = 8;

function rowKindForIndex(rowIdx: number): "grass" | "road" {
  const cycle = rowIdx % 6;
  if (cycle <= 1) return "grass";
  if (cycle <= 3) return "road";
  if (cycle <= 4) return "grass";
  return "road";
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface CarObj {
  mesh: THREE.Group;
  x: number;
  width: number;
  dir: 1 | -1;
  speed: number;
}

interface RowData {
  rowIdx: number;
  kind: "grass" | "road";
  mesh: THREE.Object3D;
  cars: CarObj[];
}

interface GameStateRef {
  playerX: number;
  playerZ: number;
  playerMesh: THREE.Group | null;
  camera: THREE.PerspectiveCamera | null;
  scene: THREE.Scene | null;
  renderer: THREE.WebGLRenderer | null;
  gl: any;
  rows: RowData[];
  maxRowIdx: number;
  hop: {
    active: boolean;
    fromX: number;
    fromZ: number;
    toX: number;
    toZ: number;
    startMs: number;
  };
  dead: boolean;
  score: number;
  maxScore: number;
  animId: number | null;
}

// ─── Colors ───────────────────────────────────────────────────────────────────
const C = {
  sky: 0x87ceeb,
  horizon: 0xb8e0f7,
  grass: 0x4caf50,
  grassAlt: 0x388e3c,
  sidewalk: 0xd4c5a9,
  curb: 0xb0a090,
  road: 0x424242,
  roadLine: 0xffffff,
  roadCenter: 0xffcc00,
  carColors: [0xe53935, 0x1e88e5, 0x8e24aa, 0xfb8c00, 0x00897b, 0xf4511e],
  chicken: 0xffd700,
  beak: 0xff8c00,
  eye: 0x111111,
  wing: 0xf0c200,
  wheel: 0x212121,
  wheelRim: 0x9e9e9e,
  comb: 0xf44336,
  leg: 0xff9800,
  houseWall: [0xf5deb3, 0xffccbc, 0xe8e0d0, 0xd7ccc8, 0xfff8e1, 0xcfd8dc],
  houseRoof: [0xc62828, 0x6d4c41, 0x37474f, 0x1a237e, 0x880e4f, 0x4e342e],
  door: 0x5d4037,
  doorKnob: 0xffd54f,
  windowGlass: 0x90caf9,
  windowFrame: 0xeeeeee,
  trunk: 0x795548,
  leaf: 0x2e7d32,
  leafAlt: 0x388e3c,
  hedge: 0x33691e,
  chimney: 0x8d6e63,
};

// ─── Shared materials (reused across rows for performance) ───────────────────
const MAT = {
  wheel: new THREE.MeshLambertMaterial({ color: C.wheel }),
  wheelRim: new THREE.MeshLambertMaterial({ color: C.wheelRim }),
  headlight: new THREE.MeshLambertMaterial({ color: 0xffffcc }),
  taillight: new THREE.MeshLambertMaterial({ color: 0xff1111 }),
  glass: new THREE.MeshLambertMaterial({ color: 0x334455, transparent: true, opacity: 0.85 }),
  sidewalk: new THREE.MeshLambertMaterial({ color: C.sidewalk }),
  curb: new THREE.MeshLambertMaterial({ color: C.curb }),
  trunk: new THREE.MeshLambertMaterial({ color: C.trunk }),
  leaf: new THREE.MeshLambertMaterial({ color: C.leaf }),
  leafAlt: new THREE.MeshLambertMaterial({ color: C.leafAlt }),
  hedge: new THREE.MeshLambertMaterial({ color: C.hedge }),
  chimney: new THREE.MeshLambertMaterial({ color: C.chimney }),
};

// ─── Three.js object factories ────────────────────────────────────────────────

function setShadow(obj: THREE.Object3D, cast = true, receive = true) {
  obj.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      child.castShadow = cast;
      child.receiveShadow = receive;
    }
  });
}

/** Cars travel along X. All cars on a row share the same speed → no overlapping. */
function makeCar(dir: 1 | -1, rowZ: number, rowSpeed: number): CarObj {
  const g = new THREE.Group();
  const isTruck = Math.random() < 0.22;
  const len = isTruck ? 2.5 + Math.random() * 0.4 : 1.6 + Math.random() * 0.7;
  const dep = isTruck ? 0.84 : 0.7;
  const colorHex = C.carColors[Math.floor(Math.random() * C.carColors.length)];
  const mat = new THREE.MeshLambertMaterial({ color: colorHex });
  const chromeMat = new THREE.MeshLambertMaterial({ color: 0xcccccc });

  const frontX = dir > 0 ? len / 2 : -(len / 2);
  const backX  = dir > 0 ? -(len / 2) : len / 2;

  if (isTruck) {
    // ── TRUCK ──────────────────────────────────────────────────────────────
    // frame
    const frame = new THREE.Mesh(new THREE.BoxGeometry(len, 0.18, dep), mat);
    frame.position.y = 0.22;
    g.add(frame);
    // cab (front half)
    const cabLen = 1.0;
    const cabX = dir > 0 ? len / 2 - cabLen / 2 : -(len / 2 - cabLen / 2);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(cabLen, 0.62, dep * 0.93), mat);
    cab.position.set(cabX, 0.62, 0);
    g.add(cab);
    // cab windscreen
    const cWind = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.46, dep * 0.75), MAT.glass);
    cWind.position.set(frontX * 0.84, 0.62, 0);
    g.add(cWind);
    // cargo box (rear half)
    const cargoLen = len - cabLen - 0.08;
    const cargoX = dir > 0 ? -(len / 2 - cargoLen / 2) : len / 2 - cargoLen / 2;
    const cargo = new THREE.Mesh(
      new THREE.BoxGeometry(cargoLen, 0.58, dep * 0.92),
      new THREE.MeshLambertMaterial({ color: 0xe0e0e0 })
    );
    cargo.position.set(cargoX, 0.6, 0);
    g.add(cargo);
    // cargo door lines
    const doorLine = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.54, dep * 0.9),
      new THREE.MeshLambertMaterial({ color: 0xaaaaaa })
    );
    doorLine.position.set(dir > 0 ? cargoX + cargoLen * 0.15 : cargoX - cargoLen * 0.15, 0.6, 0);
    g.add(doorLine);
    // exhaust pipe
    const exhaust = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 0.35, 6),
      new THREE.MeshLambertMaterial({ color: 0x555555 })
    );
    exhaust.rotation.z = Math.PI / 2;
    exhaust.position.set(backX * 0.85, 0.55, dep / 2 - 0.1);
    g.add(exhaust);

  } else {
    // ── SEDAN / HATCHBACK ──────────────────────────────────────────────────
    // lower body (full length)
    const lower = new THREE.Mesh(new THREE.BoxGeometry(len, 0.32, dep), mat);
    lower.position.y = 0.22;
    g.add(lower);

    // hood (front) — same height as lower body, adds roof thickness
    const hoodLen = len * 0.3;
    const hoodX = frontX * 0.72;
    const hood = new THREE.Mesh(new THREE.BoxGeometry(hoodLen, 0.1, dep * 0.97), mat);
    hood.position.set(hoodX, 0.43, 0);
    g.add(hood);

    // cabin upper box
    const cabinLen = len * 0.52;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(cabinLen, 0.28, dep * 0.88), mat);
    cabin.position.set(0, 0.66, 0);
    g.add(cabin);

    // trunk (rear)
    const trunkLen = len * 0.28;
    const trunkX = backX * 0.72;
    const trunk = new THREE.Mesh(new THREE.BoxGeometry(trunkLen, 0.1, dep * 0.97), mat);
    trunk.position.set(trunkX, 0.43, 0);
    g.add(trunk);

    // front windscreen (angled feel via thin box)
    const windF = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.3, dep * 0.8), MAT.glass);
    windF.position.set(frontX * 0.66, 0.65, 0);
    g.add(windF);

    // rear window
    const windR = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.26, dep * 0.76), MAT.glass);
    windR.position.set(backX * 0.66, 0.64, 0);
    g.add(windR);

    // side windows (glass strips on both sides of cabin)
    [-dep / 2 - 0.01, dep / 2 + 0.01].forEach((wz2) => {
      const sw = new THREE.Mesh(
        new THREE.BoxGeometry(cabinLen * 0.9, 0.2, 0.04), MAT.glass);
      sw.position.set(0, 0.67, wz2);
      g.add(sw);
    });

    // side mirrors
    [-dep / 2 - 0.07, dep / 2 + 0.07].forEach((mz) => {
      const mirArm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 0.04), mat);
      mirArm.position.set(frontX * 0.62, 0.6, mz);
      g.add(mirArm);
      const mirFace = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.09, 0.08), mat);
      mirFace.position.set(frontX * 0.56, 0.6, mz);
      g.add(mirFace);
    });

    // door crease lines (thin dark strips)
    const creaseMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
    [-dep / 2 - 0.01, dep / 2 + 0.01].forEach((wz2) => {
      const crease = new THREE.Mesh(new THREE.BoxGeometry(len * 0.85, 0.02, 0.04), creaseMat);
      crease.position.set(0, 0.35, wz2);
      g.add(crease);
    });
  }

  // ── SHARED: bumpers, lights, wheels ──────────────────────────────────────

  // front bumper (chrome)
  const bumperF = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.14, dep + 0.06), chromeMat);
  bumperF.position.set(frontX, 0.17, 0);
  g.add(bumperF);
  // rear bumper
  const bumperR = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.14, dep + 0.06), chromeMat);
  bumperR.position.set(backX, 0.17, 0);
  g.add(bumperR);

  // headlights — two rectangular units
  [-dep * 0.28, dep * 0.28].forEach((lz) => {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.16), MAT.headlight);
    hl.position.set(frontX * 0.96, 0.32, lz);
    g.add(hl);
    // DRL strip above headlight
    const drl = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.14), MAT.headlight);
    drl.position.set(frontX * 0.96, 0.46, lz);
    g.add(drl);
  });
  // taillights (red L-shape)
  [-dep * 0.28, dep * 0.28].forEach((lz) => {
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.2), MAT.taillight);
    tl.position.set(backX * 0.96, 0.32, lz);
    g.add(tl);
  });

  // license plates
  const plateMat = new THREE.MeshLambertMaterial({ color: 0xfafafa });
  [frontX, backX].forEach((px) => {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.28), plateMat);
    plate.position.set(px * 0.97, 0.2, 0);
    g.add(plate);
  });

  // ── wheels (tire + rim + 5-spoke hub) ────────────────────────────────────
  const tireG = new THREE.CylinderGeometry(0.17, 0.17, 0.14, 12);
  const rimDiscG = new THREE.CylinderGeometry(0.12, 0.12, 0.02, 10);
  const spokeG = new THREE.BoxGeometry(0.2, 0.03, 0.03);
  const hubG = new THREE.CylinderGeometry(0.04, 0.04, 0.03, 8);

  const wx = (len / 2) * 0.76;
  const wz = dep / 2 + 0.045;

  [[-wx, 0.18, wz], [-wx, 0.18, -wz], [wx, 0.18, wz], [wx, 0.18, -wz]].forEach(
    ([x, y, z]) => {
      // tire
      const tire = new THREE.Mesh(tireG, MAT.wheel);
      tire.rotation.x = Math.PI / 2;
      tire.position.set(x, y, z);
      g.add(tire);
      // rim disc
      const rimDisc = new THREE.Mesh(rimDiscG, MAT.wheelRim);
      rimDisc.rotation.x = Math.PI / 2;
      rimDisc.position.set(x, y, z > 0 ? z + 0.07 : z - 0.07);
      g.add(rimDisc);
      // 5 spokes
      for (let s2 = 0; s2 < 5; s2++) {
        const spoke = new THREE.Mesh(spokeG, MAT.wheelRim);
        spoke.rotation.z = (s2 / 5) * Math.PI * 2;
        spoke.rotation.y = Math.PI / 2;
        spoke.position.set(x, y, z > 0 ? z + 0.075 : z - 0.075);
        g.add(spoke);
      }
      // center hub
      const hub = new THREE.Mesh(hubG, new THREE.MeshLambertMaterial({ color: 0xaaaaaa }));
      hub.rotation.x = Math.PI / 2;
      hub.position.set(x, y, z > 0 ? z + 0.085 : z - 0.085);
      g.add(hub);
    }
  );

  setShadow(g, true, false);
  const startX = dir === 1 ? -(ROAD_HALF + len / 2 + 0.2) : ROAD_HALF + len / 2 + 0.2;
  g.position.set(startX, 0, rowZ);
  return { mesh: g, x: startX, width: len, dir, speed: rowSpeed };
}

/** Pitched roof house with chimney, door, windows, hedge. */
function makeHouse(seed: number): THREE.Group {
  const g = new THREE.Group();
  const wallColor = C.houseWall[seed % C.houseWall.length];
  const roofColor = C.houseRoof[seed % C.houseRoof.length];
  const w = 1.05 + (seed % 3) * 0.2;
  const h = 0.78 + (seed % 2) * 0.26;
  const d = 0.88;

  const wallMat = new THREE.MeshLambertMaterial({ color: wallColor });
  const roofMat = new THREE.MeshLambertMaterial({ color: roofColor });

  // walls
  const walls = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
  walls.position.y = h / 2;
  g.add(walls);

  // pitched roof — two rotated boxes forming a ridge
  const ridgeH = 0.44;
  const rSlope1 = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, ridgeH, 0.06), roofMat);
  rSlope1.rotation.z = -Math.PI / 4;
  rSlope1.position.set(0, h + ridgeH * 0.36, d * 0.25);
  g.add(rSlope1);
  const rSlope2 = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, ridgeH, 0.06), roofMat);
  rSlope2.rotation.z = Math.PI / 4;
  rSlope2.position.set(0, h + ridgeH * 0.36, -d * 0.25);
  g.add(rSlope2);
  // roof fill (solid block under ridge for coverage)
  const roofFill = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.36, d + 0.12), roofMat);
  roofFill.position.set(0, h + 0.12, 0);
  g.add(roofFill);

  // chimney
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.32, 0.18), MAT.chimney);
  chimney.position.set(w * 0.28, h + 0.46, 0);
  g.add(chimney);

  // door
  const doorMat = new THREE.MeshLambertMaterial({ color: C.door });
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.42, 0.05), doorMat);
  door.position.set(0, 0.21, d / 2 + 0.02);
  g.add(door);
  // door knob
  const knob = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.05, 0.04),
    new THREE.MeshLambertMaterial({ color: C.doorKnob })
  );
  knob.position.set(0.09, 0.21, d / 2 + 0.05);
  g.add(knob);

  // windows
  const winMat = new THREE.MeshLambertMaterial({ color: C.windowGlass });
  const frameMat = new THREE.MeshLambertMaterial({ color: C.windowFrame });
  [-w * 0.27, w * 0.27].forEach((wx2, i) => {
    if (i === 0 && w < 1.15) return;
    // frame
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.26, 0.05), frameMat);
    frame.position.set(wx2, h * 0.58, d / 2 + 0.02);
    g.add(frame);
    // glass
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.18, 0.04), winMat);
    glass.position.set(wx2, h * 0.58, d / 2 + 0.04);
    g.add(glass);
  });

  // small hedge in front of house
  const hedge = new THREE.Mesh(new THREE.BoxGeometry(w * 0.85, 0.22, 0.18), MAT.hedge);
  hedge.position.set(0, 0.11, d / 2 + 0.15);
  g.add(hedge);

  setShadow(g, true, true);
  return g;
}

/** Pine / cypress tree. */
function makeTree(seed: number): THREE.Group {
  const g = new THREE.Group();
  const h = 1.1 + (seed % 3) * 0.3;
  const leafMat = seed % 2 === 0 ? MAT.leaf : MAT.leafAlt;

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.12, 0.55, 6),
    MAT.trunk
  );
  trunk.position.y = 0.28;
  g.add(trunk);

  // stacked cones for pine look
  const tiers = 3;
  for (let t = 0; t < tiers; t++) {
    const r = 0.45 - t * 0.1;
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(r, 0.5, 7),
      leafMat
    );
    cone.position.y = 0.62 + t * 0.38;
    g.add(cone);
  }

  setShadow(g, true, true);
  return g;
}

function makeChicken(): THREE.Group {
  const g = new THREE.Group();
  const yMat  = new THREE.MeshLambertMaterial({ color: C.chicken });
  const wMat  = new THREE.MeshLambertMaterial({ color: C.wing });
  const bMat  = new THREE.MeshLambertMaterial({ color: C.beak });
  const eMat  = new THREE.MeshLambertMaterial({ color: C.eye });
  const cMat  = new THREE.MeshLambertMaterial({ color: C.comb });
  const legMat = new THREE.MeshLambertMaterial({ color: C.leg });
  const eyeWhiteMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const bellyMat = new THREE.MeshLambertMaterial({ color: 0xfff8dc }); // cream belly

  // ── BODY — pear-shaped using a sphere scaled taller + slightly wider ──
  const bodyMesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), yMat);
  bodyMesh.scale.set(1.05, 1.25, 1.0);
  bodyMesh.position.y = 0.37;
  g.add(bodyMesh);

  // belly patch (cream, front-facing flat oval)
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 7), bellyMat);
  belly.scale.set(0.85, 1.1, 0.28);
  belly.position.set(0, 0.34, 0.27);
  g.add(belly);

  // ── HEAD — round sphere ──
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.21, 10, 8), yMat);
  headMesh.position.set(0, 0.77, 0.09);
  g.add(headMesh);

  // ── BEAK — orange cone pointing forward ──
  const beakUpper = new THREE.Mesh(new THREE.ConeGeometry(0.065, 0.22, 7), bMat);
  beakUpper.rotation.x = Math.PI / 2;
  beakUpper.position.set(0, 0.78, 0.3);
  g.add(beakUpper);
  // lower jaw (slightly smaller, angled down a touch)
  const beakLower = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.16, 7), bMat);
  beakLower.rotation.x = Math.PI / 2 + 0.25;
  beakLower.position.set(0, 0.735, 0.3);
  g.add(beakLower);

  // ── WATTLE — red teardrop under beak ──
  const wattle = new THREE.Mesh(new THREE.SphereGeometry(0.065, 7, 7), cMat);
  wattle.scale.set(1, 1.45, 1);
  wattle.position.set(0, 0.68, 0.27);
  g.add(wattle);

  // ── EYES — white sphere + dark pupil ──
  [-0.13, 0.13].forEach((ex) => {
    const white = new THREE.Mesh(new THREE.SphereGeometry(0.065, 8, 7), eyeWhiteMat);
    white.position.set(ex, 0.79, 0.2);
    g.add(white);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.038, 7, 6), eMat);
    pupil.position.set(ex * 0.92, 0.79, 0.25);
    g.add(pupil);
    // catch-light dot
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.016, 5, 5), eyeWhiteMat);
    shine.position.set(ex * 0.88 + 0.015, 0.806, 0.265);
    g.add(shine);
  });

  // ── COMB — 3 round bumps on top ──
  [-0.07, 0, 0.07].forEach((cx, i) => {
    const bump = new THREE.Mesh(new THREE.SphereGeometry(0.058 - i * 0.006, 7, 6), cMat);
    bump.scale.y = 1.3;
    bump.position.set(cx, 0.96 + i * 0.01, 0.04);
    g.add(bump);
  });

  // ── TAIL FEATHERS — fan of cones pointing upward/backward ──
  [-0.12, 0, 0.12].forEach((tz, i) => {
    const feather = new THREE.Mesh(new THREE.ConeGeometry(0.065, 0.3, 5), wMat);
    feather.rotation.x = -(Math.PI / 2 + 0.8 + i * 0.07);
    feather.rotation.z = tz * 1.2;
    feather.position.set(tz * 0.5, 0.42 + Math.abs(i - 1) * 0.04, -0.28);
    g.add(feather);
  });

  // ── WINGS — flattened spheres on sides ──
  [-1, 1].forEach((side) => {
    const wing = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 7), wMat);
    wing.scale.set(0.28, 0.72, 1.0);
    wing.rotation.z = side * 0.18;
    wing.position.set(side * 0.31, 0.37, -0.02);
    g.add(wing);
    // primary feather tips
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.2, 5), wMat);
    tip.rotation.z = side * (Math.PI / 2 + 0.15);
    tip.position.set(side * 0.38, 0.22, 0.0);
    g.add(tip);
  });

  // ── LEGS — cylinders with knee joint ──
  [-0.14, 0.14].forEach((lx) => {
    // upper thigh
    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.042, 0.2, 7), legMat);
    thigh.position.set(lx, 0.09, 0.0);
    g.add(thigh);
    // knee bump
    const knee = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 5), legMat);
    knee.position.set(lx, -0.02, 0.02);
    g.add(knee);
    // lower leg (angled slightly forward)
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.028, 0.2, 6), legMat);
    shin.rotation.x = 0.22;
    shin.position.set(lx, -0.13, 0.04);
    g.add(shin);
    // 3 toes
    [-0.065, 0.0, 0.065].forEach((tz2, ti) => {
      const toe = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.012, 0.14, 5), legMat);
      toe.rotation.x = Math.PI / 2;
      toe.rotation.z = (ti - 1) * 0.35;
      toe.position.set(lx + (ti - 1) * 0.04, -0.24, 0.09 + tz2 * 0.3);
      g.add(toe);
    });
    // rear toe
    const rearToe = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.01, 0.1, 5), legMat);
    rearToe.rotation.x = -Math.PI / 2;
    rearToe.position.set(lx, -0.24, -0.06);
    g.add(rearToe);
  });

  setShadow(g, true, false);
  return g;
}

/** Grass row — houses or trees on sides plus sidewalk strip. */
function makeGrassRow(rowIdx: number): THREE.Group {
  const g = new THREE.Group();

  // ground
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(BOARD_HALF * 2 + 6, 0.18, CELL),
    new THREE.MeshLambertMaterial({
      color: rowIdx % 2 === 0 ? C.grass : C.grassAlt,
    })
  );
  base.position.y = -0.09;
  base.receiveShadow = true;
  g.add(base);

  // narrow sidewalk strip outside play area on each side
  [-1, 1].forEach((side) => {
    const sw = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.14, CELL), MAT.sidewalk);
    sw.position.set(side * (BOARD_HALF + 0.36), -0.02, 0);
    sw.receiveShadow = true;
    g.add(sw);
  });

  // decorations per side
  if (rowIdx > 0) {
    [
      { side: -1, seed: rowIdx * 2 },
      { side: 1, seed: rowIdx * 2 + 1 },
    ].forEach(({ side, seed }) => {
      const useTree = seed % 3 === 0; // every third slot is a tree
      const obj = useTree ? makeTree(seed) : makeHouse(seed);
      obj.position.set(side * (BOARD_HALF + 2.2), 0, 0);
      g.add(obj);
    });
  }

  g.position.set(0, 0, -rowIdx * CELL);
  return g;
}

function makeRoadRow(rowIdx: number): THREE.Group {
  const g = new THREE.Group();

  // asphalt base — finite width, NOT infinite
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(ROAD_HALF * 2, 0.12, CELL),
    new THREE.MeshLambertMaterial({ color: C.road })
  );
  base.receiveShadow = true;
  g.add(base);

  // yellow centre line
  const center = new THREE.Mesh(
    new THREE.BoxGeometry(ROAD_HALF * 2 - 0.4, 0.01, 0.07),
    new THREE.MeshLambertMaterial({ color: C.roadCenter })
  );
  center.position.y = 0.07;
  g.add(center);

  // white dashed lane lines
  for (let i = -BOARD_HALF + 0.5; i <= BOARD_HALF - 0.5; i += 1.6) {
    const dash = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, 0.01, 0.06),
      new THREE.MeshLambertMaterial({ color: C.roadLine })
    );
    dash.position.set(i, 0.07, 0.3);
    g.add(dash);
    const dash2 = dash.clone();
    dash2.position.z = -0.3;
    g.add(dash2);
  }

  // front & back curbs (along Z edges)
  [-1, 1].forEach((side) => {
    const curb = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_HALF * 2, 0.15, 0.22),
      MAT.curb
    );
    curb.position.set(0, 0.01, side * (CELL / 2 - 0.06));
    curb.receiveShadow = true;
    g.add(curb);

    const sw = new THREE.Mesh(new THREE.BoxGeometry(ROAD_HALF * 2 + 0.5, 0.1, 0.28), MAT.sidewalk);
    sw.position.set(0, -0.01, side * (CELL / 2 + 0.2));
    sw.receiveShadow = true;
    g.add(sw);
  });

  // ── Side end-caps: visible road termination on left & right ─────────────
  [-1, 1].forEach((side) => {
    const edgeX = side * ROAD_HALF;

    // Tall curb wall — marks where road ends
    const endCurb = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.34, CELL + 0.44),
      MAT.curb
    );
    endCurb.position.set(edgeX, 0.1, 0);
    g.add(endCurb);

    // Grass shoulder beyond road edge
    const shoulder = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.1, CELL + 0.5),
      new THREE.MeshLambertMaterial({ color: C.grass })
    );
    shoulder.position.set(edgeX + side * 0.79, -0.01, 0);
    shoulder.receiveShadow = true;
    g.add(shoulder);

    // Bollard post at end of road
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.055, 0.5, 7),
      new THREE.MeshLambertMaterial({ color: 0xffd700 })
    );
    post.position.set(edgeX + side * 0.12, 0.28, 0);
    post.castShadow = true;
    g.add(post);
  });

  g.position.set(0, -0.06, -rowIdx * CELL);
  return g;
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function GameScreen() {
  const webGLAvailable = useWebGLAvailable();
  const [score, setScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [started, setStarted] = useState(false);

  const stateRef = useRef<GameStateRef>({
    playerX: 0,
    playerZ: 0,
    playerMesh: null,
    camera: null,
    scene: null,
    renderer: null,
    gl: null,
    rows: [],
    maxRowIdx: 0,
    hop: { active: false, fromX: 0, fromZ: 0, toX: 0, toZ: 0, startMs: 0 },
    dead: false,
    score: 0,
    maxScore: 0,
    animId: null,
  });

  const setScoreRef = useRef(setScore);
  const setGameOverRef = useRef(setGameOver);
  setScoreRef.current = setScore;
  setGameOverRef.current = setGameOver;

  const generateRows = useCallback((upToRowIdx: number) => {
    const s = stateRef.current;
    if (!s.scene) return;
    while (s.maxRowIdx <= upToRowIdx) {
      const idx = s.maxRowIdx;
      const kind = idx === 0 ? "grass" : rowKindForIndex(idx);
      let mesh: THREE.Object3D;
      const cars: CarObj[] = [];

      if (kind === "grass") {
        mesh = makeGrassRow(idx);
      } else {
        mesh = makeRoadRow(idx);
        const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
        // All cars on same row share same speed → they never catch up to each other
        const rowSpeed = 1.8 + Math.random() * 2.8;
        const numCars = 1 + Math.floor(Math.random() * 3);
        // Evenly space cars across the loop width so gaps stay constant
        const loopWidth = (BOARD_HALF + 3) * 2;
        const spacing = loopWidth / numCars;
        for (let c = 0; c < numCars; c++) {
          const car = makeCar(dir, -idx * CELL, rowSpeed);
          car.x =
            dir === 1
              ? -(BOARD_HALF + 2) - c * spacing
              : BOARD_HALF + 2 + c * spacing;
          car.mesh.position.x = car.x;
          s.scene.add(car.mesh);
          cars.push(car);
        }
      }

      s.scene.add(mesh);
      s.rows.push({ rowIdx: idx, kind, mesh, cars });
      s.maxRowIdx++;
    }
  }, []);

  const pruneRows = useCallback(() => {
    const s = stateRef.current;
    if (!s.scene) return;
    const cutoff = s.playerZ - 4;
    s.rows = s.rows.filter((row) => {
      if (row.rowIdx < cutoff) {
        s.scene!.remove(row.mesh);
        row.cars.forEach((c) => s.scene!.remove(c.mesh));
        return false;
      }
      return true;
    });
  }, []);

  const checkCollision = useCallback(() => {
    const s = stateRef.current;
    if (s.dead || s.hop.active) return;
    const pRow = s.rows.find((r) => r.rowIdx === s.playerZ);
    if (!pRow || pRow.kind !== "road") return;
    for (const car of pRow.cars) {
      const half = car.width / 2 + 0.25;
      if (Math.abs(car.x - s.playerX) < half) {
        s.dead = true;
        setGameOverRef.current(true);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
    }
  }, []);

  const onContextCreate = useCallback(
    (gl: any) => {
      const s = stateRef.current;
      s.gl = gl;
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;

      const renderer = new THREE.WebGLRenderer({
        canvas: {
          width: w,
          height: h,
          style: {},
          addEventListener: () => {},
          removeEventListener: () => {},
          clientWidth: w,
          clientHeight: h,
        } as any,
        context: gl,
        antialias: true,
      });
      renderer.setSize(w, h);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      s.renderer = renderer;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(C.sky);
      // fog starts close so the tile edges are never visible
      scene.fog = new THREE.Fog(C.sky, 14, 28);
      s.scene = scene;

      const camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 80);
      camera.position.set(0, 9, 8);
      camera.lookAt(0, 0, 0);
      s.camera = camera;

      // Soft ambient fill
      scene.add(new THREE.AmbientLight(0xd0e8ff, 0.65));
      // Hemisphere sky/ground light for realistic outdoor feel
      const hemi = new THREE.HemisphereLight(0x87ceeb, 0x4caf50, 0.45);
      scene.add(hemi);
      // Main sun — casts shadows
      const sun = new THREE.DirectionalLight(0xfff5e0, 1.1);
      sun.position.set(6, 14, 8);
      sun.castShadow = true;
      sun.shadow.mapSize.width = 512;
      sun.shadow.mapSize.height = 512;
      sun.shadow.camera.near = 0.5;
      sun.shadow.camera.far = 60;
      sun.shadow.camera.left = -20;
      sun.shadow.camera.right = 20;
      sun.shadow.camera.top = 20;
      sun.shadow.camera.bottom = -20;
      sun.shadow.bias = -0.001;
      scene.add(sun);

      // ── Infinite ground plane — follows player so edges never show ──
      const groundPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(300, 600),
        new THREE.MeshLambertMaterial({ color: C.grass })
      );
      groundPlane.rotation.x = -Math.PI / 2;
      groundPlane.position.set(0, -0.11, -60);
      groundPlane.receiveShadow = true;
      scene.add(groundPlane);

      const chicken = makeChicken();
      chicken.position.set(0, 0, 0);
      scene.add(chicken);
      s.playerMesh = chicken;

      generateRows(VISIBLE_ROWS);

      let lastMs = Date.now();
      const loop = () => {
        s.animId = requestAnimationFrame(loop);
        const now = Date.now();
        const dt = Math.min((now - lastMs) / 1000, 0.05);
        lastMs = now;

        if (!s.dead) {
          // Move cars
          for (const row of s.rows) {
            if (row.kind !== "road") continue;
            for (const car of row.cars) {
              car.x += car.dir * car.speed * dt;
              // wrap just outside the visible road edge (ROAD_HALF)
              const limit = ROAD_HALF + car.width / 2 + 0.2;
              if (car.dir === 1 && car.x > limit) car.x = -limit;
              else if (car.dir === -1 && car.x < -limit) car.x = limit;
              car.mesh.position.x = car.x;
            }
          }

          // ── Continuous collision: runs every frame while player is stationary ──
          if (!s.hop.active) {
            const pRow = s.rows.find((r) => r.rowIdx === s.playerZ);
            if (pRow && pRow.kind === "road") {
              for (const car of pRow.cars) {
                // player half-width 0.26, car half-width = car.width/2
                if (Math.abs(car.x - s.playerX) < car.width / 2 + 0.26) {
                  s.dead = true;
                  setGameOverRef.current(true);
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                  break;
                }
              }
            }
          }
        }

        // Ground plane follows player Z so its edges are never visible
        groundPlane.position.z = -(s.playerZ + 30);

        if (s.hop.active) {
          const elapsed = now - s.hop.startMs;
          const t = Math.min(elapsed / HOP_MS, 1);
          const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
          const x = s.hop.fromX + (s.hop.toX - s.hop.fromX) * eased;
          const z = -(s.hop.fromZ + (s.hop.toZ - s.hop.fromZ) * eased);
          const arc = Math.sin(t * Math.PI) * HOP_ARC;
          if (s.playerMesh) {
            s.playerMesh.position.set(x, arc, z);
            if (s.hop.toX !== s.hop.fromX) {
              s.playerMesh.rotation.y =
                s.hop.toX > s.hop.fromX ? -Math.PI / 2 : Math.PI / 2;
            } else {
              s.playerMesh.rotation.y = s.hop.toZ > s.hop.fromZ ? Math.PI : 0;
            }
          }
          if (t >= 1) {
            s.hop.active = false;
            s.playerX = s.hop.toX;
            s.playerZ = s.hop.toZ;
            if (s.playerMesh) {
              s.playerMesh.position.set(s.playerX, 0, -s.playerZ);
            }
            checkCollision();
          }
        }

        if (s.camera && s.playerMesh) {
          const tx = s.playerMesh.position.x * 0.28;
          const tz = s.playerMesh.position.z + 7.5;
          s.camera.position.x += (tx - s.camera.position.x) * 0.1;
          s.camera.position.z += (tz - s.camera.position.z) * 0.1;
          s.camera.lookAt(s.playerMesh.position.x, 0, s.playerMesh.position.z - 1);
        }

        if (s.renderer && s.scene && s.camera) {
          s.renderer.render(s.scene, s.camera);
        }
        gl.endFrameEXP();
      };
      loop();
    },
    [generateRows, checkCollision]
  );

  const move = useCallback(
    (dx: number, dz: number) => {
      const s = stateRef.current;
      if (s.dead || s.hop.active || !s.scene) return;
      const newX = Math.max(-BOARD_HALF, Math.min(BOARD_HALF, s.playerX + dx));
      const newZ = Math.max(0, s.playerZ + dz);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      s.hop = {
        active: true,
        fromX: s.playerX,
        fromZ: s.playerZ,
        toX: newX,
        toZ: newZ,
        startMs: Date.now(),
      };
      if (dz > 0 && newZ > s.maxScore) {
        s.maxScore = newZ;
        s.score = newZ;
        setScoreRef.current(newZ);
      }
      generateRows(newZ + SAFE_AHEAD);
      pruneRows();
    },
    [generateRows, pruneRows]
  );

  const restart = useCallback(() => {
    const s = stateRef.current;
    if (!s.scene || !s.playerMesh) return;
    for (const row of s.rows) {
      s.scene.remove(row.mesh);
      row.cars.forEach((c) => s.scene!.remove(c.mesh));
    }
    s.rows = [];
    s.maxRowIdx = 0;
    s.playerX = 0;
    s.playerZ = 0;
    s.score = 0;
    s.maxScore = 0;
    s.dead = false;
    s.hop = { active: false, fromX: 0, fromZ: 0, toX: 0, toZ: 0, startMs: 0 };
    s.playerMesh.position.set(0, 0, 0);
    s.playerMesh.rotation.y = 0;
    generateRows(VISIBLE_ROWS);
    setScore(0);
    setGameOver(false);
  }, [generateRows]);

  // ── No WebGL fallback ─────────────────────────────────────────────────────
  if (webGLAvailable === false) {
    return (
      <View style={styles.noWebGL}>
        <Text style={styles.noWebGLEmoji}>🐔</Text>
        <Text style={styles.noWebGLTitle}>Pollo Crossy</Text>
        <Text style={styles.noWebGLBody}>
          Este juego 3D requiere WebGL.{"\n"}
          Escanea el código QR con Expo Go{"\n"}
          para jugarlo en tu celular.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {webGLAvailable && (
        <GLView
          style={StyleSheet.absoluteFill}
          onContextCreate={onContextCreate}
        />
      )}

      {/* Score */}
      {started && !gameOver && (
        <View style={styles.scoreBox} pointerEvents="none">
          <Text style={styles.scoreText}>{score}</Text>
        </View>
      )}

      {/* Start screen */}
      {!started && (
        <View style={styles.overlay}>
          <Text style={styles.titleEmoji}>🐔</Text>
          <Text style={styles.gameName}>Pollo Crossy</Text>
          <Text style={styles.subtitle}>Cruza la calle sin que te atropellen</Text>
          <TouchableOpacity
            style={styles.startBtn}
            onPress={() => setStarted(true)}
          >
            <Text style={styles.startBtnText}>JUGAR</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Game over */}
      {gameOver && (
        <View style={styles.overlay}>
          <Text style={styles.gameOverTitle}>¡Oh no!</Text>
          <Text style={styles.gameOverSub}>¡El pollo fue atropellado!</Text>
          <Text style={styles.gameOverScore}>{score}</Text>
          <Text style={styles.gameOverLabel}>filas cruzadas</Text>
          <TouchableOpacity style={styles.startBtn} onPress={restart}>
            <Text style={styles.startBtnText}>REINTENTAR</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* D-pad */}
      {started && !gameOver && (
        <View style={styles.dpad}>
          <View style={styles.dpadRow}>
            <TouchableOpacity
              style={styles.dpadBtn}
              onPress={() => move(0, 1)}
              activeOpacity={0.7}
            >
              <Text style={styles.dpadArrow}>▲</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.dpadRow}>
            <TouchableOpacity
              style={styles.dpadBtn}
              onPress={() => move(-1, 0)}
              activeOpacity={0.7}
            >
              <Text style={styles.dpadArrow}>◀</Text>
            </TouchableOpacity>
            <View style={styles.dpadCenter} />
            <TouchableOpacity
              style={styles.dpadBtn}
              onPress={() => move(1, 0)}
              activeOpacity={0.7}
            >
              <Text style={styles.dpadArrow}>▶</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.dpadRow}>
            <TouchableOpacity
              style={styles.dpadBtn}
              onPress={() => move(0, -1)}
              activeOpacity={0.7}
            >
              <Text style={styles.dpadArrow}>▼</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const BTN = 64;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000",
  },
  noWebGL: {
    flex: 1,
    backgroundColor: "#1a1a2e",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 32,
  },
  noWebGLEmoji: { fontSize: 72 },
  noWebGLTitle: {
    fontSize: 32,
    fontWeight: "900",
    color: "#FFD700",
  },
  noWebGLBody: {
    fontSize: 15,
    color: "#ffffffaa",
    textAlign: "center",
    lineHeight: 24,
  },
  scoreBox: {
    position: "absolute",
    top: Platform.OS === "web" ? 80 : 56,
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 20,
    paddingHorizontal: 24,
    paddingVertical: 7,
  },
  scoreText: {
    color: "#fff",
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.65)",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  titleEmoji: { fontSize: 72 },
  gameName: {
    fontSize: 38,
    fontWeight: "900",
    color: "#FFD700",
    letterSpacing: 1,
  },
  subtitle: {
    fontSize: 15,
    color: "#ffffffcc",
    marginBottom: 8,
  },
  startBtn: {
    marginTop: 12,
    backgroundColor: "#FFD700",
    borderRadius: 32,
    paddingHorizontal: 44,
    paddingVertical: 15,
  },
  startBtnText: {
    fontSize: 18,
    fontWeight: "900",
    color: "#222",
    letterSpacing: 2,
  },
  gameOverTitle: {
    fontSize: 44,
    fontWeight: "900",
    color: "#ff4444",
  },
  gameOverSub: {
    fontSize: 16,
    color: "#ffffffcc",
  },
  gameOverScore: {
    fontSize: 76,
    fontWeight: "900",
    color: "#FFD700",
    marginTop: 8,
  },
  gameOverLabel: {
    fontSize: 14,
    color: "#ffffffaa",
    marginBottom: 8,
  },
  dpad: {
    position: "absolute",
    bottom: Platform.OS === "web" ? 52 : 40,
    alignSelf: "center",
    alignItems: "center",
    gap: 5,
  },
  dpadRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  dpadBtn: {
    width: BTN,
    height: BTN,
    backgroundColor: "rgba(255,255,255,0.18)",
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  dpadArrow: {
    fontSize: 24,
    color: "#fff",
  },
  dpadCenter: {
    width: BTN,
    height: BTN,
  },
});
