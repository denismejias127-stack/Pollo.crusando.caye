import AsyncStorage from "@react-native-async-storage/async-storage";
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { GLView } from "expo-gl";
import * as Haptics from "expo-haptics";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Dimensions,
  Image,
  PanResponder,
  Platform,
  ScrollView,
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
const HOP_ARC = 0.0;
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

interface CoinObj {
  mesh: THREE.Group;
  x: number;
  rowIdx: number;
  collected: boolean;
}

type CameraMode = "exterior" | "interior";

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
  coins: CoinObj[];
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
  deadMs: number;
  score: number;
  maxScore: number;
  coinScore: number;
  animId: number | null;
}

// ─── Characters & Colors ──────────────────────────────────────────────────────
const CHARACTERS = [
  { id: "chicken_gold", name: "Pollo Dorado",   cost: 30,  emoji: "🐔", type: "chicken" as const, bodyColor: 0xffd700, accentColor: 0xf0c200 },
  { id: "chicken_red",  name: "Pollo Rojo",      cost: 20,  emoji: "🐓", type: "chicken" as const, bodyColor: 0xe53935, accentColor: 0xb71c1c },
  { id: "cat_yellow",   name: "Gato Amarillo",   cost: 100, emoji: "🐱", type: "cat"     as const, bodyColor: 0xffb300, accentColor: 0xe65100 },
  { id: "cat_white",    name: "Gato Blanco",     cost: 150, emoji: "🤍", type: "cat"     as const, bodyColor: 0xf5f5f5, accentColor: 0xbdbdbd },
  { id: "cat_gold",     name: "Gato Dorado",     cost: 200, emoji: "⭐", type: "cat"     as const, bodyColor: 0xffd700, accentColor: 0xff8f00 },
  { id: "dog_avocado",  name: "Perro Aguacatero",cost: 200, emoji: "🥑", type: "dog"     as const, bodyColor: 0x558b2f, accentColor: 0x1b5e20 },
  { id: "dog_shepherd", name: "Pastor Alemán",   cost: 300, emoji: "🐕", type: "dog"     as const, bodyColor: 0xd4a017, accentColor: 0x2e1a0e },
  { id: "pilbu",        name: "Pilbu",           cost: 500, emoji: "👾", type: "pilbu"   as const, bodyColor: 0x7c4dff, accentColor: 0xea80fc },
] as const;
type CharId = typeof CHARACTERS[number]["id"];

const CHAR_DESC: Record<CharId, string> = {
  chicken_gold:  "El clásico original. Valiente y rápido, nunca se rinde ante el tráfico.",
  chicken_red:   "Fogoso y audaz. Vive al límite y le encanta el peligro.",
  cat_yellow:    "Ágil y curioso. Siempre aterriza de pie, pase lo que pase.",
  cat_white:     "Elegante y sereno. Cruza las calles con una clase infinita.",
  cat_gold:      "Rarísimo y misterioso. Dicen que trae muchísima buena suerte.",
  dog_avocado:   "Ama la naturaleza y el guacamole. Nunca pide permiso para cruzar.",
  dog_shepherd:  "Serio, disciplinado y leal. No le teme a ningún carro ni camión.",
  pilbu:         "Nadie sabe de dónde vino ni a dónde va. Su mirada lo dice todo.",
};

// ─── Daily Achievements ───────────────────────────────────────────────────────
type AchType = "score" | "coins_round" | "rounds_today" | "beat_record";
interface AchievementDef {
  id: string;
  title: string;
  desc: string;
  reward: number;
  type: AchType;
  target: number;
}
const ALL_ACHIEVEMENTS: AchievementDef[] = [
  { id: "a1", title: "Primer cruce",  desc: "Cruza 5 filas en una ronda",    reward: 15, type: "score",        target: 5  },
  { id: "a2", title: "Corredor",      desc: "Cruza 10 filas en una ronda",   reward: 30, type: "score",        target: 10 },
  { id: "a3", title: "Velocista",     desc: "Cruza 20 filas en una ronda",   reward: 60, type: "score",        target: 20 },
  { id: "a4", title: "Ahorrador",     desc: "Gana 10 monedas en una ronda",  reward: 20, type: "coins_round",  target: 10 },
  { id: "a5", title: "Rico Pollo",    desc: "Gana 30 monedas en una ronda",  reward: 55, type: "coins_round",  target: 30 },
  { id: "a6", title: "Persistente",   desc: "Juega 3 rondas hoy",            reward: 25, type: "rounds_today", target: 3  },
  { id: "a7", title: "Campeón",       desc: "Supera tu récord personal",      reward: 50, type: "beat_record",  target: 1  },
  { id: "a8", title: "Maratonista",   desc: "Cruza 15 filas en una ronda",   reward: 45, type: "score",        target: 15 },
  { id: "a9", title: "Monedero",      desc: "Gana 20 monedas en una ronda",  reward: 35, type: "coins_round",  target: 20 },
];
function getDateKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function getDailyAchievements(): AchievementDef[] {
  const dayNum = Math.floor(Date.now() / 86_400_000);
  return [
    ALL_ACHIEVEMENTS[dayNum % 9],
    ALL_ACHIEVEMENTS[(dayNum + 3) % 9],
    ALL_ACHIEVEMENTS[(dayNum + 6) % 9],
  ];
}

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

interface ChickenOpts { bodyColor?: number; wingColor?: number; }
function makeChicken(opts?: ChickenOpts): THREE.Group {
  const g = new THREE.Group();
  const yMat       = new THREE.MeshLambertMaterial({ color: opts?.bodyColor ?? C.chicken });
  const wMat       = new THREE.MeshLambertMaterial({ color: opts?.wingColor ?? C.wing });
  const bMat       = new THREE.MeshLambertMaterial({ color: C.beak });
  const eMat       = new THREE.MeshLambertMaterial({ color: C.eye });
  const cMat       = new THREE.MeshLambertMaterial({ color: C.comb });
  const legMat     = new THREE.MeshLambertMaterial({ color: C.leg });
  const eyeWhiteMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const bellyMat   = new THREE.MeshLambertMaterial({ color: 0xfff5cc });

  // ── BODY — round pear, slightly squat ──
  // Center y=0.32.  Top ≈ 0.32 + 0.3*1.15 = 0.665
  const bodyMesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), yMat);
  bodyMesh.scale.set(1.0, 1.15, 0.96);
  bodyMesh.position.y = 0.32;
  g.add(bodyMesh);

  // Belly patch — sits flush on the front face of the body
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 7), bellyMat);
  belly.scale.set(0.82, 1.05, 0.28);
  belly.position.set(0, 0.30, 0.27);
  g.add(belly);

  // ── NECK — thick truncated cone bridging body top → head base ──
  // Body top ≈ y=0.665.  Head center will be y=0.86.
  // Neck center at y=0.74, z=0.06.  rotation.x=-0.22 tilts it slightly forward.
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 0.20, 8), yMat);
  neck.rotation.x = -0.22;
  neck.position.set(0, 0.72, 0.05);
  g.add(neck);

  // ── HEAD ──
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.20, 10, 8), yMat);
  headMesh.position.set(0, 0.86, 0.10);
  g.add(headMesh);

  // ── BEAK ──
  const beakUpper = new THREE.Mesh(new THREE.ConeGeometry(0.062, 0.20, 7), bMat);
  beakUpper.rotation.x = Math.PI / 2;
  beakUpper.position.set(0, 0.875, 0.29);
  g.add(beakUpper);
  const beakLower = new THREE.Mesh(new THREE.ConeGeometry(0.042, 0.14, 7), bMat);
  beakLower.rotation.x = Math.PI / 2 + 0.28;
  beakLower.position.set(0, 0.835, 0.29);
  g.add(beakLower);

  // ── WATTLE ──
  const wattle = new THREE.Mesh(new THREE.SphereGeometry(0.058, 7, 7), cMat);
  wattle.scale.set(1, 1.5, 1);
  wattle.position.set(0, 0.775, 0.26);
  g.add(wattle);

  // ── EYES ──
  [-0.12, 0.12].forEach((ex) => {
    const white = new THREE.Mesh(new THREE.SphereGeometry(0.062, 8, 7), eyeWhiteMat);
    white.position.set(ex, 0.875, 0.20);
    g.add(white);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.036, 7, 6), eMat);
    pupil.position.set(ex * 0.92, 0.875, 0.245);
    g.add(pupil);
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.015, 5, 5), eyeWhiteMat);
    shine.position.set(ex * 0.88 + 0.014, 0.89, 0.258);
    g.add(shine);
  });

  // ── COMB — 3 bumps decreasing forward ──
  [{ cx: 0, cy: 1.055, cz: 0.02, r: 0.062 },
   { cx: -0.055, cy: 1.04, cz: 0.04, r: 0.052 },
   { cx:  0.055, cy: 1.04, cz: 0.04, r: 0.052 }].forEach(({ cx, cy, cz, r }) => {
    const bump = new THREE.Mesh(new THREE.SphereGeometry(r, 7, 6), cMat);
    bump.scale.y = 1.35;
    bump.position.set(cx, cy, cz);
    g.add(bump);
  });

  // ── TAIL FEATHERS — 5-feather fan, large & prominent ──
  // Cones start from body-back (z≈-0.27) and fan upward-backward.
  // rotation.x: -(π/2 + lean) makes the cone tip point backward+up.
  const tailBase = new THREE.Mesh(new THREE.SphereGeometry(0.16, 9, 7), wMat);
  tailBase.scale.set(1.35, 0.8, 0.8);
  tailBase.position.set(0, 0.38, -0.255);
  g.add(tailBase);
  const tailFan = [
    { x: -0.24, y: 0.40, lean: 0.48, rz: -0.42 },
    { x: -0.12, y: 0.45, lean: 0.62, rz: -0.20 },
    { x:  0,    y: 0.48, lean: 0.76, rz:  0    },
    { x:  0.12, y: 0.45, lean: 0.62, rz:  0.20 },
    { x:  0.24, y: 0.40, lean: 0.48, rz:  0.42 },
  ];
  tailFan.forEach(({ x, y, lean, rz }) => {
    const feather = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.50, 5), wMat);
    feather.rotation.x = -(Math.PI / 2 + lean);
    feather.rotation.z = rz;
    feather.position.set(x, y, -0.27);
    g.add(feather);
  });

  // ── WINGS — ellipsoidal slabs hugging the body sides ──
  [-1, 1].forEach((side) => {
    const wing = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 7), wMat);
    wing.scale.set(0.26, 0.70, 1.02);
    wing.rotation.z = side * 0.16;
    wing.position.set(side * 0.30, 0.33, -0.02);
    g.add(wing);
    // primary feather tip
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.052, 0.19, 5), wMat);
    tip.rotation.z = side * (Math.PI / 2 + 0.12);
    tip.position.set(side * 0.37, 0.19, 0.0);
    g.add(tip);
  });

  // ── LEGS — hip pivot embedded in body bottom ──
  const chickenLegs: THREE.Group[] = [];
  [-0.13, 0.13].forEach((lx) => {
    const lg = new THREE.Group();
    // Hip at y=0.16 embeds the leg top into the body (body bottom ≈ y=0.08)
    lg.position.set(lx, 0.18, 0.02);
    const hip = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), legMat);
    hip.position.y = -0.015;
    lg.add(hip);
    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.044, 0.22, 7), legMat);
    thigh.position.set(0, -0.11, 0);
    lg.add(thigh);
    const knee = new THREE.Mesh(new THREE.SphereGeometry(0.056, 6, 5), legMat);
    knee.position.set(0, -0.23, 0.02);
    lg.add(knee);
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.028, 0.20, 6), legMat);
    shin.rotation.x = 0.24;
    shin.position.set(0, -0.34, 0.045);
    lg.add(shin);
    [-0.062, 0.0, 0.062].forEach((tz2, ti) => {
      const toe = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.012, 0.14, 5), legMat);
      toe.rotation.x = Math.PI / 2;
      toe.rotation.z = (ti - 1) * 0.34;
      toe.position.set((ti - 1) * 0.038, -0.45, 0.09 + tz2 * 0.28);
      lg.add(toe);
    });
    const rearToe = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.010, 0.10, 5), legMat);
    rearToe.rotation.x = -Math.PI / 2;
    rearToe.position.set(0, -0.45, -0.065);
    lg.add(rearToe);
    g.add(lg);
    chickenLegs.push(lg);
  });
  g.userData.legs = chickenLegs;

  setShadow(g, true, false);
  return g;
}

