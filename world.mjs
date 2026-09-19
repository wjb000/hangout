import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createSession } from "./multiplayer.js";
import { WORLDS } from "./worlds.js";

const BASE = "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/models/gltf/";
const CAST = [
  { id: "xbot", name: "Xbot", url: BASE + "Xbot.glb", scale: 1 },
  { id: "soldier", name: "Soldier", url: BASE + "Soldier.glb", scale: 1 },
  { id: "robot", name: "Robot", url: BASE + "RobotExpressive/RobotExpressive.glb", scale: 1 },
  {
    id: "vrm",
    name: "VRM",
    url: "https://cdn.jsdelivr.net/gh/pixiv/three-vrm@release/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm",
    scale: 1,
    vrm: true,
  },
];

const $ = (id) => document.getElementById(id);
const others = new Map();
const remoteActors = new Map();
const keys = {};
let chatFocused = false;
let scene, camera, renderer, clock, loader;
let worldRoot = null;
let bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
let me = { x: 0, z: 2, y: 0, yaw: 0, moving: false, avatar: "robot", world: "sponza" };
let myActor = null;
let camYaw = 0, camPitch = 0.22;
let vrmPlugin = null;

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
    const a = remoteActors.get(id); if (a?.root) scene.remove(a.root);
    remoteActors.delete(id); pills();
  },
  onRoster: pills,
  onChat(_f, text, name) {
    log(`${name}: ${text}`);
    for (const a of remoteActors.values()) playOnce(a, "wave");
  },
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
  log(`${session.profile.name}: ${t}`); session.sendChat?.(t); playOnce(myActor, "wave"); inp.value = ""; inp.blur();
};
$("chat-input").onfocus = () => { chatFocused = true; };
$("chat-input").onblur = () => { chatFocused = false; };

function clipOf(clips, names) {
  const lower = clips.map((c) => [c, c.name.toLowerCase()]);
  for (const n of names) {
    const hit = lower.find(([, nm]) => nm === n || nm.includes(n));
    if (hit) return hit[0];
  }
  return clips[0] || null;
}

function makeActor(root, clips) {
  const mixer = new THREE.AnimationMixer(root);
  const mk = (names) => {
    const c = clipOf(clips, names);
    if (!c) return null;
    const a = mixer.clipAction(c); a.enabled = true; return a;
  };
  const actor = {
    root,
    mixer,
    idle: mk(["idle", "idle_standing", "wait"]),
    walk: mk(["walk", "walking", "walk_forward"]),
    run: mk(["run", "running", "sprint"]),
    wave: mk(["wave", "thumbsup", "yes", "dance"]),
    current: null,
  };
  if (actor.idle) { actor.idle.play(); actor.current = "idle"; }
  return actor;
}

function setLocomotion(actor, moving, running) {
  if (!actor) return;
  const next = moving ? (running && actor.run ? "run" : actor.walk ? "walk" : "idle") : "idle";
  if (actor.current === next || actor.current === "wave") return;
  const from = actor[actor.current];
  const to = actor[next];
  if (to) { to.reset().fadeIn(0.15).play(); if (from && from !== to) from.fadeOut(0.15); actor.current = next; }
}

function playOnce(actor, name) {
  if (!actor?.[name]) return;
  const act = actor[name];
  act.reset().setLoop(THREE.LoopOnce, 1).clampWhenFinished = true;
  act.fadeIn(0.1).play();
  actor.current = name;
  const done = () => { actor.mixer.removeEventListener("finished", done); actor.current = "idle"; actor.idle?.reset().fadeIn(0.2).play(); };
  actor.mixer.addEventListener("finished", done);
}

function setupRenderer() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101018);
  scene.fog = new THREE.Fog(0x101018, 24, 64);
  camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.08, 140);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  $("viewport").appendChild(renderer.domElement);
  loader = new GLTFLoader();
  scene.add(new THREE.HemisphereLight(0xffe8d0, 0x121018, 0.85));
  const sun = new THREE.DirectionalLight(0xfff3dd, 1.6);
  sun.position.set(10, 22, 8); sun.castShadow = true; scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 0.28));
}

async function enableVrm() {
  if (vrmPlugin) return;
  try {
    const mod = await import("@pixiv/three-vrm");
    loader.register((p) => new mod.VRMLoaderPlugin(p));
    vrmPlugin = mod;
  } catch (e) { console.warn("vrm plugin", e); }
}

