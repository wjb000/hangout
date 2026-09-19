import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createSession } from "./multiplayer.js";
import { WORLDS } from "./worlds.js";
import { CAST } from "./avatars.js";

const $ = (id) => document.getElementById(id);
const others = new Map();
const remoteActors = new Map();
const keys = Object.create(null);
let chatFocused = false;
let scene, camera, renderer, clock, loader;
let worldRoot = null;
let bounds = { minX: -30, maxX: 30, minZ: -30, maxZ: 30 };
let me = { x: 0, z: 4, y: 0, yaw: 0, moving: false, avatar: "aya", world: "sponza" };
let myActor = null;
let yaw = 0.35, pitch = 0.28, dist = 5.5;
let dragging = false;
let vrmPlugin = null;

function toast(t) {
  const el = $("toast"); if (!el) return;
  el.textContent = t; el.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), 2400);
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

function bones(vrm, name) {
  const h = vrm?.humanoid; if (!h) return [];
  return [h.getNormalizedBoneNode?.(name), h.getBoneNode?.(name)].filter(Boolean);
}
function pose(vrm, name, axis, v) {
  for (const b of bones(vrm, name)) b.rotation[axis] = v;
}
function walkPose(vrm, t, moving, run) {
  if (!vrm?.humanoid) return;
  const s = run ? 12 : 8;
  const a = moving ? (run ? 0.9 : 0.6) : 0.04;
  pose(vrm, "leftUpperLeg", "x", Math.sin(t * s) * a);
  pose(vrm, "rightUpperLeg", "x", Math.sin(t * s + Math.PI) * a);
  pose(vrm, "leftLowerLeg", "x", Math.max(0, -Math.sin(t * s) * a * 0.8));
  pose(vrm, "rightLowerLeg", "x", Math.max(0, -Math.sin(t * s + Math.PI) * a * 0.8));
  pose(vrm, "leftUpperArm", "z", 1.05 + Math.sin(t * s + Math.PI) * a * 0.45);
  pose(vrm, "rightUpperArm", "z", -1.05 + Math.sin(t * s) * a * 0.45);
}

function setup() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101018);
  scene.fog = new THREE.Fog(0x101018, 28, 70);
  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 160);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  $("viewport").appendChild(renderer.domElement);
  loader = new GLTFLoader();
  scene.add(new THREE.HemisphereLight(0xffe8d0, 0x101018, 1));
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.7);
  sun.position.set(8, 16, 6); scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
}

async function enableVrm() {
  if (vrmPlugin) return vrmPlugin;
  const mod = await import("@pixiv/three-vrm");
  loader.register((p) => new mod.VRMLoaderPlugin(p));
  vrmPlugin = mod;
  return mod;
}

async function loadWorld(id) {
  const spec = WORLDS.find((w) => w.id === id) || WORLDS[0];
  toast("loading " + spec.name + "…");
  if (worldRoot) scene.remove(worldRoot);
  const gltf = await loader.loadAsync(spec.url);
  worldRoot = gltf.scene;
  worldRoot.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
  const box = new THREE.Box3().setFromObject(worldRoot);
  const size = new THREE.Vector3(); box.getSize(size);
  const s = size.y > 0.01 ? (spec.height || 12) / size.y : 1;
  worldRoot.scale.setScalar(s);
  worldRoot.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(worldRoot);
  worldRoot.position.x -= (b.min.x + b.max.x) * 0.5;
  worldRoot.position.z -= (b.min.z + b.max.z) * 0.5;
  worldRoot.position.y -= b.min.y;
  worldRoot.updateMatrixWorld(true);
  const f = new THREE.Box3().setFromObject(worldRoot);
  bounds = { minX: f.min.x + 1, maxX: f.max.x - 1, minZ: f.min.z + 1, maxZ: f.max.z - 1 };
  scene.add(worldRoot);
  me.world = spec.id;
  me.x = spec.spawn?.x ?? 0;
  me.z = spec.spawn?.z ?? 4;
  me.y = 0;
  document.querySelectorAll("#worlds button").forEach((btn) => btn.classList.toggle("on", btn.dataset.id === spec.id));
  toast(spec.name);
}

async function loadCast(id) {
  const spec = CAST.find((c) => c.id === id) || CAST[0];
  toast("loading " + spec.name + "…");
  if (spec.vrm) await enableVrm();
  const gltf = await loader.loadAsync(spec.url);
  const vrm = gltf.userData?.vrm;
  if (vrm && vrmPlugin?.VRMUtils?.rotateVRM0) {
    try { vrmPlugin.VRMUtils.rotateVRM0(vrm); } catch {}
  }
  const root = vrm ? vrm.scene : gltf.scene;
  root.traverse((o) => { if (o.isMesh) { o.visible = true; o.frustumCulled = false; } });
  root.scale.setScalar(spec.scale || 1);
  return { root, clips: gltf.animations || [], vrm };
}