/** 3D cat model — quadruped with horizontal body */
function makeCat(bodyColor: number, accentColor: number): THREE.Group {
  const g = new THREE.Group();
  const bodyMat  = new THREE.MeshLambertMaterial({ color: bodyColor });
  const accMat   = new THREE.MeshLambertMaterial({ color: accentColor });
  const noseMat  = new THREE.MeshLambertMaterial({ color: 0xff8a80 });
  const eyeMat   = new THREE.MeshLambertMaterial({ color: 0x22cc66 });
  const pupilMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
  const eyeWMat  = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const innerEar = new THREE.MeshLambertMaterial({ color: 0xff8a80 });
  const bellyMat = new THREE.MeshLambertMaterial({ color: 0xffffff });

  // ── BODY — horizontal pill ──
  // Center y=0.30.  Vertical extent ≈ 0.30 ± 0.26*0.74 = [0.108, 0.492]
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), bodyMat);
  body.scale.set(0.88, 0.74, 1.40);
  body.position.set(0, 0.30, 0);
  g.add(body);

  // Belly patch
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), bellyMat);
  belly.scale.set(0.68, 0.38, 1.12);
  belly.position.set(0, 0.16, 0);
  g.add(belly);

  // ── NECK — thick stub, clearly bridging body→head ──
  // Body front at z = 0.26*1.40 = 0.364.  Head center at (0, 0.46, 0.50).
  // Neck center at (0, 0.38, 0.37), length 0.24, rotation.x=-0.62 tilts it forward.
  const neck = new THREE.Mesh(new THREE.SphereGeometry(0.16, 9, 7), bodyMat);
  neck.scale.set(0.9, 0.9, 1.05);
  neck.rotation.x = -0.62;
  neck.position.set(0, 0.38, 0.37);
  g.add(neck);

  // ── HEAD ──
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 10, 8), bodyMat);
  head.position.set(0, 0.46, 0.50);
  g.add(head);

  // Ears + inner ears
  [-0.13, 0.13].forEach((ex) => {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.082, 0.19, 5), bodyMat);
    ear.rotation.z = ex < 0 ? -0.18 : 0.18;
    ear.position.set(ex, 0.655, 0.49);
    g.add(ear);
    const inn = new THREE.Mesh(new THREE.ConeGeometry(0.046, 0.12, 5), innerEar);
    inn.rotation.z = ex < 0 ? -0.18 : 0.18;
    inn.position.set(ex * 0.9, 0.655, 0.505);
    g.add(inn);
  });

  // Eyes
  [-0.105, 0.105].forEach((ex) => {
    const white = new THREE.Mesh(new THREE.SphereGeometry(0.060, 8, 6), eyeWMat);
    white.scale.set(1.22, 0.76, 0.60);
    white.position.set(ex, 0.495, 0.675);
    g.add(white);
    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.040, 7, 6), eyeMat);
    iris.scale.set(1.08, 0.72, 0.65);
    iris.position.set(ex, 0.495, 0.700);
    g.add(iris);
    const pupil = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.052, 0.030), pupilMat);
    pupil.position.set(ex, 0.495, 0.714);
    g.add(pupil);
  });

  // Nose
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.033, 6, 5), noseMat);
  nose.scale.set(1.28, 0.70, 0.80);
  nose.position.set(0, 0.455, 0.692);
  g.add(nose);

  // Whiskers
  [-1, 1].forEach((side) => {
    [-0.02, 0.018, 0.046].forEach((wy) => {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.002, 0.24, 4), accMat);
      w.rotation.z = Math.PI / 2 + side * wy * 1.8;
      w.position.set(side * 0.20, 0.448 + wy, 0.665);
      g.add(w);
    });
  });

  // ── TAIL — connected curved tail from the rump ──
  // The base overlaps the body so the tail never appears detached.
  const tailRoot = new THREE.Mesh(new THREE.SphereGeometry(0.105, 8, 7), bodyMat);
  tailRoot.scale.set(0.9, 1.0, 1.15);
  tailRoot.position.set(0, 0.25, -0.335);
  g.add(tailRoot);
  for (let t = 0; t < 9; t++) {
    const angle = (t / 8) * (Math.PI * 0.90);
    const seg = new THREE.Mesh(
      new THREE.SphereGeometry(0.062 - t * 0.004, 7, 6),
      t >= 7 ? accMat : bodyMat
    );
    seg.position.set(
      0,
      0.23 + Math.sin(angle) * 0.27 + t * 0.022,
      -0.32 - Math.cos(angle) * 0.13 - t * 0.018
    );
    g.add(seg);
  }

  // ── 4 LEGS — hip embedded in body bottom for solid connection ──
  // Body bottom ≈ y=0.108.  Hip at y=0.17 means top of leg cylinder is 0.062 inside body.
  const catLegs: THREE.Group[] = [];
  [[-0.155, 0.24], [0.155, 0.24], [-0.145, -0.24], [0.145, -0.24]].forEach(([lx, lz]) => {
    const lg = new THREE.Group();
    lg.position.set(lx, 0.20, lz);
    const hip = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 6), bodyMat);
    hip.scale.set(1.0, 0.85, 0.9);
    hip.position.y = -0.015;
    lg.add(hip);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.056, 0.044, 0.28, 7), bodyMat);
    leg.position.set(0, -0.14, 0);
    lg.add(leg);
    const paw = new THREE.Mesh(new THREE.SphereGeometry(0.070, 7, 6), accMat);
    paw.scale.set(1.12, 0.52, 1.24);
    paw.position.set(0, -0.32, lz > 0 ? 0.045 : -0.025);
    lg.add(paw);
    g.add(lg);
    catLegs.push(lg);
  });
  g.userData.legs = catLegs;

  setShadow(g, true, false);
  return g;
}

