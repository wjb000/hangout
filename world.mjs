import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createSession } from "./multiplayer.js";
import { WORLDS } from "./worlds.js";

const BASE = "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/models/gltf/";
const CAST = [
  { id: "xbot", name: "Xbot", url: BASE + "Xbot.glb", scale: 1 },
  { id: "soldier", name: "Soldier", url: BASE + "Soldier.glb", scale: 1 },
  { id: "robot", name: "Robot", url: BASE + "RobotExpressive/RobotExpressive.glb", scale: 1 },
];

const $ = (id) => document.getElementById(id);
const others = new Map();
const remoteMesh = new Map();
const keys = {};
let chatFocused = false;
let scene, camera, renderer, clock, loader;
let worldRoot = null;
let bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
let me = { x: 0, z: 2, y: 0, yaw: 0, moving: false, avatar: CAST[0].id, world: "sponza" };
let myRig = null;
let camYaw = 0, camPitch = 0.22;

function toast(t) {
  const el = $("toast"); if (!el) return;
  el.textContent = t; el.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}
function log(t) {
  const box = $("chat-log"); if (!box) return;
  const p = document.createElement("div"); p.textContent = t; box.appendChild(p);
}
function pills() {
  const el = $("pills"); if (!el) return;
  el.innerHTML = "";
  const add = (n, c) => { const li = document.createElement("li"); li.innerHTML = `<span class="dot" style="background:${c}"></span>${n}`; el.appendChild(li); };
  add(session.profile.name, session.profile.color);
  for (const p of others.values()) add(p.name || "Guest", p.color || "#fff");
}
function setLink(t, k) { const el = $("link"); if (!el) return; el.textContent = t; el.className = k || "dim"; }

const session = createSession({
  onStatus(msg, kind) { if (kind === "good") setLink("in world", "ok"); else setLink(String(msg || "").toLowerCase(), kind === "bad" ? "bad" : "dim"); },
  onState(id, st) {
    const first = !others.has(id);
    others.set(id, { ...(others.get(id) || {}), ...st });
    if (first && st.name) toast(st.name + " joined");
    pills();
  },
  onLeave(id) {
    const p = others.get(id); if (p?.name) toast(p.name + " left");
    others.delete(id);
    const m = remoteMesh.get(id); if (m) scene.remove(m);
    remoteMesh.delete(id); pills();
  },
  onRoster: pills,
  onChat(_f, text, name) { log(`${name}: ${text}`); },
});

session.setProfile({ name: localStorage.getItem("hangout_name") || "you" });
$("who").textContent = session.profile.name;
$("who").onclick = () => {
  const n = prompt("Name", session.profile.name); if (!n) return;
  session.setProfile({ name: n }); $("who").textContent = n; pills();
};
$("chat-form").onsubmit = (e) => {
  e.preventDefault();
  const inp = $("chat-input"); const t = inp.value.trim(); if (!t) return;
  log(`${session.profile.name}: ${t}`); session.sendChat?.(t); inp.value = ""; inp.blur();
};
$("chat-input").onfocus = () => { chatFocused = true; };
$("chat-input").onblur = () => { chatFocused = false; };

function setupRenderer() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0c10);
  scene.fog = new THREE.Fog(0x0d0c10, 28, 70);
  camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.08, 120);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  $("viewport").appendChild(renderer.domElement);
  loader = new GLTFLoader();
  scene.add(new THREE.HemisphereLight(0xffe8d0, 0x101018, 0.7));
  const sun = new THREE.DirectionalLight(0xfff1dd, 1.35);
  sun.position.set(8, 18, 6); sun.castShadow = true; scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
}

async function loadWorld(id) {
  const spec = WORLDS.find((w) => w.id === id) || WORLDS[0];
  toast("loading " + spec.name + " (" + (spec.engine || "glTF") + ")…");
  if (worldRoot) scene.remove(worldRoot);
  const gltf = await loader.loadAsync(spec.url);
  worldRoot = gltf.scene;
  worldRoot.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
  });
  const box = new THREE.Box3().setFromObject(worldRoot);
  const size = new THREE.Vector3(); box.getSize(size);
  const targetH = spec.height || 12;
  const s = size.y > 0.01 ? targetH / size.y : 1;
  worldRoot.scale.setScalar(s);
  worldRoot.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(worldRoot);
  worldRoot.position.x -= (box2.min.x + box2.max.x) * 0.5;
  worldRoot.position.z -= (box2.min.z + box2.max.z) * 0.5;
  worldRoot.position.y -= box2.min.y;
  worldRoot.updateMatrixWorld(true);
  const final = new THREE.Box3().setFromObject(worldRoot);
  bounds = {
    minX: final.min.x + 0.6,
    maxX: final.max.x - 0.6,
    minZ: final.min.z + 0.6,
    maxZ: final.max.z - 0.6,
  };
  scene.add(worldRoot);
  me.world = spec.id;
  me.x = THREE.MathUtils.clamp(spec.spawn.x, bounds.minX, bounds.maxX);
  me.z = THREE.MathUtils.clamp(spec.spawn.z, bounds.minZ, bounds.maxZ);
  document.querySelectorAll("#worlds button").forEach((b) => b.classList.toggle("on", b.dataset.id === spec.id));
  toast(spec.name);
}

