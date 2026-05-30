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
  grass: 0x5db85d,
  grassAlt: 0x4a9a4a,
  road: 0x555555,
  roadLine: 0xeeee33,
  carColors: [0xe74c3c, 0x3498db, 0x9b59b6, 0xe67e22, 0x1abc9c, 0xf39c12],
  chicken: 0xffd700,
  beak: 0xff8c00,
  eye: 0x111111,
  wheel: 0x1a1a1a,
  comb: 0xff3333,
  leg: 0xff8c00,
  houseWall: [0xf5deb3, 0xffe4c4, 0xfaebd7, 0xe8d5b7, 0xddd0b0, 0xcfcfba],
  houseRoof: [0xcc3333, 0x993311, 0x446688, 0x774422, 0x553366],
  door: 0x8b4513,
  windowGlass: 0xaaddff,
};

// ─── Three.js object factories ────────────────────────────────────────────────

/** Cars travel along X. speed is shared per-row so they never catch up to each other. */
function makeCar(dir: 1 | -1, rowZ: number, rowSpeed: number): CarObj {
  const g = new THREE.Group();
  const len = 1.5 + Math.random() * 0.8; // length along X (travel axis)
  const dep = 0.72; // depth along Z
  const colorHex = C.carColors[Math.floor(Math.random() * C.carColors.length)];
  const mat = new THREE.MeshLambertMaterial({ color: colorHex });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x111122 });
  const lightMat = new THREE.MeshLambertMaterial({ color: 0xffffaa });
  const wheelMat = new THREE.MeshLambertMaterial({ color: C.wheel });

  // body
  const body = new THREE.Mesh(new THREE.BoxGeometry(len, 0.38, dep), mat);
  body.position.y = 0.26;
  g.add(body);
  // cabin
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(len * 0.58, 0.28, dep * 0.88),
    mat
  );
  cabin.position.set(0, 0.59, 0);
  g.add(cabin);

  // front windscreen + headlights face the direction of travel
  const frontX = dir > 0 ? len / 2 - 0.01 : -(len / 2 - 0.01);
  const wind = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.22, dep * 0.76),
    darkMat
  );
  wind.position.set(frontX, 0.6, 0);
  g.add(wind);
  [-dep * 0.28, dep * 0.28].forEach((lz) => {
    const light = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.1, 0.12),
      lightMat
    );
    light.position.set(frontX, 0.28, lz);
    g.add(light);
  });

  // wheels — cylinder axis along Z, placed at four corners
  const wg = new THREE.CylinderGeometry(0.15, 0.15, 0.12, 8);
  const wx = (len / 2) * 0.78;
  const wz = dep / 2 + 0.03;
  [
    [-wx, 0.15, wz],
    [-wx, 0.15, -wz],
    [wx, 0.15, wz],
    [wx, 0.15, -wz],
  ].forEach(([x, y, z]) => {
    const wh = new THREE.Mesh(wg, wheelMat);
    wh.rotation.x = Math.PI / 2;
    wh.position.set(x, y, z);
    g.add(wh);
  });

  const startX = dir === 1 ? -(BOARD_HALF + len + 2) : BOARD_HALF + len + 2;
  g.position.set(startX, 0, rowZ);
  return { mesh: g, x: startX, width: len, dir, speed: rowSpeed };
}

/** A decorative house placed beside the road. seed drives color/size variety. */
function makeHouse(seed: number): THREE.Group {
  const g = new THREE.Group();
  const wallColor = C.houseWall[seed % C.houseWall.length];
  const roofColor = C.houseRoof[seed % C.houseRoof.length];
  const w = 1.0 + (seed % 3) * 0.18;
  const h = 0.75 + (seed % 2) * 0.28;
  const d = 0.85;

  // walls
  const walls = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color: wallColor })
  );
  walls.position.y = h / 2;
  g.add(walls);

  // roof (flat-ish box slightly wider)
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.14, 0.42, d + 0.14),
    new THREE.MeshLambertMaterial({ color: roofColor })
  );
  roof.position.y = h + 0.18;
  g.add(roof);

  // door
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 0.38, 0.05),
    new THREE.MeshLambertMaterial({ color: C.door })
  );
  door.position.set(0, 0.19, d / 2 + 0.01);
  g.add(door);

  // windows
  const winMat = new THREE.MeshLambertMaterial({ color: C.windowGlass });
  const winW = 0.22;
  const winH = 0.18;
  [-w * 0.28, w * 0.28].forEach((wx2, i) => {
    if (i === 0 && w < 1.1) return; // skip left window on tiny houses
    const win = new THREE.Mesh(
      new THREE.BoxGeometry(winW, winH, 0.05),
      winMat
    );
    win.position.set(wx2, h * 0.6, d / 2 + 0.01);
    g.add(win);
  });

  return g;
}