/** 3D dog model — quadruped with horizontal body */
function makeDog(bodyColor: number, accentColor: number): THREE.Group {
  const g = new THREE.Group();
  const bodyMat  = new THREE.MeshLambertMaterial({ color: bodyColor });
  const accMat   = new THREE.MeshLambertMaterial({ color: accentColor });
  const noseMat  = new THREE.MeshLambertMaterial({ color: 0x111111 });
  const eyeMat   = new THREE.MeshLambertMaterial({ color: 0x5d3a1a });
  const eyeWMat  = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const tongueMat = new THREE.MeshLambertMaterial({ color: 0xff4081 });
  const bellyMat = new THREE.MeshLambertMaterial({ color: 0xfff8e1 });

  // ── BODY — horizontal barrel: longer z, squat y ──
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.27, 10, 8), bodyMat);
  body.scale.set(0.95, 0.78, 1.45);
  body.position.set(0, 0.3, 0);
  g.add(body);

  // Belly
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), bellyMat);
  belly.scale.set(0.72, 0.38, 1.15);
  belly.position.set(0, 0.15, 0);
  g.add(belly);

  // ── NECK ──
  const neck = new THREE.Mesh(new THREE.SphereGeometry(0.16, 9, 7), bodyMat);
  neck.scale.set(0.9, 0.9, 1.05);
  neck.rotation.x = -0.6;
  neck.position.set(0, 0.38, 0.3);
  g.add(neck);

  // ── HEAD — bigger/rounder than cat ──
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), bodyMat);
  head.position.set(0, 0.48, 0.48);
  g.add(head);

  // Snout — flat rounded muzzle
  const snout = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 7), bellyMat);
  snout.scale.set(1.1, 0.72, 0.9);
  snout.position.set(0, 0.44, 0.66);
  g.add(snout);

  // Nose
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.048, 6, 5), noseMat);
  nose.scale.set(1.2, 0.85, 0.8);
  nose.position.set(0, 0.49, 0.74);
  g.add(nose);

  // Tongue — hangs down from snout
  const tongue = new THREE.Mesh(new THREE.SphereGeometry(0.052, 6, 5), tongueMat);
  tongue.scale.set(0.9, 0.45, 0.85);
  tongue.position.set(0, 0.38, 0.7);
  g.add(tongue);

  // Eyes
  [-0.12, 0.12].forEach((ex) => {
    const white = new THREE.Mesh(new THREE.SphereGeometry(0.062, 8, 7), eyeWMat);
    white.position.set(ex, 0.535, 0.63);
    g.add(white);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.04, 7, 6), eyeMat);
    pupil.position.set(ex * 0.9, 0.535, 0.655);
    g.add(pupil);
    // shine
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.015, 5, 5), eyeWMat);
    shine.position.set(ex * 0.85 + 0.012, 0.552, 0.668);
    g.add(shine);
  });

  // Floppy ears — rounded rectangles hanging at sides of head
  [-0.26, 0.26].forEach((ex) => {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 7), accMat);
    ear.scale.set(0.72, 1.55, 0.35);
    ear.rotation.z = ex < 0 ? 0.12 : -0.12;
    ear.position.set(ex, 0.42, 0.46);
    g.add(ear);
  });

  // ── TAIL — wagging arc rooted inside the rump ──
  const tailRoot = new THREE.Mesh(new THREE.SphereGeometry(0.115, 8, 7), bodyMat);
  tailRoot.scale.set(0.9, 1.0, 1.2);
  tailRoot.position.set(0, 0.28, -0.345);
  g.add(tailRoot);
  for (let t = 0; t < 7; t++) {
    const angle = (t / 6) * (Math.PI * 0.75);
    const seg = new THREE.Mesh(
      new THREE.SphereGeometry(0.068 - t * 0.006, 7, 6),
      t >= 5 ? accMat : bodyMat
    );
    seg.position.set(
      0,
      0.25 + Math.sin(angle) * 0.28 + t * 0.020,
      -0.32 - Math.cos(angle) * 0.14 - t * 0.020
    );
    g.add(seg);
  }

  // ── 4 LEGS — grouped for walk animation (FL, FR, BL, BR), pivot at hip ──
  const dogLegs: THREE.Group[] = [];
  [[-0.17, 0.24], [0.17, 0.24], [-0.16, -0.25], [0.16, -0.25]].forEach(([lx, lz]) => {
    const lg = new THREE.Group();
    lg.position.set(lx, 0.19, lz);  // hip = pivot, embedded in the body
    const hip = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), bodyMat);
    hip.scale.set(1.0, 0.85, 0.95);
    hip.position.y = -0.02;
    lg.add(hip);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.048, 0.28, 7), bodyMat);
    leg.position.set(0, -0.14, 0);  // top at y=0, bottom at y=-0.28
    lg.add(leg);
    const paw = new THREE.Mesh(new THREE.SphereGeometry(0.076, 7, 6), accMat);
    paw.scale.set(1.1, 0.55, 1.2);
    paw.position.set(0, -0.32, lz > 0 ? 0.05 : -0.02);
    lg.add(paw);
    g.add(lg);
    dogLegs.push(lg);
  });
  g.userData.legs = dogLegs;

  setShadow(g, true, false);
  return g;
}

/** Pilbu — chubby purple dog with floppy ears */
function makePilbu(): THREE.Group {
  const g        = new THREE.Group();
  const bodyMat  = new THREE.MeshLambertMaterial({ color: 0x7c4dff });
  const accMat   = new THREE.MeshLambertMaterial({ color: 0xce93d8 });
  const eyeWMat  = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const pupilMat = new THREE.MeshLambertMaterial({ color: 0x1a1a2e });
  const noseMat  = new THREE.MeshLambertMaterial({ color: 0x4a148c });

  // Body — horizontal stretched sphere like cat/dog
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 9), bodyMat);
  body.scale.set(0.95, 0.82, 1.7);
  body.position.set(0, 0.22, 0);
  g.add(body);

  // Tummy spot
  const tummy = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 7), accMat);
  tummy.scale.set(0.85, 0.65, 0.32);
  tummy.position.set(0, 0.14, 0.18);
  g.add(tummy);

  // Neck
  const neck = new THREE.Mesh(new THREE.SphereGeometry(0.16, 9, 7), bodyMat);
  neck.scale.set(0.9, 0.86, 1.05);
  neck.position.set(0, 0.26, 0.29);
  g.add(neck);

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), bodyMat);
  head.scale.set(1.05, 1.0, 1.05);
  head.position.set(0, 0.32, 0.45);
  g.add(head);

  // Muzzle
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 7), accMat);
  muzzle.scale.set(1.1, 0.75, 0.9);
  muzzle.position.set(0, 0.26, 0.61);
  g.add(muzzle);

  // Nose
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.048, 7, 6), noseMat);
  nose.scale.set(1.1, 0.75, 0.8);
  nose.position.set(0, 0.3, 0.68);
  g.add(nose);

  // Eyes
  [-0.1, 0.1].forEach((ex) => {
    const eyeW = new THREE.Mesh(new THREE.SphereGeometry(0.065, 8, 7), eyeWMat);
    eyeW.position.set(ex, 0.38, 0.59);
    g.add(eyeW);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.038, 7, 6), pupilMat);
    pupil.position.set(ex * 0.9, 0.38, 0.64);
    g.add(pupil);
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.015, 5, 4), eyeWMat);
    shine.position.set(ex * 0.85 + 0.02, 0.395, 0.67);
    g.add(shine);
  });

  // Floppy droopy ears — the signature feature
  [-1, 1].forEach((side) => {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 7), accMat);
    ear.scale.set(0.65, 1.6, 0.45);
    ear.position.set(side * 0.2, 0.26, 0.42);
    g.add(ear);
  });

  // Tail — stubby curled up at the back, with a visible connected root
  const tailRoot = new THREE.Mesh(new THREE.SphereGeometry(0.10, 8, 7), bodyMat);
  tailRoot.scale.set(0.9, 1.0, 1.15);
  tailRoot.position.set(0, 0.27, -0.35);
  g.add(tailRoot);
  const tailBase = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.18, 8), bodyMat);
  tailBase.rotation.x = -0.7;
  tailBase.position.set(0, 0.34, -0.39);
  g.add(tailBase);
  const tailTip = new THREE.Mesh(new THREE.SphereGeometry(0.065, 8, 7), accMat);
  tailTip.position.set(0, 0.46, -0.48);
  g.add(tailTip);

  // 4 grouped legs — pivot at hip, same pattern as cat/dog
  const pilbuLegs: THREE.Group[] = [];
  [[-0.16, 0.22], [0.16, 0.22], [-0.15, -0.24], [0.15, -0.24]].forEach(([lx, lz]) => {
    const lg = new THREE.Group();
    lg.position.set(lx, 0.17, lz);
    const hip = new THREE.Mesh(new THREE.SphereGeometry(0.082, 8, 6), bodyMat);
    hip.scale.set(1.0, 0.85, 0.95);
    hip.position.y = -0.015;
    lg.add(hip);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.045, 0.22, 8), bodyMat);
    leg.position.set(0, -0.11, 0);
    lg.add(leg);
    const paw = new THREE.Mesh(new THREE.SphereGeometry(0.068, 8, 7), accMat);
    paw.scale.set(1.1, 0.6, 1.2);
    paw.position.set(0, -0.25, lz > 0 ? 0.03 : -0.01);
    lg.add(paw);
    g.add(lg);
    pilbuLegs.push(lg);
  });
  g.userData.legs = pilbuLegs;

  setShadow(g, true, false);
  return g;
}