async function wear(id, target = "me") {
  const { root, clips, vrm } = await loadCast(id);
  const mixer = new THREE.AnimationMixer(root);
  const idle = clips.find((c) => /idle/i.test(c.name));
  const walk = clips.find((c) => /walk/i.test(c.name));
  const run = clips.find((c) => /run/i.test(c.name));
  const actor = {
    root, mixer, vrm,
    idle: idle ? mixer.clipAction(idle) : null,
    walk: walk ? mixer.clipAction(walk) : null,
    run: run ? mixer.clipAction(run) : null,
  };
  actor.idle?.play();
  if (target === "me") {
    if (myActor?.root) scene.remove(myActor.root);
    myActor = actor; scene.add(root); me.avatar = id;
    document.querySelectorAll("#picker button").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
    toast(specName(id));
  }
  return actor;
}
function specName(id) { return CAST.find((c) => c.id === id)?.name || id; }

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
    worlds = document.createElement("div"); worlds.id = "worlds";
    worlds.style.cssText = "position:fixed;top:52px;left:16px;z-index:6;display:flex;gap:6px";
    document.body.appendChild(worlds);
  }
  worlds.innerHTML = "";
  for (const w of WORLDS) {
    const b = document.createElement("button");
    b.dataset.id = w.id; b.textContent = w.name;
    b.style.cssText = "border:0;background:rgba(8,6,12,.55);color:#fff;padding:6px 10px;border-radius:999px;cursor:pointer";
    b.onclick = () => loadWorld(w.id).catch((e) => toast(String(e)));
    worlds.appendChild(b);
  }
}

function bind() {
  addEventListener("keydown", (e) => {
    if (e.code === "KeyT" && !chatFocused) { e.preventDefault(); $("chat-input").focus(); return; }
    keys[e.code] = true;
  });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  const el = renderer.domElement;
  el.style.touchAction = "none";
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointerup", () => { dragging = false; });
  el.addEventListener("pointermove", (e) => {
    if (!dragging || chatFocused) return;
    yaw -= e.movementX * 0.005;
    pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.003, 0.05, 1.2);
  });
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    dist = THREE.MathUtils.clamp(dist + e.deltaY * 0.01, 2, 14);
  }, { passive: false });
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

function loco(actor, moving, running) {
  if (!actor) return;
  const want = moving ? (running && actor.run ? actor.run : actor.walk || actor.idle) : actor.idle;
  for (const a of [actor.idle, actor.walk, actor.run]) {
    if (!a) continue;
    if (a === want && !a.isRunning()) a.reset().fadeIn(0.15).play();
    else if (a !== want && a.isRunning()) a.fadeOut(0.15);
  }
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
  const len = Math.hypot(fx, fz);
  if (len > 1) { fx /= len; fz /= len; }
  const running = !!(keys.ShiftLeft || keys.ShiftRight);
  const speed = running ? 7 : 3.6;
  // camera-forward on XZ
  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  me.x += (forwardX * fz + rightX * fx) * speed * dt;
  me.z += (forwardZ * fz + rightZ * fx) * speed * dt;
  me.x = THREE.MathUtils.clamp(me.x, bounds.minX, bounds.maxX);
  me.z = THREE.MathUtils.clamp(me.z, bounds.minZ, bounds.maxZ);
  me.moving = len > 0;
  if (me.moving) me.yaw = Math.atan2(forwardX * fz + rightX * fx, forwardZ * fz + rightZ * fx);

  if (myActor) {
    myActor.root.position.set(me.x, me.y, me.z);
    myActor.root.rotation.y = me.yaw;
    loco(myActor, me.moving, running);
    myActor.mixer.update(dt);
    if (myActor.vrm) {
      walkPose(myActor.vrm, clock.elapsedTime, me.moving, running);
      myActor.vrm.update(dt);
    }
  }

  const lookY = me.y + 1.35;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  camera.position.set(
    me.x + Math.sin(yaw) * cp * dist,
    lookY + sp * dist,
    me.z + Math.cos(yaw) * cp * dist
  );
  camera.lookAt(me.x, lookY, me.z);

  for (const [id, st] of others) {
    let actor = remoteActors.get(id);
    const want = st.avatar || "aya";
    if (!actor || actor.root.userData.avatar !== want) {
      if (actor?.root) scene.remove(actor.root);
      wear(want, "remote").then((a) => { a.root.userData.avatar = want; scene.add(a.root); remoteActors.set(id, a); });
      continue;
    }
    actor.root.position.x += ((st.x ?? 0) - actor.root.position.x) * Math.min(1, dt * 8);
    actor.root.position.z += ((st.y ?? 0) - actor.root.position.z) * Math.min(1, dt * 8);
    if (st.angle != null) actor.root.rotation.y = st.angle;
    loco(actor, !!st.moving, false);
    actor.mixer.update(dt);
    if (actor.vrm) { walkPose(actor.vrm, clock.elapsedTime, !!st.moving, false); actor.vrm.update(dt); }
  }

  session.sendState({ x: me.x, y: me.z, angle: me.yaw, moving: me.moving, avatar: me.avatar });
  renderer.render(scene, camera);
}

setup();
clock = new THREE.Clock();
bind();
drawPickers();
pills();
tick();
enableVrm()
  .then(() => wear("aya"))
  .catch(() => wear("robot"))
  .then(() => loadWorld("sponza"))
  .catch(() => loadWorld("house"));
session.autoEnter?.("LAN").then(() => setLink("in world", "ok")).catch(() => setLink("solo", "dim"));
