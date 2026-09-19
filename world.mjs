import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createSession } from "./multiplayer.js";
import { WORLDS } from "./worlds.js";
import { CAST } from "./avatars.js";

const $ = (id) => document.getElementById(id);
const others = new Map();
const remote = new Map();
const keys = Object.create(null);
let chatFocused = false;
let scene, camera, renderer, clock, loader;
let worldRoot = null;
let bounds = { minX: -16, maxX: 16, minZ: -16, maxZ: 16 };
let me = { x: 0, z: 3, y: 0, yaw: 0, moving: false, avatar: "robot", world: "house" };
let myActor = null;
let yaw = 0.5, pitch = 0.28, dist = 5;
let dragging = false;
let vrmMod = null;

function boot(msg) {
  const el = $("boot-msg"); if (el && msg) el.textContent = msg;
}
function bootOff() { $("boot")?.classList.add("off"); }
function toast(t) {
  const el = $("toast"); if (!el) return;
  el.textContent = t; el.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), 2000);
}
function log(t) {
  const box = $("chat-log"); if (!box) return;
  const p = document.createElement("div"); p.textContent = t; box.appendChild(p);
}
function pills() {
  const el = $("pills"); if (!el) return;
  el.innerHTML = "";
  const add = (n, c) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="dot" style="background:${c}"></span>${n}`;
    el.appendChild(li);
  };
  add(session.profile.name, session.profile.color);
  for (const p of others.values()) add(p.name || "Guest", p.color || "#fff");
}
function setLink(t, k) {
  const el = $("link"); if (!el) return;
  el.textContent = t; el.className = k || "dim";
}

const session = createSession({
  onStatus(msg, kind) {
    setLink(kind === "good" ? "in world" : String(msg || "solo").toLowerCase(), kind === "good" ? "ok" : kind === "bad" ? "bad" : "dim");
  },
  onState(id, st) {
    const first = !others.has(id);
    others.set(id, { ...(others.get(id) || {}), ...st });
    if (first && st.name) toast(st.name + " joined");
    pills();
  },
  onLeave(id) {
    const p = others.get(id); if (p?.name) toast(p.name + " left");
    others.delete(id);
    const a = remote.get(id); if (a?.root) scene.remove(a.root);
    remote.delete(id); pills();
  },
  onRoster: pills,
  onChat(_f, text, name) { log(`${name}: ${text}`); },
});

try {
  session.setProfile({ name: localStorage.getItem("hangout_name") || "you" });
  if ($("who")) {
    $("who").textContent = session.profile.name;
    $("who").onclick = () => {
      const n = prompt("Name", session.profile.name); if (!n) return;
      session.setProfile({ name: n }); $("who").textContent = n; pills();
    };
  }
  $("chat-form").onsubmit = (e) => {
    e.preventDefault();
    const inp = $("chat-input"); const t = inp.value.trim(); if (!t) return;
    log(`${session.profile.name}: ${t}`); session.sendChat?.(t); inp.value = ""; inp.blur();
  };
  $("chat-input").onfocus = () => { chatFocused = true; };
  $("chat-input").onblur = () => { chatFocused = false; };
} catch (e) { console.warn(e); }

function capsule() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x7ad0ff, roughness: 0.45 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.95, 4, 10), mat);
  body.position.y = 0.95;
  g.add(body);
  return g;
}

function makeActor(root, clips, vrm) {
  const mixer = new THREE.AnimationMixer(root);
  const find = (re) => (clips || []).find((c) => re.test(c.name));
  const idleC = find(/idle/i), walkC = find(/walk/i), runC = find(/run/i);
  const actor = {
    root, mixer, vrm,
    idle: idleC ? mixer.clipAction(idleC) : null,
    walk: walkC ? mixer.clipAction(walkC) : null,
    run: runC ? mixer.clipAction(runC) : null,
  };
  actor.idle?.play();
  return actor;
}

function loco(actor, moving, running) {
  if (!actor) return;
  const want = moving ? (running && actor.run ? actor.run : actor.walk || actor.idle) : actor.idle;
  for (const a of [actor.idle, actor.walk, actor.run]) {
    if (!a || a === want) continue;
    if (a.isRunning()) a.fadeOut(0.12);
  }
  if (want && !want.isRunning()) want.reset().fadeIn(0.12).play();
}

function pose(vrm, name, axis, v) {
  const h = vrm?.humanoid; if (!h) return;
  const n = h.getNormalizedBoneNode?.(name) || h.getBoneNode?.(name);
  if (n) n.rotation[axis] = v;
}
function walkPose(vrm, t, moving, run) {
  if (!vrm?.humanoid) return;
  const s = run ? 11 : 8;
  const a = moving ? (run ? 0.8 : 0.5) : 0.03;
  pose(vrm, "leftUpperLeg", "x", Math.sin(t * s) * a);
  pose(vrm, "rightUpperLeg", "x", Math.sin(t * s + Math.PI) * a);
  pose(vrm, "leftLowerLeg", "x", Math.max(0, -Math.sin(t * s) * a * 0.75));
  pose(vrm, "rightLowerLeg", "x", Math.max(0, -Math.sin(t * s + Math.PI) * a * 0.75));
  pose(vrm, "leftUpperArm", "z", 1.05 + Math.sin(t * s + Math.PI) * a * 0.35);
  pose(vrm, "rightUpperArm", "z", -1.05 + Math.sin(t * s) * a * 0.35);
}

function setup() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15121a);
  scene.fog = new THREE.Fog(0x15121a, 18, 48);
  camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 120);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  $("viewport").appendChild(renderer.domElement);
  loader = new GLTFLoader();
  scene.add(new THREE.HemisphereLight(0xffe8d4, 0x101018, 1));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
  sun.position.set(6, 14, 8); scene.add(sun);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(28, 40),
    new THREE.MeshStandardMaterial({ color: 0x1b1722, roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2; scene.add(ground);
}

async function enableVrm() {
  if (vrmMod) return vrmMod;
  vrmMod = await import("@pixiv/three-vrm");
  loader.register((p) => new vrmMod.VRMLoaderPlugin(p));
  return vrmMod;
}

async function loadWorld(id) {
  const spec = WORLDS.find((w) => w.id === id) || WORLDS[0];
  boot("loading " + spec.name);
  toast("loading " + spec.name);
  const gltf = await loader.loadAsync(spec.url);
  if (worldRoot) scene.remove(worldRoot);
  worldRoot = gltf.scene;
  worldRoot.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
  const box = new THREE.Box3().setFromObject(worldRoot);
  const size = new THREE.Vector3(); box.getSize(size);
  worldRoot.scale.setScalar(size.y > 0.01 ? (spec.height || 10) / size.y : 1);
  worldRoot.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(worldRoot);
  worldRoot.position.set(-(b.min.x + b.max.x) * 0.5, -b.min.y, -(b.min.z + b.max.z) * 0.5);
  worldRoot.updateMatrixWorld(true);
  const f = new THREE.Box3().setFromObject(worldRoot);
  bounds = { minX: f.min.x + 1.2, maxX: f.max.x - 1.2, minZ: f.min.z + 1.2, maxZ: f.max.z - 1.2 };
  scene.add(worldRoot);
  me.world = spec.id;
  me.x = spec.spawn?.x ?? 0;
  me.z = spec.spawn?.z ?? 3;
  document.querySelectorAll("#worlds button").forEach((btn) => btn.classList.toggle("on", btn.dataset.id === spec.id));
  toast(spec.name);
}

async function loadCast(id) {
  const spec = CAST.find((c) => c.id === id) || CAST.find((c) => c.id === "robot");
  if (spec.vrm) await enableVrm();
  const gltf = await loader.loadAsync(spec.url);
  const vrm = gltf.userData?.vrm;
  if (vrm && vrmMod?.VRMUtils?.rotateVRM0) {
    try { vrmMod.VRMUtils.rotateVRM0(vrm); } catch {}
  }
  const root = vrm ? vrm.scene : gltf.scene;
  root.traverse((o) => { if (o.isMesh) { o.visible = true; o.frustumCulled = false; } });
  root.scale.setScalar(spec.scale || 1);
  return { root, clips: gltf.animations || [], vrm };
}

async function wear(id, target = "me") {
  boot("loading " + id);
  const { root, clips, vrm } = await loadCast(id);
  const actor = makeActor(root, clips, vrm);
  if (target === "me") {
    if (myActor?.root) scene.remove(myActor.root);
    myActor = actor; scene.add(root); me.avatar = id;
    document.querySelectorAll("#picker button").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
  }
  return actor;
}

function drawUI() {
  const av = $("picker"); if (av) {
    av.innerHTML = "";
    for (const c of CAST) {
      const b = document.createElement("button");
      b.dataset.id = c.id; b.textContent = c.name;
      if (c.id === me.avatar) b.classList.add("on");
      b.onclick = () => wear(c.id).catch((e) => toast(String(e.message || e)));
      av.appendChild(b);
    }
  }
  const worlds = $("worlds"); if (worlds) {
    worlds.innerHTML = "";
    for (const w of WORLDS) {
      const b = document.createElement("button");
      b.dataset.id = w.id; b.textContent = w.name;
      if (w.id === me.world) b.classList.add("on");
      b.onclick = () => loadWorld(w.id).catch((e) => toast(String(e)));
      worlds.appendChild(b);
    }
  }
}

function bind() {
  addEventListener("keydown", (e) => {
    if (e.code === "KeyT" && !chatFocused) { e.preventDefault(); $("chat-input")?.focus(); return; }
    if (e.code === "Escape") $("chat-input")?.blur();
    keys[e.code] = true;
  });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  const el = renderer.domElement;
  el.style.touchAction = "none";
  el.addEventListener("pointerdown", (e) => {
    if (e.button === 0) { dragging = true; el.setPointerCapture(e.pointerId); }
  });
  el.addEventListener("pointerup", () => { dragging = false; });
  el.addEventListener("pointermove", (e) => {
    if (!dragging || chatFocused) return;
    yaw -= e.movementX * 0.005;
    pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.003, 0.05, 1.15);
  });
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    dist = THREE.MathUtils.clamp(dist + e.deltaY * 0.01, 2.2, 12);
  }, { passive: false });
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  let fx = 0, fz = 0;
  if (!chatFocused) {
    if (keys.KeyW || keys.ArrowUp) fz += 1;
    if (keys.KeyS || keys.ArrowDown) fz -= 1;
    if (keys.KeyA || keys.ArrowLeft) fx -= 1;
    if (keys.KeyD || keys.ArrowRight) fx += 1;
  }
  const moving = fx !== 0 || fz !== 0;
  if (moving) { const l = Math.hypot(fx, fz); fx /= l; fz /= l; }
  const running = !!(keys.ShiftLeft || keys.ShiftRight);
  const speed = running ? 7 : 3.6;
  const fX = -Math.sin(yaw), fZ = -Math.cos(yaw);
  const rX = Math.cos(yaw), rZ = -Math.sin(yaw);
  if (moving) {
    const vx = fX * fz + rX * fx;
    const vz = fZ * fz + rZ * fx;
    me.x = THREE.MathUtils.clamp(me.x + vx * speed * dt, bounds.minX, bounds.maxX);
    me.z = THREE.MathUtils.clamp(me.z + vz * speed * dt, bounds.minZ, bounds.maxZ);
    me.yaw = Math.atan2(vx, vz);
  }
  me.moving = moving;

  if (myActor) {
    myActor.root.position.set(me.x, me.y, me.z);
    myActor.root.rotation.y = me.yaw;
    loco(myActor, moving, running);
    myActor.mixer.update(dt);
    if (myActor.vrm) { walkPose(myActor.vrm, clock.elapsedTime, moving, running); myActor.vrm.update(dt); }
  }

  const lookY = me.y + 1.3;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  camera.position.set(
    me.x + Math.sin(yaw) * cp * dist,
    lookY + sp * dist,
    me.z + Math.cos(yaw) * cp * dist
  );
  camera.lookAt(me.x, lookY, me.z);

  for (const [id, st] of others) {
    let actor = remote.get(id);
    const want = st.avatar || "robot";
    if (!actor || actor.root.userData.avatar !== want) {
      if (actor?.root) scene.remove(actor.root);
      remote.delete(id);
      wear(want, "remote").then((a) => {
        a.root.userData.avatar = want; scene.add(a.root); remote.set(id, a);
      }).catch(() => {});
      continue;
    }
    actor.root.position.x += ((st.x ?? 0) - actor.root.position.x) * Math.min(1, dt * 8);
    actor.root.position.z += ((st.y ?? 0) - actor.root.position.z) * Math.min(1, dt * 8);
    if (st.angle != null) actor.root.rotation.y = st.angle;
    loco(actor, !!st.moving, false);
    actor.mixer.update(dt);
    if (actor.vrm) { walkPose(actor.vrm, clock.elapsedTime, !!st.moving, false); actor.vrm.update(dt); }
  }

  session.sendState({ x: me.x, y: me.z, angle: me.yaw, moving, avatar: me.avatar });
  renderer.render(scene, camera);
}

try {
  setup();
  clock = new THREE.Clock();
  bind();
  drawUI();
  pills();
  myActor = makeActor(capsule(), []);
  scene.add(myActor.root);
  tick();
  bootOff();
} catch (e) {
  boot(String(e.message || e));
  console.error(e);
}

wear("robot")
  .then(() => { boot("loading house"); return loadWorld("house"); })
  .then(() => bootOff())
  .catch((e) => { console.warn(e); bootOff(); toast("world later — you can still walk"); });

session.autoEnter?.("LAN").then(() => setLink("in world", "ok")).catch(() => setLink("solo", "dim"));
