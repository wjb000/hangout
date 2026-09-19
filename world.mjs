import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createSession } from "./multiplayer.js";
import { WORLDS } from "./worlds.js";
import { CAST } from "./avatars.js";

const IDLE_VRMA = "https://cdn.jsdelivr.net/gh/aikeyaorg/aikeya@main/static/animations/idle.vrma";
function dressLayers(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const n = String(o.name || "").toLowerCase();
    if (/hair|kami|bang/.test(n)) o.renderOrder = 5;
    else if (/cloth|wear|shirt|skirt|dress|jacket|pants|onepiece|uniform|coat/.test(n)) o.renderOrder = 4;
    else if (/face|head|eye|brow|mouth|tooth/.test(n)) o.renderOrder = 3;
    else if (/body|skin/.test(n)) o.renderOrder = 1;
    else o.renderOrder = 2;
    for (const m of [].concat(o.material || [])) {
      if (!m) continue;
      if (m.transparent) o.renderOrder += 1;
      m.depthWrite = !m.transparent;
    }
  });
}
function vrmBones(vrm, name) {
  const h = vrm?.humanoid; if (!h) return [];
  const a = h.getNormalizedBoneNode?.(name);
  const b = h.getBoneNode?.(name);
  return [a, b].filter((n, i, arr) => n && arr.indexOf(n) === i);
}
function setBone(vrm, name, axis, value) {
  for (const n of vrmBones(vrm, name)) n.rotation[axis] = value;
}
function swingWalk(vrm, t, moving, run) {
  if (!vrm?.humanoid) return;
  const spd = run ? 13 : 8.5;
  const amp = moving ? (run ? 1.05 : 0.72) : 0.05;
  setBone(vrm, "leftUpperLeg", "x", Math.sin(t * spd) * amp);
  setBone(vrm, "rightUpperLeg", "x", Math.sin(t * spd + Math.PI) * amp);
  setBone(vrm, "leftLowerLeg", "x", Math.max(0, -Math.sin(t * spd) * amp * 0.9));
  setBone(vrm, "rightLowerLeg", "x", Math.max(0, -Math.sin(t * spd + Math.PI) * amp * 0.9));
  setBone(vrm, "leftFoot", "x", Math.sin(t * spd) * amp * 0.25);
  setBone(vrm, "rightFoot", "x", Math.sin(t * spd + Math.PI) * amp * 0.25);
  setBone(vrm, "leftUpperArm", "z", 1.1 + Math.sin(t * spd + Math.PI) * amp * 0.55);
  setBone(vrm, "rightUpperArm", "z", -1.1 + Math.sin(t * spd) * amp * 0.55);
  setBone(vrm, "hips", "y", moving ? Math.sin(t * spd) * 0.08 : 0);
  setBone(vrm, "spine", "x", moving ? Math.sin(t * spd * 2) * 0.04 : 0);
}
async function bindIdle(loader, vrm) {
  if (!vrm) return null;
  try {
    const mod = await import("@pixiv/three-vrm-animation");
    loader.register((p) => new mod.VRMAnimationLoaderPlugin(p));
    const gltf = await loader.loadAsync(IDLE_VRMA);
    const anim = gltf.userData.vrmAnimation || gltf.userData.vrmAnimations?.[0];
    if (!anim || !mod.createVRMAnimationClip) return null;
    return mod.createVRMAnimationClip(anim, vrm);
  } catch (e) {
    console.warn("idle vrma", e);
    return null;
  }
}

const BODY_R = 0.48;
const PEER_R = 0.85;
const $ = (id) => document.getElementById(id);
const others = new Map();
const remoteActors = new Map();
const keys = {};
const ray = new THREE.Raycaster();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
let chatFocused = false;
let scene, camera, renderer, clock, loader;
let worldRoot = null;
let colliders = [];
let bounds = { minX: -12, maxX: 12, minZ: -12, maxZ: 12 };
let me = { x: 0, z: 3, y: 0, yaw: 0, moving: false, avatar: "aya", world: "sponza" };
let myActor = null;
let camYaw = 0.4, camPitch = 0.28, camDist = 5.2, lookH = 1.35, panX = 0, panZ = 0, dragBtn = 0;
let vrmPlugin = null;

function toast(t) {
  const el = $("toast"); if (!el) return;
  el.textContent = t; el.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), 2800);
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
    if (first && st.name) toast(st.name + " joined"); pills();
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