const cache = new Map();
async function loadCast(id) {
  if (cache.has(id)) return cache.get(id).clone();
  const spec = CAST.find((c) => c.id === id) || CAST[0];
  const gltf = await loader.loadAsync(spec.url);
  cache.set(id, gltf.scene);
  const root = gltf.scene.clone();
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  root.scale.setScalar(spec.scale);
  return root;
}
async function wear(id, target = "me") {
  const model = await loadCast(id);
  if (target === "me") {
    if (myRig) scene.remove(myRig);
    myRig = model; scene.add(myRig); me.avatar = id;
    document.querySelectorAll("#picker button").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
  }
  return model;
}
function drawPickers() {
  const av = $("picker"); av.innerHTML = "";
  for (const c of CAST) {
    const b = document.createElement("button");
    b.dataset.id = c.id; b.textContent = c.name;
    if (c.id === me.avatar) b.classList.add("on");
    b.onclick = () => wear(c.id); av.appendChild(b);
  }
  let worlds = $("worlds");
  if (!worlds) {
    worlds = document.createElement("div");
    worlds.id = "worlds";
    worlds.style.cssText = "position:fixed;top:52px;left:16px;z-index:6;display:flex;gap:6px";
    document.body.appendChild(worlds);
  }
  worlds.innerHTML = "";
  for (const w of WORLDS) {
    const b = document.createElement("button");
    b.dataset.id = w.id; b.textContent = w.name;
    b.style.cssText = "border:0;background:rgba(8,6,12,.55);color:#fff;padding:6px 10px;border-radius:999px;cursor:pointer;backdrop-filter:blur(10px)";
    if (w.id === me.world) b.classList.add("on");
    b.onclick = () => loadWorld(w.id).catch((e) => toast(String(e)));
    worlds.appendChild(b);
  }
}
function bind() {
  addEventListener("keydown", (e) => {
    if (e.code === "KeyT" && !chatFocused) { e.preventDefault(); $("chat-input").focus(); return; }
    if (!chatFocused) keys[e.code] = true;
  });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  renderer.domElement.addEventListener("click", () => renderer.domElement.requestPointerLock());
  addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== renderer.domElement || chatFocused) return;
    camYaw -= e.movementX * 0.003;
    camPitch = Math.max(0.05, Math.min(1.1, camPitch - e.movementY * 0.002));
  });
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
  });
}
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  let ix = 0, iz = 0;
  if (!chatFocused) {
    if (keys.KeyW || keys.ArrowUp) iz -= 1;
    if (keys.KeyS || keys.ArrowDown) iz += 1;
    if (keys.KeyA || keys.ArrowLeft) ix -= 1;
    if (keys.KeyD || keys.ArrowRight) ix += 1;
  }
  const speed = keys.ShiftLeft ? 6.2 : 3.4;
  const cs = Math.cos(camYaw), sn = Math.sin(camYaw);
  const mx = (ix * cs + iz * sn) * speed;
  const mz = (iz * cs - ix * sn) * speed;
  me.x = THREE.MathUtils.clamp(me.x + mx * dt, bounds.minX, bounds.maxX);
  me.z = THREE.MathUtils.clamp(me.z + mz * dt, bounds.minZ, bounds.maxZ);
  me.moving = Math.abs(mx) + Math.abs(mz) > 0.1;
  if (me.moving) me.yaw = Math.atan2(mx, mz);
  if (myRig) {
    myRig.position.set(me.x, 0, me.z);
    myRig.rotation.y = me.yaw;
    if (me.moving) myRig.position.y = Math.abs(Math.sin(clock.elapsedTime * 10)) * 0.05;
  }
  const back = 4.2;
  camera.position.set(
    me.x + Math.sin(camYaw) * Math.cos(camPitch) * back,
    1.7 + Math.sin(camPitch) * 2.2,
    me.z + Math.cos(camYaw) * Math.cos(camPitch) * back
  );
  camera.lookAt(me.x, 1.25, me.z);
  for (const [id, st] of others) {
    let rig = remoteMesh.get(id);
    if (!rig || rig.userData.avatar !== (st.avatar || "xbot")) {
      if (rig) scene.remove(rig);
      wear(st.avatar || "xbot", "remote").then((m) => { m.userData.avatar = st.avatar || "xbot"; scene.add(m); remoteMesh.set(id, m); });
      continue;
    }
    rig.position.x += ((st.x ?? 0) - rig.position.x) * Math.min(1, dt * 8);
    rig.position.z += ((st.y ?? 0) - rig.position.z) * Math.min(1, dt * 8);
    if (st.angle != null) rig.rotation.y += (st.angle - rig.rotation.y) * Math.min(1, dt * 8);
  }
  session.sendState({ x: me.x, y: me.z, angle: me.yaw, moving: me.moving, avatar: me.avatar });
  renderer.render(scene, camera);
}

setupRenderer();
clock = new THREE.Clock();
bind();
drawPickers();
pills();
Promise.all([loadWorld("sponza"), wear(me.avatar)])
  .then(() => tick())
  .catch((e) => { toast("sponza failed, trying house"); loadWorld("house").then(() => tick()); console.warn(e); });
session.autoEnter?.("LAN").then(() => setLink("in world", "ok")).catch(() => setLink("solo", "dim"));