function makeChicken(): THREE.Group {
  const g = new THREE.Group();
  const yMat = new THREE.MeshLambertMaterial({ color: C.chicken });
  const bMat = new THREE.MeshLambertMaterial({ color: C.beak });
  const eMat = new THREE.MeshLambertMaterial({ color: C.eye });
  const cMat = new THREE.MeshLambertMaterial({ color: C.comb });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.52, 0.5), yMat);
  body.position.y = 0.28;
  g.add(body);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.32, 0.36), yMat);
  head.position.set(0, 0.72, 0.08);
  g.add(head);

  const beak = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.09, 0.16), bMat);
  beak.position.set(0, 0.7, 0.3);
  g.add(beak);

  const eg = new THREE.BoxGeometry(0.07, 0.07, 0.04);
  [-0.11, 0.11].forEach((ex) => {
    const eye = new THREE.Mesh(eg, eMat);
    eye.position.set(ex, 0.77, 0.28);
    g.add(eye);
  });

  const comb = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.13, 0.07), cMat);
  comb.position.set(0, 0.95, 0.06);
  g.add(comb);

  const legMat = new THREE.MeshLambertMaterial({ color: C.leg });
  const lg = new THREE.BoxGeometry(0.09, 0.18, 0.09);
  [-0.14, 0.14].forEach((lx) => {
    const leg = new THREE.Mesh(lg, legMat);
    leg.position.set(lx, 0.02, 0);
    g.add(leg);
  });

  return g;
}

/** Grass row — includes houses on both sides (except row 0, the starting tile). */
function makeGrassRow(rowIdx: number): THREE.Group {
  const g = new THREE.Group();

  // ground tile
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(BOARD_HALF * 2 + 2, 0.16, CELL),
    new THREE.MeshLambertMaterial({
      color: rowIdx % 2 === 0 ? C.grass : C.grassAlt,
    })
  );
  base.position.y = -0.08;
  g.add(base);

  // houses on both sides (skip row 0 so the player isn't hemmed in at start)
  if (rowIdx > 0) {
    const leftHouse = makeHouse(rowIdx * 2);
    leftHouse.position.set(-(BOARD_HALF + 2.0), 0, 0);
    g.add(leftHouse);

    const rightHouse = makeHouse(rowIdx * 2 + 1);
    rightHouse.position.set(BOARD_HALF + 2.0, 0, 0);
    g.add(rightHouse);
  }

  g.position.set(0, 0, -rowIdx * CELL);
  return g;
}

function makeRoadRow(rowIdx: number): THREE.Group {
  const group = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(BOARD_HALF * 2 + 2, 0.1, CELL),
    new THREE.MeshLambertMaterial({ color: C.road })
  );
  group.add(base);
  for (let i = -BOARD_HALF + 1; i <= BOARD_HALF - 1; i += 2.5) {
    const dash = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.01, 0.1),
      new THREE.MeshLambertMaterial({ color: C.roadLine })
    );
    dash.position.set(i, 0.06, 0);
    group.add(dash);
  }
  group.position.set(0, -0.05, -rowIdx * CELL);
  return group;
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
      });
      renderer.setSize(w, h);
      s.renderer = renderer;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(C.sky);
      scene.fog = new THREE.FogExp2(C.sky, 0.038);
      s.scene = scene;

      const camera = new THREE.PerspectiveCamera(58, w / h, 0.1, 80);
      camera.position.set(0, 8.5, 7.5);
      camera.lookAt(0, 0, 0);
      s.camera = camera;

      scene.add(new THREE.AmbientLight(0xffffff, 0.72));
      const sun = new THREE.DirectionalLight(0xfffbe6, 1.0);
      sun.position.set(5, 12, 5);
      scene.add(sun);

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
          for (const row of s.rows) {
            if (row.kind !== "road") continue;
            for (const car of row.cars) {
              car.x += car.dir * car.speed * dt;
              const limit = BOARD_HALF + car.width + 2.5;
              if (car.dir === 1 && car.x > limit) car.x = -limit;
              else if (car.dir === -1 && car.x < -limit) car.x = limit;
              car.mesh.position.x = car.x;
            }
          }
        }

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