async function loadWorld(id) {
  const spec = WORLDS.find((w) => w.id === id) || WORLDS[0];
  toast("loading " + spec.name + "…");
  if (worldRoot) scene.remove(worldRoot);
  const gltf = await loader.loadAsync(spec.url);
  worldRoot = gltf.scene;
  worldRoot.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
  const box = new THREE.Box3().setFromObject(worldRoot);
  const size = new THREE.Vector3(); box.getSize(size);
  const s = size.y > 0.01 ? (spec.height || 12) / size.y : 1;
  worldRoot.scale.setScalar(s);
  worldRoot.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(worldRoot);
  worldRoot.position.x -= (box2.min.x + box2.max.x) * 0.5;
  worldRoot.position.z -= (box2.min.z + box2.max.z) * 0.5;
  worldRoot.position.y -= box2.min.y;
  worldRoot.updateMatrixWorld(true);
  const final = new THREE.Box3().setFromObject(worldRoot);
  bounds = { minX: final.min.x + 0.6, maxX: final.max.x - 0.6, minZ: final.min.z + 0.6, maxZ: final.max.z - 0.6 };
  scene.add(worldRoot);
  me.world = spec.id;
  me.x = THREE.MathUtils.clamp(spec.spawn.x, bounds.minX, bounds.maxX);
  me.z = THREE.MathUtils.clamp(spec.spawn.z, bounds.minZ, bounds.maxZ);
  document.querySelectorAll("#worlds button").forEach((b) => b.classList.toggle("on", b.dataset.id === spec.id));
  toast(spec.name + " · " + spec.engine);
}

const cache = new Map();
async function loadCast(id) {
  if (cache.has(id)) {
    const hit = cache.get(id);
    return { root: hit.root.clone(), clips: hit.clips };
  }
  const spec = CAST.find((c) => c.id === id) || CAST[0];
  if (spec.vrm) await enableVrm();
  const gltf = await loader.loadAsync(spec.url);
  const root = gltf.scene;
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  root.scale.setScalar(spec.scale);
  const clips = gltf.animations || [];
  cache.set(id, { root, clips });
  return { root: root.clone(), clips };
}

async function wear(id, target = "me") {
  const { root, clips } = await loadCast(id);
  const actor = makeActor(root, clips);
  if (target === "me") {
    if (myActor?.root) scene.remove(myActor.root);
    myActor = actor; scene.add(root); me.avatar = id;
    document.querySelectorAll("#picker button").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
  }
  return actor;
}

function drawPickers() {
  const av = $("picker"); av.innerHTML = "";
  for (const c of CAST) {
    const b = document.createElement("button");
    b.dataset.id = c.id; b.textContent = c.name;
    if (c.id === me.avatar) b.classList.add("on");
    b.onclick = () => wear(c.id).catch((e) => toast(String(e.message || e)));
    av.appendChild(b);
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
    b.style.cssText = "border:0;background:rgba(8,6,12,.55);color:#fff;padding:6px 10px;border-radius:999px;cursor:pointer";
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
  const running = !!(keys.ShiftLeft || keys.ShiftRight);
  const speed = running ? 6.4 : 3.3;
  const cs = Math.cos(camYaw), sn = Math.sin(camYaw);
  const mx = (ix * cs + iz * sn) * speed;
  const mz = (iz * cs - ix * sn) * speed;
  me.x = THREE.MathUtils.clamp(me.x + mx * dt, bounds.minX, bounds.maxX);
  me.z = THREE.MathUtils.clamp(me.z + mz * dt, bounds.minZ, bounds.maxZ);
  me.moving = Math.abs(mx) + Math.abs(mz) > 0.1;
  if (me.moving) me.yaw = Math.atan2(mx, mz);
  if (myActor) {
    myActor.root.position.set(me.x, 0, me.z);
    myActor.root.rotation.y = me.yaw;
    setLocomotion(myActor, me.moving, running);
    myActor.mixer.update(dt);
  }
  const back = 4.4;
  camera.position.set(
    me.x + Math.sin(camYaw) * Math.cos(camPitch) * back,
    1.7 + Math.sin(camPitch) * 2.2,
    me.z + Math.cos(camYaw) * Math.cos(camPitch) * back
  );
  camera.lookAt(me.x, 1.25, me.z);
  for (const [id, st] of others) {
    let actor = remoteActors.get(id);
    if (!actor || actor.root.userData.avatar !== (st.avatar || "robot")) {
      if (actor?.root) scene.remove(actor.root);
      wear(st.avatar || "robot", "remote").then((a) => {
        a.root.userData.avatar = st.avatar || "robot";
        scene.add(a.root); remoteActors.set(id, a);
      });
      continue;
    }
    actor.root.position.x += ((st.x ?? 0) - actor.root.position.x) * Math.min(1, dt * 8);
    actor.root.position.z += ((st.y ?? 0) - actor.root.position.z) * Math.min(1, dt * 8);
    if (st.angle != null) actor.root.rotation.y += (st.angle - actor.root.rotation.y) * Math.min(1, dt * 8);
    setLocomotion(actor, !!st.moving, false);
    actor.mixer.update(dt);
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
  .catch((e) => { console.warn(e); loadWorld("house").then(() => tick()); });
session.autoEnter?.("LAN").then(() => setLink("in world", "ok")).catch(() => setLink("solo", "dim"));