function makePlayerMesh(charId: CharId): THREE.Group {
  const char = CHARACTERS.find((c) => c.id === charId) ?? CHARACTERS[0];
  let g: THREE.Group;
  if (char.type === "cat")   g = makeCat(char.bodyColor, char.accentColor);
  else if (char.type === "dog")   g = makeDog(char.bodyColor, char.accentColor);
  else if (char.type === "pilbu") g = makePilbu();
  else g = makeChicken({ bodyColor: char.bodyColor, wingColor: char.accentColor });
  // Scale down to proper small-animal proportions (roughly half the road-cell size)
  g.scale.setScalar(0.48);
  return g;
}

/** Spinning gold coin collectible */
function makeCoin(): THREE.Group {
  const g = new THREE.Group();
  const goldMat = new THREE.MeshLambertMaterial({ color: 0xffd700 });
  const edgeMat = new THREE.MeshLambertMaterial({ color: 0xe6a800 });
  const innerMat = new THREE.MeshLambertMaterial({ color: 0xffec6e });

  // Main disc
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.09, 14), goldMat);
  g.add(disc);
  // Edge banding
  const edge = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.018, 5, 14), edgeMat);
  edge.rotation.x = Math.PI / 2;
  g.add(edge);
  // Inner circle (top face)
  const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.1, 12), innerMat);
  inner.position.y = 0.0;
  g.add(inner);
  // $ star symbol (3 tiny boxes forming a cross)
  [0, Math.PI / 2].forEach((rot) => {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.11, 0.04), edgeMat);
    bar.rotation.y = rot;
    bar.position.y = 0.05;
    g.add(bar);
  });

  g.traverse((c) => { if ((c as THREE.Mesh).isMesh) c.castShadow = true; });
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

// ─── Character Preview — real 3-D animated model (shown in detail overlay) ───
// NOTE: main game GLView must be unmounted before mounting this component
// (only one WebGL context can be active at a time on Expo GL).
function CharacterPreviewGL({ charId }: { charId: CharId }) {
  const animRef = useRef<number | null>(null);

  const onContextCreate = useCallback(
    (gl: any) => {
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;

      const renderer = new THREE.WebGLRenderer({
        canvas: {
          width: w, height: h, style: {},
          addEventListener: () => {}, removeEventListener: () => {},
          clientWidth: w, clientHeight: h,
        } as any,
        context: gl,
        antialias: true,
      });
      renderer.setSize(w, h);
      renderer.setClearColor(0x141428);
      renderer.shadowMap.enabled = false;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x141428);
      const camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 50);
      camera.position.set(0, 0.65, 2.4);
      camera.lookAt(0, 0.15, 0);

      scene.add(new THREE.AmbientLight(0xffffff, 0.75));
      const sun = new THREE.DirectionalLight(0xffffff, 0.95);
      sun.position.set(2, 4, 2);
      scene.add(sun);
      const fill = new THREE.DirectionalLight(0x8080ff, 0.3);
      fill.position.set(-2, 1, -1);
      scene.add(fill);

      // Ground disc
      const ground = new THREE.Mesh(
        new THREE.CircleGeometry(0.9, 40),
        new THREE.MeshLambertMaterial({ color: 0x1e1e3a })
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.25;
      scene.add(ground);

      const mesh = makePlayerMesh(charId);
      mesh.scale.setScalar(1.05);
      scene.add(mesh);

      const start = Date.now();
      const tick = () => {
        animRef.current = requestAnimationFrame(tick);
        const t = (Date.now() - start) / 1000;
        mesh.rotation.y = t * 0.65;
        mesh.position.y = Math.abs(Math.sin(t * Math.PI * 2)) * 0.04;
        const swing = Math.sin(t * Math.PI * 2) * 0.42;
        const legs = mesh.userData.legs as THREE.Group[] | undefined;
        if (legs) {
          if (legs.length >= 4) {
            legs[0].rotation.x =  swing; legs[1].rotation.x = -swing;
            legs[2].rotation.x = -swing; legs[3].rotation.x =  swing;
          } else if (legs.length === 2) {
            legs[0].rotation.x =  swing; legs[1].rotation.x = -swing;
          }
        }
        renderer.render(scene, camera);
        gl.endFrameEXP();
      };
      tick();
    },
    [charId]
  );

  useEffect(() => () => { if (animRef.current) cancelAnimationFrame(animRef.current); }, []);

  return (
    <GLView key={charId} style={styles.previewGLView} onContextCreate={onContextCreate} />
  );
}

