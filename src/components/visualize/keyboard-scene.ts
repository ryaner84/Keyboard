// The 3D (beta) stage: plain three.js, rendered ON DEMAND (a frame only when
// something changed or the board is being turned), so an idle page costs
// nothing. Lit like a product render rather than a viewport — a studio of
// softboxes baked once into a prefiltered environment, one shadow-casting key
// light, and Khronos PBR Neutral tone mapping, which keeps a hex from
// keycaps.json reading as that hex under white light.
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  NeutralToneMapping,
  Path,
  PCFShadowMap,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PMREMGenerator,
  RepeatWrapping,
  Scene,
  Shape,
  ShadowMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Texture,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildLayout, layoutKeys, placeKeys, type KeycapColors, type LayoutId, type LayoutOptions, type PlacedKey, type Placement } from "@/lib/keycap-visualizer";
import { keysetArrays, PITCH, type Profile } from "@/lib/keycap-geometry";
import { drawAtlas, packAtlas, PX_PER_MM, type AtlasLayout } from "@/lib/legend-atlas";

export type StageView = "angle" | "top";

export interface StageState {
  layout: LayoutId;
  options?: Partial<LayoutOptions>;
  colors: KeycapColors;
  placement?: Placement;
  profile: Profile;
  caseHex: string;
  caseName: string;
  view: StageView;
}

const TYPING_ANGLE = (6 * Math.PI) / 180;
const BEZEL = 11; // case wall beside the keys, mm
const MARGIN = 1; // opening around the keys
const CASE_TOP = 2.5; // the case's top edge, above the cap bottoms
const PLATE_Y = -5; // where the dark plate and switch tops sit
const FRONT_HEIGHT = 17; // case height at the front edge

/** How a case finish reads under light, from its name: anodized, bare, coated or wood. */
export function caseFinish(name: string): { metalness: number; roughness: number; clearcoat: number } {
  const n = name.toLowerCase();
  if (/walnut|wood|oak|maple/.test(n)) return { metalness: 0, roughness: 0.62, clearcoat: 0.25 };
  if (/e-white|e-coat|matte|chalk|frost|powder|shell/.test(n)) return { metalness: 0, roughness: 0.55, clearcoat: 0 };
  if (/silver|grey|gray|raw|bead/.test(n)) return { metalness: 1, roughness: 0.34, clearcoat: 0 };
  // Anodized colour: dyed oxide over aluminium. Fully metallic would turn a
  // black or navy anodize into a void, so it keeps a dielectric share.
  return { metalness: 0.6, roughness: 0.36, clearcoat: 0.2 };
}

function roundedRect(s: Shape | Path, x: number, y: number, w: number, h: number, r: number) {
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
}

// A studio as an environment map: a big overhead softbox, a warm key strip,
// a cool rim and a dim floor bounce, baked once (no HDR download).
function studioEnvironment(renderer: WebGLRenderer): Texture {
  const scene = new Scene();
  scene.background = new Color("#8f9091");
  const panel = (w: number, h: number, intensity: number, color: string, pos: [number, number, number], rot: [number, number, number]) => {
    const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: new Color(color).multiplyScalar(intensity), side: DoubleSide }));
    m.position.set(...pos);
    m.rotation.set(...rot);
    scene.add(m);
  };
  panel(12, 8, 2.4, "#ffffff", [0, 6, 0], [Math.PI / 2, 0, 0]);
  panel(20, 20, 0.7, "#e6e6e6", [0, -3, 0], [-Math.PI / 2, 0, 0]);
  panel(3, 6, 1.3, "#fff4e8", [-6, 2, 4], [0, Math.PI / 4, 0]);
  panel(3, 6, 0.9, "#eaf2ff", [6, 2, -4], [0, (-3 * Math.PI) / 4, 0]);
  panel(8, 2, 0.8, "#ffffff", [0, 1.5, 8], [0, Math.PI, 0]);
  const pmrem = new PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.04);
  pmrem.dispose();
  scene.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      (o.material as MeshBasicMaterial).dispose();
    }
  });
  return target.texture;
}