function clipOf(clips, names) {
  const lower = (clips || []).map((c) => [c, c.name.toLowerCase()]);
  for (const n of names) {
    const hit = lower.find(([, nm]) => nm === n || nm.includes(n));
    if (hit) return hit[0];
  }
  return null;
}
function makeActor(root, clips, vrm) {
  const mixer = new THREE.AnimationMixer(root);
  const mk = (names) => {
    const c = clipOf(clips, names);
    return c ? mixer.clipAction(c) : null;
  };
  const actor = { root, mixer, vrm, idle: mk(["idle", "wait"]), walk: mk(["walk", "walking"]), run: mk(["run", "running"]), wave: mk(["wave", "dance"]), current: null };
  actor.idle?.reset().play();
  actor.current = actor.idle ? "idle" : null;
  return actor;
}
function setLocomotion(actor, moving, running) {
  if (!actor) return;
  if (actor.idle) actor.idle.paused = !!(moving && !actor.walk);
  const next = moving ? (running && actor.run ? "run" : actor.walk ? "walk" : "idle") : "idle";
  if (!actor[next] || actor.current === next) return;
  const from = actor[actor.current];
  const to = actor[next];
  to.reset().fadeIn(0.18).play();
  if (from && from !== to) from.fadeOut(0.18);
  actor.current = next;
}

function firstHit(ox, oy, oz, dx, dy, dz, far) {
  if (!colliders.length) return null;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-8) return null;
  _o.set(ox, oy, oz); _d.set(dx / len, dy / len, dz / len);
  ray.set(_o, _d); ray.far = far;
  return ray.intersectObjects(colliders, false)[0] || null;
}
function blocked(x, z, mx, mz) {
  const dist = Math.hypot(mx, mz);
  if (dist < 1e-6) return false;
  const reach = dist + BODY_R;
  const a = firstHit(x, me.y + 0.45, z, mx, 0, mz, reach);
  const b = firstHit(x, me.y + 1.15, z, mx, 0, mz, reach);
  const h = [a, b].filter(Boolean).sort((p, q) => p.distance - q.distance)[0];
  return !!(h && h.distance < reach);
}
function slide(x, z, mx, mz) {
  let nx = x, nz = z;
  if (!blocked(x, z, mx, 0)) nx = x + mx;
  if (!blocked(nx, z, 0, mz)) nz = z + mz;
  return { x: nx, z: nz };
}
function groundY(x, z) {
  const h = firstHit(x, 4, z, 0, -1, 0, 10);
  if (!h || !Number.isFinite(h.point.y)) return 0;
  return THREE.MathUtils.clamp(h.point.y, -0.2, 2.8);
}
function separatePeers(x, z) {
  let px = x, pz = z;
  for (const st of others.values()) {
    const dx = px - (st.x ?? 0), dz = pz - (st.y ?? 0);
    const d = Math.hypot(dx, dz);
    if (d < PEER_R && d > 1e-4) { const k = (PEER_R - d) / d; px += dx * k; pz += dz * k; }
  }
  return { x: px, z: pz };
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
  renderer.toneMappingExposure = 1.25;
  $("viewport").appendChild(renderer.domElement);
  loader = new GLTFLoader();
  scene.add(new THREE.HemisphereLight(0xffe8d0, 0x121018, 1.0));
  const sun = new THREE.DirectionalLight(0xfff3dd, 1.8);
  sun.position.set(6, 14, 8); sun.castShadow = true; scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
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
  colliders = [];
  worldRoot.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; colliders.push(o); }
  });
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
  bounds = { minX: final.min.x + 0.4, maxX: final.max.x - 0.4, minZ: final.min.z + 0.4, maxZ: final.max.z - 0.4 };
  scene.add(worldRoot);
  me.world = spec.id;
  me.x = THREE.MathUtils.clamp(spec.spawn.x, bounds.minX, bounds.maxX);
  me.z = THREE.MathUtils.clamp(spec.spawn.z, bounds.minZ, bounds.maxZ);
  me.y = groundY(me.x, me.z);
  document.querySelectorAll("#worlds button").forEach((b) => b.classList.toggle("on", b.dataset.id === spec.id));
  toast(spec.name);
}