// ─── Thumbnail Minter — renders one character offscreen and snaps a JPEG ─────
// Mounts only while main GLView is unmounted (mintingChar drives both).
function ThumbnailMinter({
  charId,
  onDone,
}: {
  charId: CharId;
  onDone: (id: CharId, uri: string) => void;
}) {
  const doneRef = useRef(false);

  const onContextCreate = useCallback(
    async (gl: any) => {
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;

      const renderer = new THREE.WebGLRenderer({
        canvas: {
          width: w, height: h, style: {},
          addEventListener: () => {}, removeEventListener: () => {},
          clientWidth: w, clientHeight: h,
        } as any,
        context: gl,
        antialias: false,
      });
      renderer.setSize(w, h);
      renderer.setClearColor(0x1a1a2e);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x1a1a2e);
      const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
      camera.position.set(0, 0.65, 2.4);
      camera.lookAt(0, 0.15, 0);

      scene.add(new THREE.AmbientLight(0xffffff, 0.8));
      const sun = new THREE.DirectionalLight(0xffffff, 0.9);
      sun.position.set(2, 4, 2);
      scene.add(sun);

      const mesh = makePlayerMesh(charId);
      mesh.rotation.y = Math.PI / 5;
      scene.add(mesh);

      renderer.render(scene, camera);
      gl.endFrameEXP();

      if (!doneRef.current) {
        doneRef.current = true;
        // Wait one frame so the native buffer is flushed before snapshot
        await new Promise<void>((r) => setTimeout(r, 120));
        try {
          const snap = await GLView.takeSnapshotAsync(gl, { format: "jpeg", compress: 0.85 });
          onDone(charId, typeof snap.uri === "string" ? snap.uri : "");
        } catch {
          onDone(charId, "");
        }
      }
    },
    [charId, onDone]
  );

  // Tiny but real dimensions so drawingBufferWidth/Height are non-zero
  return (
    <GLView
      key={charId}
      style={styles.thumbMinter}
      onContextCreate={onContextCreate}
    />
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function GameScreen() {
  const webGLAvailable = useWebGLAvailable();
  const [score, setScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [started, setStarted] = useState(false);
  const [totalCoins, setTotalCoins] = useState(0);
  const [unlockedChars, setUnlockedChars] = useState<Set<CharId>>(
    () => new Set<CharId>(["chicken_gold"])
  );
  const [selectedChar, setSelectedChar] = useState<CharId>("chicken_gold");
  const [showShop, setShowShop] = useState(false);
  const [muted, setMuted] = useState(false);
  const [highScore, setHighScore] = useState(0);
  const [dailyRewardClaimed, setDailyRewardClaimed] = useState(false);
  const [dailyAchProgress, setDailyAchProgress] = useState<Record<string, number>>({});
  const [dailyAchClaimed, setDailyAchClaimed] = useState<Set<string>>(new Set());
  const [showAchievements, setShowAchievements] = useState(false);
  const [roundsToday, setRoundsToday] = useState(0);
  const [previewChar, setPreviewChar] = useState<CharId | null>(null);
  const [charThumbnails, setCharThumbnails] = useState<Partial<Record<CharId, string>>>({});
  const [mintingChar, setMintingChar]   = useState<CharId | null>(null);
  const mintQueueRef = useRef<CharId[]>([]);
  const [saveLoaded, setSaveLoaded] = useState(false);
  const selectedCharRef = useRef<CharId>("chicken_gold");
  selectedCharRef.current = selectedChar;

  // ── Audio: coin SFX + looping background music ────────────────────────────
  const coinPlayer = useAudioPlayer(require("../../assets/sounds/coin.mp3"));
  const musicPlayer = useAudioPlayer(require("../../assets/sounds/music.mp3"));
  const trafficPlayer = useAudioPlayer(require("../../assets/sounds/traffic.mp3"));
  const crashPlayer = useAudioPlayer(require("../../assets/sounds/crash.mp3"));
  const hopPlayer = useAudioPlayer(require("../../assets/sounds/hop.mp3"));
  const characterPlayer = useAudioPlayer(require("../../assets/sounds/character.mp3"));
  const coinPlayerRef = useRef(coinPlayer);
  coinPlayerRef.current = coinPlayer;
  const crashPlayerRef = useRef(crashPlayer);
  crashPlayerRef.current = crashPlayer;
  const hopPlayerRef = useRef(hopPlayer);
  hopPlayerRef.current = hopPlayer;
  const characterPlayerRef = useRef(characterPlayer);
  characterPlayerRef.current = characterPlayer;

  // ── Thumbnail minting: generate shop card images the first time shop opens ──
  const handleMintDone = useCallback((charId: CharId, uri: string) => {
    if (uri) setCharThumbnails((prev) => ({ ...prev, [charId]: uri }));
    const next = mintQueueRef.current.shift();
    if (next) {
      setMintingChar(next);
    } else {
      setMintingChar(null); // done — main GLView will remount
    }
  }, []);

  useEffect(() => {
    if (showShop && Object.keys(charThumbnails).length === 0 && mintingChar === null) {
      mintQueueRef.current = CHARACTERS.map((c) => c.id).slice(1); // head pops below
      setMintingChar(CHARACTERS[0].id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showShop]);

  const musicStatus = useAudioPlayerStatus(musicPlayer);

  // Configure audio mode once on mount
  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
    musicPlayer.loop = true;
    musicPlayer.volume = 0.45;
    trafficPlayer.loop = true;
    trafficPlayer.volume = 0.25;
    characterPlayer.volume = 0.8;
  }, [musicPlayer, trafficPlayer, characterPlayer]);

  // Start music only once the track is loaded and ready
  useEffect(() => {
    if (musicStatus.isLoaded && !musicStatus.playing) {
      musicPlayer.play();
    }
  }, [musicStatus.isLoaded, musicStatus.playing, musicPlayer]);

  // Mute / unmute all background audio
  useEffect(() => {
    musicPlayer.volume = muted ? 0 : 0.45;
    trafficPlayer.volume = muted ? 0 : 0.25;
  }, [muted, musicPlayer, trafficPlayer]);

  // Traffic ambience only while actively playing a round
  useEffect(() => {
    if (started && !gameOver && !showShop) {
      trafficPlayer.play();
    } else {
      trafficPlayer.pause();
    }
  }, [started, gameOver, showShop, trafficPlayer]);

  const playCoinSound = useCallback(() => {
    const p = coinPlayerRef.current;
    p.seekTo(0);
    p.play();
  }, []);
  const playCoinSoundRef = useRef(playCoinSound);
  playCoinSoundRef.current = playCoinSound;

  const playCrashSound = useCallback(() => {
    const p = crashPlayerRef.current;
    p.seekTo(0);
    p.play();
  }, []);
  const playCrashSoundRef = useRef(playCrashSound);
  playCrashSoundRef.current = playCrashSound;

  const playHopSound = useCallback(() => {
    const p = hopPlayerRef.current;
    p.seekTo(0);
    p.play();
  }, []);
  const playHopSoundRef = useRef(playHopSound);
  playHopSoundRef.current = playHopSound;

  const playCharacterSound = useCallback(() => {
    const p = characterPlayerRef.current;
    p.seekTo(0);
    p.play();
  }, []);
  const playCharacterSoundRef = useRef(playCharacterSound);
  playCharacterSoundRef.current = playCharacterSound;

  // ── Load saved wallet + unlocks + daily data on first mount ─────────────
  useEffect(() => {
    AsyncStorage.multiGet([
      "pollo_coins", "pollo_unlocked", "pollo_selected", "pollo_high",
      "pollo_day_key", "pollo_day_reward", "pollo_day_progress", "pollo_day_claimed", "pollo_day_rounds",
    ]).then((entries) => {
        const [coinsE, unlockedE, selectedE, highE,
               dayKeyE, rewardE, progressE, claimedE, roundsE] = entries;
        if (coinsE[1]) setTotalCoins(parseInt(coinsE[1], 10) || 0);
        if (unlockedE[1]) {
          try {
            const ids = JSON.parse(unlockedE[1]) as CharId[];
            setUnlockedChars(new Set<CharId>(["chicken_gold", ...ids]));
          } catch { /* ignore */ }
        }
        if (selectedE[1]) setSelectedChar(selectedE[1] as CharId);
        if (highE[1]) setHighScore(parseInt(highE[1], 10) || 0);
        // Daily data — restore only if saved today
        const todayKey = getDateKey();
        if (dayKeyE[1] === todayKey) {
          if (rewardE[1] === "true") setDailyRewardClaimed(true);
          if (progressE[1]) {
            try { setDailyAchProgress(JSON.parse(progressE[1])); } catch { /* ignore */ }
          }
          if (claimedE[1]) {
            try { setDailyAchClaimed(new Set(JSON.parse(claimedE[1]) as string[])); } catch { /* ignore */ }
          }
          if (roundsE[1]) setRoundsToday(parseInt(roundsE[1], 10) || 0);
        }
      })
      .catch(() => {})
      .finally(() => setSaveLoaded(true));
  }, []);

  // ── Update high score + achievement progress when game ends ──────────────
  useEffect(() => {
    if (!gameOver) return;
    const roundCoins = stateRef.current.coinScore;
    const beatsRecord = score > highScore;
    if (beatsRecord) setHighScore(score);
    setRoundsToday((prevRounds) => {
      const newRounds = prevRounds + 1;
      setDailyAchProgress((prev) => {
        const next = { ...prev };
        for (const ach of getDailyAchievements()) {
          if (ach.type === "score")             next[ach.id] = Math.max(next[ach.id] ?? 0, score);
          else if (ach.type === "coins_round")  next[ach.id] = Math.max(next[ach.id] ?? 0, roundCoins);
          else if (ach.type === "rounds_today") next[ach.id] = newRounds;
          else if (ach.type === "beat_record" && beatsRecord) next[ach.id] = 1;
        }
        return next;
      });
      return newRounds;
    });
  }, [gameOver, score, highScore]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save wallet + unlocks whenever they change (after initial load) ────────
  useEffect(() => {
    if (!saveLoaded) return;
    AsyncStorage.multiSet([
      ["pollo_coins",    String(totalCoins)],
      ["pollo_unlocked", JSON.stringify([...unlockedChars])],
      ["pollo_selected", selectedChar],
      ["pollo_high",     String(highScore)],
    ]).catch(() => {});
  }, [totalCoins, unlockedChars, selectedChar, highScore, saveLoaded]);

  // ── Save daily data whenever it changes ───────────────────────────────────
  useEffect(() => {
    if (!saveLoaded) return;
    AsyncStorage.multiSet([
      ["pollo_day_key",      getDateKey()],
      ["pollo_day_reward",   dailyRewardClaimed ? "true" : "false"],
      ["pollo_day_progress", JSON.stringify(dailyAchProgress)],
      ["pollo_day_claimed",  JSON.stringify([...dailyAchClaimed])],
      ["pollo_day_rounds",   String(roundsToday)],
    ]).catch(() => {});
  }, [dailyRewardClaimed, dailyAchProgress, dailyAchClaimed, roundsToday, saveLoaded]);

  const claimDailyReward = useCallback(() => {
    setDailyRewardClaimed(true);
    setTotalCoins((prev) => prev + 25);
  }, []);

  const claimAchievement = useCallback((ach: AchievementDef) => {
    setDailyAchClaimed((prev) => {
      const next = new Set(prev);
      next.add(ach.id);
      return next;
    });
    setTotalCoins((prev) => prev + ach.reward);
  }, []);

  const stateRef = useRef<GameStateRef>({
    playerX: 0,
    playerZ: 0,
    playerMesh: null,
    camera: null,
    scene: null,
    renderer: null,
    gl: null,
    rows: [],
    coins: [],
    maxRowIdx: 0,
    hop: { active: false, fromX: 0, fromZ: 0, toX: 0, toZ: 0, startMs: 0 },
    dead: false,
    deadMs: 0,
    score: 0,
    maxScore: 0,
    coinScore: 0,
    animId: null,
  });

  const [coins, setCoins] = useState(0);
  const [cameraMode, setCameraMode] = useState<CameraMode>("exterior");

  // ── Free-look refs for interior first-person mode ──
  const camYawRef   = useRef(0);   // horizontal rotation (radians)
  const camPitchRef = useRef(0);   // vertical tilt (radians, clamped)
  const lastTouchRef = useRef({ x: 0, y: 0 });

  const setScoreRef = useRef(setScore);
  const setGameOverRef = useRef(setGameOver);
  const setCoinsRef = useRef(setCoins);
  const setTotalCoinsRef = useRef(setTotalCoins);
  const cameraModeRef = useRef<CameraMode>("exterior");

  setScoreRef.current = setScore;
  setGameOverRef.current = setGameOver;
  setCoinsRef.current = setCoins;
  setTotalCoinsRef.current = setTotalCoins;
  // keep ref in sync with state so the game loop can read it without re-binding
  cameraModeRef.current = cameraMode;

  // ── PanResponder — only hijacks drag in interior mode ──────────────────
  const panResponder = useRef(
    PanResponder.create({
      // Don't steal tap-start so D-pad buttons still fire
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      // Claim the gesture once a drag starts and we're in interior mode
      onMoveShouldSetPanResponder: () =>
        cameraModeRef.current === "interior",
      onMoveShouldSetPanResponderCapture: () => false,
      onPanResponderGrant: (e) => {
        lastTouchRef.current = {
          x: e.nativeEvent.pageX,
          y: e.nativeEvent.pageY,
        };
      },
      onPanResponderMove: (e) => {
        const dx = e.nativeEvent.pageX - lastTouchRef.current.x;
        const dy = e.nativeEvent.pageY - lastTouchRef.current.y;
        lastTouchRef.current = {
          x: e.nativeEvent.pageX,
          y: e.nativeEvent.pageY,
        };
        camYawRef.current   += dx * 0.005;
        camPitchRef.current -= dy * 0.005;
        // Clamp pitch so camera can't flip over
        camPitchRef.current = Math.max(-0.65, Math.min(0.65, camPitchRef.current));
      },
    })
  ).current;

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

      // ── Spawn coins on grass rows (40% chance, skip row 0) ──
      if (kind === "grass" && idx > 0 && Math.random() < 0.45) {
        const numCoins = Math.random() < 0.3 ? 2 : 1;
        const usedX = new Set<number>();
        for (let ci = 0; ci < numCoins; ci++) {
          let cx = Math.round(Math.random() * BOARD_HALF * 2 - BOARD_HALF);
          if (usedX.has(cx)) cx = cx >= 0 ? cx - 1 : cx + 1;
          usedX.add(cx);
          const coinMesh = makeCoin();
          coinMesh.position.set(cx, 0.28, -idx * CELL);
          s.scene.add(coinMesh);
          s.coins.push({ mesh: coinMesh, x: cx, rowIdx: idx, collected: false });
        }
      }

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
    // Remove coins behind the player
    s.coins = s.coins.filter((coin) => {
      if (coin.rowIdx < cutoff) {
        if (!coin.collected) s.scene!.remove(coin.mesh);
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
        s.deadMs = performance.now();
        setTotalCoinsRef.current((prev) => prev + s.coinScore);
        s.coinScore = 0;
        setGameOverRef.current(true);
        playCrashSoundRef.current();
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

      const chicken = makePlayerMesh(selectedCharRef.current);
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
                  s.deadMs = performance.now();
                  setTotalCoinsRef.current((prev) => prev + s.coinScore);
                  s.coinScore = 0;
                  setGameOverRef.current(true);
                  playCrashSoundRef.current();
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
          // Small double-step bob: two gentle lifts matching each leg stride
          const bob = Math.abs(Math.sin(t * Math.PI * 2)) * 0.04;
          if (s.playerMesh) {
            s.playerMesh.position.set(x, bob, z);
            if (s.hop.toX !== s.hop.fromX) {
              s.playerMesh.rotation.y =
                s.hop.toX > s.hop.fromX ? Math.PI / 2 : -Math.PI / 2;
            } else {
              s.playerMesh.rotation.y = s.hop.toZ > s.hop.fromZ ? Math.PI : 0;
            }
            // ── Walk animation: swing legs in sync with body bob ──
            const legs = s.playerMesh.userData.legs as THREE.Group[] | undefined;
            if (legs && legs.length > 0) {
              // One full gait cycle per step: matches the double-bob above
              const swing = Math.sin(t * Math.PI * 2) * 0.75;
              if (legs.length >= 4) {
                // Diagonal gait: FL+BR swing forward, FR+BL swing back
                legs[0].rotation.x =  swing;  // front-left
                legs[1].rotation.x = -swing;  // front-right
                legs[2].rotation.x = -swing;  // back-left
                legs[3].rotation.x =  swing;  // back-right
              } else {
                // 2 legs (chicken): alternate
                legs[0].rotation.x =  swing;
                legs[1].rotation.x = -swing;
              }
            }
          }
          if (t >= 1) {
            s.hop.active = false;
            s.playerX = s.hop.toX;
            s.playerZ = s.hop.toZ;
            if (s.playerMesh) {
              s.playerMesh.position.set(s.playerX, 0, -s.playerZ);
              // Reset legs to neutral pose
              const legs = s.playerMesh.userData.legs as THREE.Group[] | undefined;
              if (legs) legs.forEach((l) => { l.rotation.x = 0; });
            }
            checkCollision();
            // ── Collect only the coin at the exact landing spot ──
            for (const coin of s.coins) {
              if (!coin.collected && coin.rowIdx === s.playerZ &&
                  Math.abs(coin.x - s.playerX) < 0.55) {
                coin.collected = true;
                s.scene!.remove(coin.mesh);
                s.coinScore++;
                setCoinsRef.current(s.coinScore);
                playCoinSoundRef.current();
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              }
            }
          }
        }

        // ── Death squash animation ──
        if (s.dead && s.playerMesh) {
          const dt2 = Math.min((now - s.deadMs) / 350, 1);
          const squashY = 1 - dt2 * 0.82;         // flatten to 18% height
          const squashXZ = 1 + dt2 * 0.9;         // spread out sideways
          const spin = dt2 * Math.PI * 0.4;        // slight rotation on impact
          s.playerMesh.scale.set(squashXZ * 0.48, squashY * 0.48, squashXZ * 0.48);
          s.playerMesh.rotation.z = spin;
          s.playerMesh.position.y = -dt2 * 0.05;
        }
        // ── Idle animation: gentle sway when standing still ──
        else if (!s.hop.active && s.playerMesh && !s.dead) {
          const idleT = now * 0.0022;
          s.playerMesh.rotation.z = Math.sin(idleT) * 0.06;
          s.playerMesh.position.y = Math.sin(idleT * 1.3) * 0.015;
        }

        // ── Coin spin + bob animation ──
        for (const coin of s.coins) {
          if (!coin.collected) {
            coin.mesh.rotation.y += dt * 2.8;
            coin.mesh.position.y = 0.28 + Math.sin(now * 0.0028 + coin.x) * 0.07;
          }
        }

        // ── Camera — exterior (overhead) or interior (first-person eyes) ──
        if (s.camera && s.playerMesh) {
          const px = s.playerMesh.position.x;
          const pz = s.playerMesh.position.z; // world Z = -playerZ (negative = forward)
          if (cameraModeRef.current === "exterior") {
            // Show chicken in exterior mode
            s.playerMesh.visible = true;
            const tx = px * 0.28;
            const tz = pz + 7.5;
            s.camera.position.x += (tx - s.camera.position.x) * 0.1;
            s.camera.position.y += (9 - s.camera.position.y) * 0.06;
            s.camera.position.z += (tz - s.camera.position.z) * 0.1;
            s.camera.lookAt(px, 0, pz - 1);
          } else {
            // Interior: camera at chicken's eye level, hidden model, first-person
            s.playerMesh.visible = false;
            const eyeY = s.playerMesh.position.y + 0.38;
            const eyeZ = pz - 0.1;
            s.camera.position.x += (px   - s.camera.position.x) * 0.22;
            s.camera.position.y += (eyeY - s.camera.position.y) * 0.22;
            s.camera.position.z += (eyeZ - s.camera.position.z) * 0.22;
            // Free-look: compute look target from yaw + pitch
            const lookDist = 9;
            const lookX = px  + Math.sin(camYawRef.current) * lookDist;
            const lookY = eyeY + Math.sin(camPitchRef.current) * lookDist * 0.5;
            const lookZ = eyeZ - Math.cos(camYawRef.current) * lookDist;
            s.camera.lookAt(lookX, lookY, lookZ);
          }
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
      playHopSoundRef.current();
      // Character "voice" chirps occasionally so it's not overbearing
      if (Math.random() < 0.25) playCharacterSoundRef.current();
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
        // +5 monedas solo al cruzar una carretera
        const crossedRow = s.rows.find((r) => r.rowIdx === newZ);
        if (crossedRow?.kind === "road") {
          s.coinScore += 5;
          setCoinsRef.current(s.coinScore);
        }
      }
      generateRows(newZ + SAFE_AHEAD);
      pruneRows();
    },
    [generateRows, pruneRows]
  );

  /**
   * In first-person mode the d-pad moves relative to where you're looking.
   * We rotate the input vector by the camera yaw, then snap to the nearest
   * cardinal grid direction before forwarding to move().
   */
  const moveRelative = useCallback(
    (gdx: number, gdz: number) => {
      if (cameraModeRef.current !== "interior") {
        move(gdx, gdz);
        return;
      }
      const yaw = camYawRef.current;
      // Rotate input by yaw to get world-space XZ direction
      const wx =  gdx * Math.cos(yaw) + gdz * Math.sin(yaw);
      const wz =  gdx * Math.sin(yaw) - gdz * Math.cos(yaw);
      // Snap to the dominant cardinal axis
      let snapX = 0, snapZ = 0;
      if (Math.abs(wx) >= Math.abs(wz)) {
        snapX = Math.sign(wx);
      } else {
        snapZ = Math.sign(wz);
      }
      // Convert world snap back to game move coords (game_dz = -world_wz)
      move(snapX, -snapZ);
    },
    [move]
  );

  const restart = useCallback(() => {
    const s = stateRef.current;
    if (!s.scene || !s.playerMesh) return;
    // Coins already accumulated at death — coinScore reset to 0 at that point
    for (const row of s.rows) {
      s.scene.remove(row.mesh);
      row.cars.forEach((c) => s.scene!.remove(c.mesh));
    }
    for (const coin of s.coins) {
      if (!coin.collected) s.scene.remove(coin.mesh);
    }
    // Swap player mesh to match selected character
    s.scene.remove(s.playerMesh);
    const newMesh = makePlayerMesh(selectedCharRef.current);
    newMesh.position.set(0, 0, 0);
    s.scene.add(newMesh);
    s.playerMesh = newMesh;

    s.rows = [];
    s.coins = [];
    s.maxRowIdx = 0;
    s.playerX = 0;
    s.playerZ = 0;
    s.score = 0;
    s.maxScore = 0;
    s.coinScore = 0;
    s.dead = false;
    s.deadMs = 0;
    s.hop = { active: false, fromX: 0, fromZ: 0, toX: 0, toZ: 0, startMs: 0 };
    if (s.playerMesh) {
      s.playerMesh.scale.setScalar(0.48);
      s.playerMesh.rotation.z = 0;
      s.playerMesh.position.y = 0;
    }
    generateRows(VISIBLE_ROWS);
    setScore(0);
    setCoins(0);
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
    <View style={styles.root} {...panResponder.panHandlers}>
      {/* Main game renderer — hidden while a character preview or thumbnail
          minting is active so only one WebGL context runs at a time. */}
      {webGLAvailable && !previewChar && !mintingChar && (
        <GLView
          style={StyleSheet.absoluteFill}
          onContextCreate={onContextCreate}
        />
      )}

      {/* Thumbnail minter — offscreen, replaces main GLView during minting */}
      {mintingChar && (
        <ThumbnailMinter charId={mintingChar} onDone={handleMintDone} />
      )}

      {/* Score + Coins */}
      {started && !gameOver && (
        <View style={styles.topBar} pointerEvents="none">
          <View style={styles.scoreBox}>
            <Text style={styles.scoreText}>🐾 {score}</Text>
          </View>
          <View style={styles.coinBox}>
            <Text style={styles.coinText}>🪙 {coins}</Text>
          </View>
        </View>
      )}

      {/* Mute toggle — always visible */}
      <TouchableOpacity
        style={styles.muteBtn}
        onPress={() => setMuted((m) => !m)}
        activeOpacity={0.75}
      >
        <Text style={styles.muteBtnText}>{muted ? "🔇" : "🔊"}</Text>
      </TouchableOpacity>

      {/* Camera toggle */}
      {started && !gameOver && (
        <TouchableOpacity
          style={styles.camBtn}
          onPress={() => {
            setCameraMode((m) => {
              const next = m === "exterior" ? "interior" : "exterior";
              // Reset free-look angles when switching modes
              if (next === "exterior") {
                camYawRef.current   = 0;
                camPitchRef.current = 0;
              }
              return next;
            });
          }}
          activeOpacity={0.75}
        >
          <Text style={styles.camBtnText}>
            {cameraMode === "exterior" ? "🎥" : "👁️"}
          </Text>
          <Text style={styles.camBtnLabel}>
            {cameraMode === "exterior" ? "exterior" : "interior"}
          </Text>
        </TouchableOpacity>
      )}

      {/* Start screen */}
      {!started && !showShop && (
        <View style={styles.overlay}>
          <Text style={styles.titleEmoji}>
            {CHARACTERS.find((c) => c.id === selectedChar)?.emoji ?? "🐔"}
          </Text>
          <Text style={styles.gameName}>Pollo Crossy</Text>
          <Text style={styles.subtitle}>Cruza la calle sin que te atropellen</Text>
          {highScore > 0 && (
            <View style={styles.walletRow}>
              <Text style={styles.walletText}>🏆 Récord: {highScore}</Text>
            </View>
          )}
          {totalCoins > 0 && (
            <View style={styles.walletRow}>
              <Text style={styles.walletText}>💰 {totalCoins} monedas</Text>
            </View>
          )}
          <TouchableOpacity
            style={styles.startBtn}
            onPress={() => setStarted(true)}
          >
            <Text style={styles.startBtnText}>JUGAR</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.shopBtn}
            onPress={() => setShowShop(true)}
          >
            <Text style={styles.shopBtnText}>🛒  PERSONAJES</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.shopBtn, dailyRewardClaimed && styles.shopBtnClaimed]}
            onPress={dailyRewardClaimed ? undefined : claimDailyReward}
            activeOpacity={dailyRewardClaimed ? 1 : 0.75}
          >
            <Text style={styles.shopBtnText}>
              {dailyRewardClaimed ? "✓ Recompensa reclamada" : "🎁 RECLAMAR +25 🪙"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.shopBtn}
            onPress={() => setShowAchievements(true)}
          >
            <Text style={styles.shopBtnText}>🏅 LOGROS DEL DÍA</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Game over */}
      {gameOver && !showShop && !showAchievements && (
        <View style={styles.overlay}>
          <Text style={styles.gameOverTitle}>¡Oh no!</Text>
          <Text style={styles.gameOverSub}>¡Fue atropellado!</Text>
          <Text style={styles.gameOverScore}>{score}</Text>
          <Text style={styles.gameOverLabel}>filas cruzadas</Text>
          {score > 0 && score >= highScore && (
            <Text style={styles.newRecordText}>🏆 ¡Nuevo récord!</Text>
          )}
          {score < highScore && (
            <Text style={styles.gameOverCoinText}>🏆 Récord: {highScore}</Text>
          )}
          <View style={styles.gameOverCoins}>
            <Text style={styles.gameOverCoinText}>🪙 {coins} esta ronda</Text>
          </View>
          <View style={styles.gameOverCoins}>
            <Text style={styles.gameOverCoinText}>💰 {totalCoins} total</Text>
          </View>
          <TouchableOpacity style={styles.startBtn} onPress={restart}>
            <Text style={styles.startBtnText}>JUGAR DE NUEVO</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.shopBtn}
            onPress={() => setShowShop(true)}
          >
            <Text style={styles.shopBtnText}>🛒  PERSONAJES</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.shopBtn}
            onPress={() => setShowAchievements(true)}
          >
            <Text style={styles.shopBtnText}>🏅 LOGROS DEL DÍA</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Achievements overlay */}
      {showAchievements && (
        <View style={styles.shopOverlay}>
          <Text style={styles.shopTitle}>🏅 LOGROS DEL DÍA</Text>
          <Text style={styles.shopWallet}>💰 {totalCoins} monedas</Text>
          <Text style={styles.achSubtitle}>Nuevos logros mañana</Text>
          <ScrollView
            style={styles.shopScroll}
            contentContainerStyle={styles.shopList}
            showsVerticalScrollIndicator={false}
          >
            {getDailyAchievements().map((ach) => {
              const progress = dailyAchProgress[ach.id] ?? 0;
              const completed = progress >= ach.target;
              const claimed = dailyAchClaimed.has(ach.id);
              const pct = Math.min(1, progress / ach.target);
              return (
                <View key={ach.id} style={[styles.achCard, claimed && styles.achCardClaimed]}>
                  <View style={styles.achInfo}>
                    <Text style={styles.achTitle}>{ach.title}</Text>
                    <Text style={styles.achDesc}>{ach.desc}</Text>
                    <View style={styles.achBarBg}>
                      <View style={[styles.achBarFill, { width: `${Math.round(pct * 100)}%` as any }]} />
                    </View>
                    <Text style={styles.achProgressText}>
                      {claimed ? "✓ Reclamado" : `${Math.min(progress, ach.target)} / ${ach.target}`}
                    </Text>
                  </View>
                  <View style={styles.achRight}>
                    <Text style={styles.achReward}>+{ach.reward}🪙</Text>
                    <TouchableOpacity
                      style={[
                        styles.achBtn,
                        claimed ? styles.achBtnDone : completed ? styles.achBtnReady : styles.achBtnLocked,
                      ]}
                      onPress={() => { if (!claimed && completed) claimAchievement(ach); }}
                      disabled={claimed || !completed}
                    >
                      <Text style={styles.achBtnText}>
                        {claimed ? "✓" : completed ? "RECLAMAR" : "🔒"}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </ScrollView>
          <TouchableOpacity style={styles.shopBackBtn} onPress={() => setShowAchievements(false)}>
            <Text style={styles.shopBackText}>← VOLVER</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Character Shop overlay */}
      {showShop && !previewChar && (
        <View style={styles.shopOverlay}>
          <Text style={styles.shopTitle}>🛒  PERSONAJES</Text>
          <Text style={styles.shopWallet}>💰 {totalCoins} monedas</Text>
          <ScrollView
            style={styles.shopScroll}
            contentContainerStyle={styles.shopList}
            showsVerticalScrollIndicator={false}
          >
            {CHARACTERS.map((char) => {
              const owned    = unlockedChars.has(char.id);
              const selected = selectedChar === char.id;
              return (
                <TouchableOpacity
                  key={char.id}
                  style={[styles.charCard, selected && styles.charCardSelected]}
                  onPress={() => setPreviewChar(char.id)}
                  activeOpacity={0.78}
                >
                  {charThumbnails[char.id] ? (
                    <Image
                      source={{ uri: charThumbnails[char.id] }}
                      style={styles.charThumb}
                    />
                  ) : (
                    <Text style={styles.charEmoji}>{char.emoji}</Text>
                  )}
                  <View style={styles.charInfo}>
                    <Text style={styles.charName}>{char.name}</Text>
                    {owned ? (
                      <Text style={styles.charOwned}>✓ Desbloqueado</Text>
                    ) : (
                      <Text style={styles.charCost}>🪙 {char.cost} monedas</Text>
                    )}
                    <Text style={styles.charDescSnippet} numberOfLines={1}>
                      {CHAR_DESC[char.id]}
                    </Text>
                  </View>
                  <Text style={styles.charArrow}>›</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <TouchableOpacity
            style={styles.shopBackBtn}
            onPress={() => setShowShop(false)}
          >
            <Text style={styles.shopBackText}>← VOLVER</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Character detail / preview overlay */}
      {showShop && previewChar && (() => {
        const char = CHARACTERS.find((c) => c.id === previewChar)!;
        const owned  = unlockedChars.has(char.id);
        const active = selectedChar === char.id;
        const canBuy = !owned && totalCoins >= char.cost;
        return (
          <View style={styles.shopOverlay}>
            <TouchableOpacity
              style={styles.previewBack}
              onPress={() => setPreviewChar(null)}
            >
              <Text style={styles.shopBackText}>← PERSONAJES</Text>
            </TouchableOpacity>

            {/* 3-D animated preview */}
            <CharacterPreviewGL charId={previewChar} />

            <Text style={styles.previewName}>{char.emoji}  {char.name}</Text>
            <Text style={styles.previewDesc}>{CHAR_DESC[char.id]}</Text>

            <View style={styles.previewDivider} />

            {owned ? (
              <TouchableOpacity
                style={[styles.startBtn, active && { backgroundColor: "#69f0ae" }]}
                onPress={() => {
                  setSelectedChar(char.id);
                  setPreviewChar(null);
                  setShowShop(false);
                }}
              >
                <Text style={styles.startBtnText}>
                  {active ? "✓ USANDO" : "USAR ESTE"}
                </Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.startBtn, !canBuy && { opacity: 0.45 }]}
                onPress={() => {
                  if (!canBuy) return;
                  setTotalCoins((prev) => prev - char.cost);
                  setUnlockedChars((prev) => {
                    const next = new Set(prev);
                    next.add(char.id);
                    return next;
                  });
                  setSelectedChar(char.id);
                  setPreviewChar(null);
                  setShowShop(false);
                }}
                disabled={!canBuy}
              >
                <Text style={styles.startBtnText}>
                  {canBuy ? `🪙 COMPRAR — ${char.cost}` : `🔒 ${char.cost} monedas`}
                </Text>
              </TouchableOpacity>
            )}
            <Text style={styles.shopWallet}>💰 tienes {totalCoins} monedas</Text>
          </View>
        );
      })()}

      {/* D-pad */}
      {started && !gameOver && (
        <View style={styles.dpad}>
          <View style={styles.dpadRow}>
            <TouchableOpacity
              style={styles.dpadBtn}
              onPress={() => moveRelative(0, 1)}
              activeOpacity={0.7}
            >
              <Text style={styles.dpadArrow}>▲</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.dpadRow}>
            <TouchableOpacity
              style={styles.dpadBtn}
              onPress={() => moveRelative(-1, 0)}
              activeOpacity={0.7}
            >
              <Text style={styles.dpadArrow}>◀</Text>
            </TouchableOpacity>
            <View style={styles.dpadCenter} />
            <TouchableOpacity
              style={styles.dpadBtn}
              onPress={() => moveRelative(1, 0)}
              activeOpacity={0.7}
            >
              <Text style={styles.dpadArrow}>▶</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.dpadRow}>
            <TouchableOpacity
              style={styles.dpadBtn}
              onPress={() => moveRelative(0, -1)}
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
  topBar: {
    position: "absolute",
    top: Platform.OS === "web" ? 80 : 56,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
  },
  scoreBox: {
    backgroundColor: "rgba(0,0,0,0.52)",
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 7,
  },
  scoreText: {
    color: "#fff",
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: 1,
  },
  coinBox: {
    backgroundColor: "rgba(0,0,0,0.52)",
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 7,
  },
  coinText: {
    color: "#FFD700",
    fontSize: 24,
    fontWeight: "800",
  },
  muteBtn: {
    position: "absolute",
    top: Platform.OS === "web" ? 80 : 56,
    left: 16,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: "center",
    zIndex: 20,
  },
  muteBtnText: {
    fontSize: 22,
  },
  camBtn: {
    position: "absolute",
    top: Platform.OS === "web" ? 80 : 56,
    right: 16,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: "center",
  },
  camBtnText: {
    fontSize: 22,
  },
  camBtnLabel: {
    color: "#ffffffcc",
    fontSize: 9,
    fontWeight: "600",
    letterSpacing: 0.5,
    marginTop: 2,
  },
  gameOverCoins: {
    backgroundColor: "rgba(255,215,0,0.18)",
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 6,
    marginTop: 2,
  },
  gameOverCoinText: {
    color: "#FFD700",
    fontSize: 20,
    fontWeight: "700",
  },
  newRecordText: {
    color: "#FFD700",
    fontSize: 22,
    fontWeight: "900",
    letterSpacing: 1,
    marginVertical: 4,
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
  walletRow: {
    backgroundColor: "rgba(255,215,0,0.18)",
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 6,
    marginBottom: 4,
  },
  walletText: {
    color: "#FFD700",
    fontSize: 17,
    fontWeight: "700",
  },
  shopBtn: {
    marginTop: 6,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 32,
    paddingHorizontal: 36,
    paddingVertical: 12,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.35)",
  },
  shopBtnText: {
    fontSize: 15,
    fontWeight: "800",
    color: "#fff",
    letterSpacing: 1.5,
  },
  shopOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(10,10,30,0.97)",
    alignItems: "center",
    paddingTop: Platform.OS === "web" ? 60 : 52,
    paddingBottom: 24,
  },
  shopTitle: {
    fontSize: 28,
    fontWeight: "900",
    color: "#FFD700",
    letterSpacing: 1,
    marginBottom: 6,
  },
  shopWallet: {
    fontSize: 17,
    fontWeight: "700",
    color: "#FFD700",
    marginBottom: 16,
  },
  shopScroll: {
    width: "100%",
  },
  shopList: {
    paddingHorizontal: 20,
    gap: 12,
    paddingBottom: 12,
  },
  charCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.07)",
    borderRadius: 18,
    padding: 14,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.1)",
  },
  charCardSelected: {
    borderColor: "#FFD700",
    backgroundColor: "rgba(255,215,0,0.12)",
  },
  charEmoji: {
    fontSize: 40,
    marginRight: 14,
  },
  charInfo: {
    flex: 1,
    gap: 3,
  },
  charName: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "800",
  },
  charOwned: {
    color: "#69f0ae",
    fontSize: 13,
    fontWeight: "600",
  },
  charCost: {
    color: "#FFD700",
    fontSize: 13,
    fontWeight: "700",
  },
  charDescSnippet: {
    color: "#ffffff88",
    fontSize: 11,
    fontWeight: "500",
  },
  charArrow: {
    color: "#ffffff55",
    fontSize: 28,
    fontWeight: "300",
    marginLeft: 6,
  },
  previewGLView: {
    width: "100%",
    height: 220,
    borderRadius: 20,
    overflow: "hidden",
    marginBottom: 6,
    backgroundColor: "#141428",
  },
  thumbMinter: {
    // Offscreen but real size so drawingBuffer is non-zero
    width: 100,
    height: 100,
    position: "absolute",
    top: -600,
    left: -600,
    opacity: 0,
  },
  charThumb: {
    width: 56,
    height: 56,
    borderRadius: 12,
    marginRight: 14,
    backgroundColor: "#1a1a2e",
  },
  previewBack: {
    alignSelf: "flex-start",
    marginHorizontal: 16,
    marginBottom: 10,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  previewName: {
    color: "#FFD700",
    fontSize: 24,
    fontWeight: "900",
    letterSpacing: 0.5,
    marginTop: 8,
    textAlign: "center",
  },
  previewDesc: {
    color: "#ffffffcc",
    fontSize: 14,
    fontWeight: "500",
    textAlign: "center",
    paddingHorizontal: 28,
    lineHeight: 20,
    marginTop: 6,
  },
  previewDivider: {
    height: 1,
    width: "80%",
    backgroundColor: "rgba(255,255,255,0.12)",
    marginVertical: 14,
  },
  charBtn: {
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 9,
    minWidth: 86,
    alignItems: "center",
  },
  charBtnActive: {
    backgroundColor: "#FFD700",
  },
  charBtnSelect: {
    backgroundColor: "#4caf50",
  },
  charBtnBuy: {
    backgroundColor: "#1976d2",
  },
  charBtnLocked: {
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  charBtnText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 1,
  },
  shopBackBtn: {
    marginTop: 16,
    backgroundColor: "rgba(255,255,255,0.14)",
    borderRadius: 24,
    paddingHorizontal: 36,
    paddingVertical: 13,
  },
  shopBackText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 1,
  },
  shopBtnClaimed: {
    opacity: 0.5,
  },
  achSubtitle: {
    color: "#ffffffaa",
    fontSize: 12,
    marginBottom: 12,
    letterSpacing: 0.5,
  },
  achCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.07)",
    borderRadius: 18,
    padding: 14,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.1)",
    gap: 12,
  },
  achCardClaimed: {
    borderColor: "#69f0ae",
    backgroundColor: "rgba(105,240,174,0.08)",
  },
  achInfo: {
    flex: 1,
    gap: 4,
  },
  achTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "800",
  },
  achDesc: {
    color: "#ffffffcc",
    fontSize: 12,
    fontWeight: "500",
  },
  achBarBg: {
    height: 6,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 3,
    overflow: "hidden",
    marginTop: 4,
  },
  achBarFill: {
    height: 6,
    backgroundColor: "#FFD700",
    borderRadius: 3,
  },
  achProgressText: {
    color: "#ffffffaa",
    fontSize: 11,
    fontWeight: "600",
    marginTop: 2,
  },
  achRight: {
    alignItems: "center",
    gap: 6,
  },
  achReward: {
    color: "#FFD700",
    fontSize: 15,
    fontWeight: "900",
  },
  achBtn: {
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 80,
    alignItems: "center",
  },
  achBtnReady: {
    backgroundColor: "#4caf50",
  },
  achBtnDone: {
    backgroundColor: "rgba(105,240,174,0.3)",
  },
  achBtnLocked: {
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  achBtnText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.5,
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