// Fine moulding grain for the cap surface: a roughness map that varies a few
// percent, so a highlight breaks up the way it does on real ABS instead of
// sitting on the dish like a sticker.
function grainTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < size * size; i++) {
    const g = 222 + rand() * 33;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = g;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new CanvasTexture(canvas);
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

export class KeyboardScene {
  readonly renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(26, 2, 10, 4000);
  private controls: OrbitControls;
  private board = new Group();
  private tilt = new Group();
  private light = new DirectionalLight("#ffffff", 1.7);
  private ground: Mesh<PlaneGeometry, ShadowMaterial>;
  private atlasCanvas = document.createElement("canvas");
  private atlasTexture = new CanvasTexture(this.atlasCanvas);
  private grain = grainTexture();
  private keyMaterial: MeshPhysicalMaterial;
  private caseMaterial = new MeshPhysicalMaterial();
  private plateMaterial = new MeshPhysicalMaterial({ color: "#1b1c1e", metalness: 0.3, roughness: 0.7 });
  private floorClip = new Plane(new Vector3(0, 1, 0), 0);
  private state: StageState | null = null;
  private baseKeys: PlacedKey[] = [];
  private keys: PlacedKey[] = [];
  private atlas: AtlasLayout | null = null;
  private size = { width: 0, depth: 0 };
  private frame = 0;
  private disposed = false;

  constructor(private host: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    r.toneMapping = NeutralToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    r.localClippingEnabled = true;
    r.setClearColor(0x000000, 0);
    r.domElement.style.display = "block";
    r.domElement.style.width = "100%";
    r.domElement.style.height = "100%";
    host.appendChild(r.domElement);

    this.scene.environment = studioEnvironment(r);
    this.scene.environmentIntensity = 0.75;

    this.atlasTexture.colorSpace = SRGBColorSpace;
    this.atlasTexture.anisotropy = Math.min(8, r.capabilities.getMaxAnisotropy());
    this.keyMaterial = new MeshPhysicalMaterial({
      map: this.atlasTexture,
      roughness: 0.38,
      roughnessMap: this.grain,
      metalness: 0,
      ior: 1.53,
      specularIntensity: 0.55,
      clearcoat: 0.04,
      clearcoatRoughness: 0.5,
    });
    this.caseMaterial.clippingPlanes = [this.floorClip];

    this.light.castShadow = true;
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.radius = 4;
    this.light.shadow.bias = -0.0003;
    this.light.shadow.normalBias = 0.6;
    Object.assign(this.light.shadow.camera, { left: -300, right: 300, top: 220, bottom: -220, near: 1, far: 1500 });
    this.scene.add(this.light, this.light.target);

    this.ground = new Mesh(new PlaneGeometry(3000, 3000), new ShadowMaterial({ opacity: 0.3 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.tilt.rotation.x = TYPING_ANGLE;
    this.tilt.add(this.board);
    this.scene.add(this.tilt);

    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enablePan = false;
    this.controls.enableZoom = false;
    this.controls.minPolarAngle = (12 * Math.PI) / 180;
    this.controls.maxPolarAngle = (72 * Math.PI) / 180;
    this.controls.minAzimuthAngle = (-40 * Math.PI) / 180;
    this.controls.maxAzimuthAngle = (40 * Math.PI) / 180;
    this.controls.addEventListener("change", () => this.requestRender());
    // Let a vertical swipe still scroll the page on a phone; only a sideways
    // drag turns the board.
    r.domElement.style.touchAction = "pan-y";
  }

  update(next: StageState) {
    const prev = this.state;
    this.state = next;
    const boardChanged =
      !prev || prev.layout !== next.layout || prev.profile !== next.profile || JSON.stringify(prev.options ?? {}) !== JSON.stringify(next.options ?? {});
    if (boardChanged) this.buildBoard(next);
    // Placement only recolours keys, so it repaints the atlas and never rebuilds geometry.
    if (boardChanged || JSON.stringify(prev!.colors) !== JSON.stringify(next.colors) || JSON.stringify(prev!.placement ?? {}) !== JSON.stringify(next.placement ?? {})) {
      this.keys = placeKeys(this.baseKeys, next.placement);
      this.paintKeys(next.colors);
    }
    if (boardChanged || prev!.caseHex !== next.caseHex || prev!.caseName !== next.caseName) this.paintCase(next.caseHex, next.caseName);
    if (boardChanged || prev!.view !== next.view) this.frameView(next.view);
    this.requestRender();
  }

  private clearBoard() {
    for (const child of [...this.board.children]) {
      this.board.remove(child);
      if (child instanceof Mesh) (child.geometry as BufferGeometry).dispose();
    }
  }

  private buildBoard(s: StageState) {
    this.clearBoard();
    const { keys, width, height } = layoutKeys(buildLayout(s.layout, s.options));
    this.baseKeys = keys;
    const W = width * PITCH;
    const D = height * PITCH;
    this.size = { width: W, depth: D };
    this.atlas = packAtlas(keys, s.profile);

    const arrays = keysetArrays(keys, this.atlas.cells, s.profile);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(arrays.positions, 3));
    geometry.setAttribute("uv", new Float32BufferAttribute(arrays.uvs, 2));
    geometry.setIndex(arrays.indices);
    geometry.computeVertexNormals();
    const caps = new Mesh(geometry, this.keyMaterial);
    caps.castShadow = true;
    caps.receiveShadow = true;
    // ~1 grain tile per 12 mm of keytop, whatever the atlas size.
    this.grain.repeat.set(this.atlas.width / PX_PER_MM / 12, this.atlas.height / PX_PER_MM / 12);

    // Case: one solid with an opening for the keys, run well below the floor
    // and clipped there, so the bottom is flat on the desk and the typing
    // angle is a wedge — as on a real case — rather than a tilted brick.
    const outer = new Shape();
    roundedRect(outer, -BEZEL, -BEZEL, W + 2 * BEZEL, D + 2 * BEZEL, 7);
    const hole = new Path();
    roundedRect(hole, -MARGIN, -MARGIN, W + 2 * MARGIN, D + 2 * MARGIN, 2.5);
    outer.holes.push(hole);
    const depth = 90;
    const shell = new ExtrudeGeometry(outer, { depth, bevelEnabled: true, bevelThickness: 1.4, bevelSize: 1.4, bevelSegments: 4, curveSegments: 8 });
    // Shape y → board z (toward the typist), extrusion → downward.
    shell.rotateX(Math.PI / 2);
    shell.translate(0, CASE_TOP, 0);
    const caseMesh = new Mesh(shell, this.caseMaterial);
    caseMesh.castShadow = true;
    caseMesh.receiveShadow = true;

    const plate = new Mesh(new PlaneGeometry(W + 2 * MARGIN, D + 2 * MARGIN), this.plateMaterial);
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(W / 2, PLATE_Y, D / 2);
    plate.receiveShadow = true;

    this.board.add(caps, caseMesh, plate);
    this.board.position.set(-W / 2, 0, -D / 2);

    // Floor: FRONT_HEIGHT below the case's front top edge once tilted.
    const frontZ = D / 2 + BEZEL;
    const frontTop = CASE_TOP * Math.cos(TYPING_ANGLE) - frontZ * Math.sin(TYPING_ANGLE);
    const floorY = frontTop - FRONT_HEIGHT;
    this.ground.position.y = floorY;
    // The clip plane is in world space: keep everything above the floor.
    this.floorClip.set(new Vector3(0, 1, 0), -floorY);
    // Key light high and behind-left, as in GMK's own renders: cap shadows
    // fall forward and to the right, and the front walls sit in shade.
    this.light.position.set(-W * 0.45, 460, -220);
    this.light.target.position.set(0, floorY, 0);
  }

  private paintKeys(colors: KeycapColors) {
    if (!this.atlas) return;
    drawAtlas(this.atlasCanvas, this.atlas, this.keys, colors);
    this.atlasTexture.dispose(); // canvas size may have changed; re-upload from scratch
    this.atlasTexture.needsUpdate = true;
  }

  private paintCase(hex: string, name: string) {
    const f = caseFinish(name);
    this.caseMaterial.color.set(hex);
    this.caseMaterial.metalness = f.metalness;
    this.caseMaterial.roughness = f.roughness;
    this.caseMaterial.clearcoat = f.clearcoat;
    this.caseMaterial.clearcoatRoughness = 0.3;
    this.caseMaterial.needsUpdate = true;
  }

  /** Put the camera on the view's angle at the distance that fits the whole case in frame. */
  private frameView(view: StageView) {
    const { width: W, depth: D } = this.size;
    const polar = view === "top" ? (1 * Math.PI) / 180 : (44 * Math.PI) / 180;
    const dir = new Vector3(0, Math.cos(polar), Math.sin(polar));
    const target = new Vector3(0, -6, view === "top" ? 0 : 4);
    const hw = W / 2 + BEZEL;
    const hd = D / 2 + BEZEL;
    const corners = [-1, 1].flatMap((sx) => [-1, 1].flatMap((sz) => [CASE_TOP + 10, -20].map((y) => new Vector3(sx * hw, y, sz * hd))));
    const fill = 0.9;
    let lo = 50;
    let hi = 6000;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      this.camera.position.copy(target).addScaledVector(dir, mid);
      this.camera.lookAt(target);
      this.camera.updateMatrixWorld();
      const fits = corners.every((c) => {
        const p = c.clone().project(this.camera);
        return Math.abs(p.x) <= fill && Math.abs(p.y) <= fill;
      });
      if (fits) hi = mid;
      else lo = mid;
    }
    this.camera.position.copy(target).addScaledVector(dir, hi);
    this.controls.target.copy(target);
    this.controls.enableRotate = view === "angle";
    this.controls.update();
  }

  resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.state) this.frameView(this.state.view);
    this.requestRender();
  }

  requestRender() {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.disposed) this.renderer.render(this.scene, this.camera);
    });
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.controls.dispose();
    this.clearBoard();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.keyMaterial.dispose();
    this.caseMaterial.dispose();
    this.plateMaterial.dispose();
    this.atlasTexture.dispose();
    this.grain.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    // Give the context back now rather than at GC: browsers cap live WebGL
    // contexts, and switching between Classic and 3D makes a new one each time.
    // (Keyboard3D removes its context-lost listener before calling this.)
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