async function loadCast(id) {
  const spec = CAST.find((c) => c.id === id) || CAST[0];
  toast("loading " + spec.name + "…");
  if (spec.vrm) await enableVrm();
  const gltf = await loader.loadAsync(spec.url);
  const vrm = gltf.userData && gltf.userData.vrm;
  if (vrm && vrmPlugin?.VRMUtils?.rotateVRM0) {
    try { vrmPlugin.VRMUtils.rotateVRM0(vrm); } catch {}
  }
  const root = vrm ? vrm.scene : gltf.scene;
  root.visible = true;
  root.traverse((o) => { if (o.isMesh) { o.visible = true; o.castShadow = true; o.frustumCulled = false; } });
  dressLayers(root);
  root.scale.setScalar(spec.scale || 1);
  let clips = gltf.animations || [];
  if (vrm) {
    const idle = await bindIdle(loader, vrm);
    if (idle) clips = [idle, ...clips];
  }
  return { root, clips, vrm };
}
async function wear(id, target = "me") {
  const { root, clips, vrm } = await loadCast(id);
  const actor = makeActor(root, clips, vrm);
  if (target === "me") {
    if (myActor?.root) scene.remove(myActor.root);
    myActor = actor; scene.add(root); root.position.set(me.x, me.y, me.z); me.avatar = id;
    document.querySelectorAll("#picker button").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
    toast(CAST.find((c) => c.id === id)?.name || id);
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
    worlds = document.createElement("div"); worlds.id = "worlds";
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
function look(dx, dy) {
  camYaw -= dx * 0.005;
  camPitch = Math.max(-0.1, Math.min(1.25, camPitch - dy * 0.0035));
}
function pan(dx, dy) {
  const rightX = Math.cos(camYaw), rightZ = -Math.sin(camYaw);
  panX += rightX * dx * 0.01 + Math.sin(camYaw) * dy * 0.01;
  panZ += rightZ * dx * 0.01 + Math.cos(camYaw) * dy * 0.01;
  lookH = THREE.MathUtils.clamp(lookH + dy * 0.006, 0.4, 3.2);
}
function bind() {
  addEventListener("keydown", (e) => {
    if (e.code === "KeyT" && !chatFocused) { e.preventDefault(); $("chat-input").focus(); return; }
    if (!chatFocused) keys[e.code] = true;
  });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  const el = renderer.domElement;
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("pointerdown", (e) => {
    dragBtn = e.button;
    el.setPointerCapture(e.pointerId);
    if (e.button === 0 && e.detail === 2) el.requestPointerLock();
  });
  el.addEventListener("pointerup", (e) => { dragBtn = -1; try { el.releasePointerCapture(e.pointerId); } catch {} });
  el.addEventListener("pointermove", (e) => {
    if (chatFocused) return;
    if (document.pointerLockElement === el) { look(e.movementX, e.movementY); return; }
    if (dragBtn === 0) look(e.movementX, e.movementY);
    else if (dragBtn === 1 || dragBtn === 2) pan(e.movementX, e.movementY);
  });
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    camDist = THREE.MathUtils.clamp(camDist * (e.deltaY > 0 ? 1.08 : 0.92), 1.6, 16);
  }, { passive: false });
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
  });
}

function placeCam() {
  const tx = me.x + panX;
  const ty = me.y + lookH;
  const tz = me.z + panZ;
  const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
  camera.position.set(
    tx + Math.sin(camYaw) * cp * camDist,
    ty + sp * camDist * 0.85 + 0.35,
    tz + Math.cos(camYaw) * cp * camDist
  );
  camera.lookAt(tx, ty, tz);
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
  const mx = (ix * cs + iz * sn) * speed * dt;
  const mz = (iz * cs - ix * sn) * speed * dt;
  const stepped = slide(me.x, me.z, mx, mz);
  const parted = separatePeers(stepped.x, stepped.z);
  me.x = THREE.MathUtils.clamp(parted.x, bounds.minX, bounds.maxX);
  me.z = THREE.MathUtils.clamp(parted.z, bounds.minZ, bounds.maxZ);
  me.y = THREE.MathUtils.damp(me.y, groundY(me.x, me.z), 8, dt);
  me.moving = Math.hypot(mx, mz) > 0.0008;
  if (me.moving) me.yaw = Math.atan2(mx, mz);

  if (myActor) {
    myActor.root.position.set(me.x, me.y, me.z);
    myActor.root.rotation.y = me.yaw;
    setLocomotion(myActor, me.moving, running);
    myActor.mixer.update(dt);
    if (myActor.vrm) {
      swingWalk(myActor.vrm, clock.elapsedTime, me.moving, running);
      myActor.vrm.update(dt);
    }
  }
  placeCam();

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
    if (st.angle != null) actor.root.rotation.y += (st.angle - actor.root.rotation.y) * Math.min(1, dt * 8);
    setLocomotion(actor, !!st.moving, false);
    actor.mixer.update(dt);
    if (actor.vrm) {
      swingWalk(actor.vrm, clock.elapsedTime, !!st.moving, false);
      actor.vrm.update(dt);
    }
  }
  session.sendState({ x: me.x, y: me.z, angle: me.yaw, moving: me.moving, avatar: me.avatar });
  renderer.render(scene, camera);
}

setupRenderer();
clock = new THREE.Clock();
bind();
drawPickers();
pills();
tick();

enableVrm()
  .then(() => wear("aya"))
  .catch((e) => { console.warn(e); toast("VRM failed, using robot"); return wear("robot"); })
  .then(() => loadWorld("sponza"))
  .catch((e) => { console.warn(e); return loadWorld("house"); });

session.autoEnter?.("LAN").then(() => setLink("in world", "ok")).catch(() => setLink("solo", "dim"));
