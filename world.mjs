import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { createSession } from "./multiplayer.js";
import { WORLDS } from "./worlds.js";
import { CAST } from "./avatars.js";

const $ = (id) => document.getElementById(id);
const others = new Map();
const remote = new Map();
const keys = Object.create(null);
let chatFocused = false;
let scene, camera, renderer, labels, clock, loader;
let worldRoot = null;
let bounds = { minX: -18, maxX: 18, minZ: -18, maxZ: 18 };
let me = { x: 0, z: 4, y: 0, yaw: 0, moving: false, avatar: "aya", world: "sponza" };
let myActor = null;
let yaw = 0.45, pitch = 0.3, dist = 5.2;
let cam = { x: 0, y: 2, z: 6 };
let vel = { x: 0, z: 0 };
let dragging = false;
let vrmMod = null;
let wearing = false;

function toast(t) {
  const el = $("toast"); if (!el) return;
  el.textContent = t; el.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), 2000);
}
function log(t) {
  const box = $("chat-log"); if (!box) return;
  const p = document.createElement("div"); p.textContent = t; box.appendChild(p); box.scrollTop = box.scrollHeight;
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
function bootOff() { $("boot")?.classList.add("off"); }

const session = createSession({
  onStatus(msg, kind) {
    if (kind === "good") setLink("in world", "ok");
    else setLink(String(msg || "").toLowerCase(), kind === "bad" ? "bad" : "dim");
  },
  onState(id, st) {
    const first = !others.has(id);
    others.set(id, { ...(others.get(id) || {}), ...st });
    if (first && st.name) toast(st.name + " walked in");
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

session.setProfile({ name: localStorage.getItem("hangout_name") || "you" });
$("who").textContent = session.profile.name;
$("who").onclick = () => {
  const n = prompt("Name", session.profile.name); if (!n) return;
  session.setProfile({ name: n }); $("who").textContent = n; pills();
  if (myActor) tag(myActor, n);
};
$("chat-form").onsubmit = (e) => {
  e.preventDefault();
  const inp = $("chat-input"); const t = inp.value.trim(); if (!t) return;
  log(`${session.profile.name}: ${t}`); session.sendChat?.(t); inp.value = ""; inp.blur();
};
$("chat-input").onfocus = () => { chatFocused = true; };
$("chat-input").onblur = () => { chatFocused = false; };

function tag(actor, name) {
  if (!actor || actor.tagName === name) return;
  actor.tagName = name;
  if (actor.label) actor.root.remove(actor.label);
  const div = document.createElement("div");
  div.className = "tag"; div.textContent = name || "";
  const obj = new CSS2DObject(div);
  obj.position.set(0, 1.9, 0);
  actor.root.add(obj); actor.label = obj;
}

function pose(vrm, name, axis, v) {
  const h = vrm?.humanoid; if (!h) return;
  for (const n of [h.getNormalizedBoneNode?.(name), h.getBoneNode?.(name)].filter(Boolean)) n.rotation[axis] = v;
}
function walkPose(vrm, t, moving, run) {
  if (!vrm?.humanoid) return;
  const s = run ? 12 : 8;
  const a = moving ? (run ? 0.82 : 0.52) : 0.025;
  pose(vrm, "leftUpperLeg", "x", Math.sin(t * s) * a);
  pose(vrm, "rightUpperLeg", "x", Math.sin(t * s + Math.PI) * a);
  pose(vrm, "leftLowerLeg", "x", Math.max(0, -Math.sin(t * s) * a * 0.8));
  pose(vrm, "rightLowerLeg", "x", Math.max(0, -Math.sin(t * s + Math.PI) * a * 0.8));
  pose(vrm, "leftUpperArm", "z", 1.05 + Math.sin(t * s + Math.PI) * a * 0.38);
  pose(vrm, "rightUpperArm", "z", -1.05 + Math.sin(t * s) * a * 0.38);
}

function setup() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x121018);
  scene.fog = new THREE.Fog(0x121018, 20, 58);
  camera = new THREE.PerspectiveCamera(56, innerWidth / innerHeight, 0.12, 140);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  $("viewport").appendChild(renderer.domElement);
  labels = new CSS2DRenderer();
  labels.setSize(innerWidth, innerHeight);
  labels.domElement.style.cssText = "position:fixed;inset:0;pointer-events:none;";
  document.body.appendChild(labels.domElement);
  loader = new GLTFLoader();
  scene.add(new THREE.HemisphereLight(0xffe6d0, 0x101018, 0.95));
  const sun = new THREE.DirectionalLight(0xfff3dd, 1.5);
  sun.position.set(8, 18, 7); scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 0.36));
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(36, 48),
    new THREE.MeshStandardMaterial({ color: 0x16121c, roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2; scene.add(floor);
}

async function enableVrm() {
  if (vrmMod) return vrmMod;
  vrmMod = await import("@pixiv/three-vrm");
  loader.register((p) => new vrmMod.VRMLoaderPlugin(p));
  return vrmMod;
}

async function loadWorld(id) {
  const spec = WORLDS.find((w) => w.id === id) || WORLDS[0];
  toast("loading " + spec.name);
  if (worldRoot) scene.remove(worldRoot);
  const gltf = await loader.loadAsync(spec.url);
  worldRoot = gltf.scene;
  worldRoot.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
  const box = new THREE.Box3().setFromObject(worldRoot);
  const size = new THREE.Vector3(); box.getSize(size);
  worldRoot.scale.setScalar(size.y > 0.01 ? (spec.height || 12) / size.y : 1);
  worldRoot.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(worldRoot);
  worldRoot.position.set(-(b.min.x + b.max.x) * 0.5, -b.min.y, -(b.min.z + b.max.z) * 0.5);
  worldRoot.updateMatrixWorld(true);
  const f = new THREE.Box3().setFromObject(worldRoot);
  bounds = { minX: f.min.x + 1.4, maxX: f.max.x - 1.4, minZ: f.min.z + 1.4, maxZ: f.max.z - 1.4 };
  scene.add(worldRoot);
  me.world = spec.id;
  me.x = spec.spawn?.x ?? 0;
  me.z = spec.spawn?.z ?? 4;
  document.querySelectorAll("#worlds button").forEach((btn) => btn.classList.toggle("on", btn.dataset.id === spec.id));
  toast(spec.name);
}

async function loadCast(id) {
  const spec = CAST.find((c) => c.id === id) || CAST[0];
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

function clipsOf(mixer, clips) {
  const find = (re) => clips.find((c) => re.test(c.name));
  const idle = find(/idle/i), walk = find(/walk/i), run = find(/run/i);
  return {
    idle: idle ? mixer.clipAction(idle) : null,
    walk: walk ? mixer.clipAction(walk) : null,
    run: run ? mixer.clipAction(run) : null,
  };
}

async function wear(id, target = "me", name) {
  if (target === "me" && wearing) return myActor;
  if (target === "me") wearing = true;
  try {
    const { root, clips, vrm } = await loadCast(id);
    const mixer = new THREE.AnimationMixer(root);
    const actor = { root, mixer, vrm, ...clipsOf(mixer, clips) };
    actor.idle?.play();
    tag(actor, name || (target === "me" ? session.profile.name : ""));
    if (target === "me") {
      if (myActor?.root) scene.remove(myActor.root);
      myActor = actor; scene.add(root); me.avatar = id;
      document.querySelectorAll("#picker button").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
    }
    return actor;
  } finally {
    if (target === "me") wearing = false;
  }
}

function drawUI() {
  const av = $("picker"); av.innerHTML = "";
  for (const c of CAST) {
    const b = document.createElement("button");
    b.dataset.id = c.id; b.textContent = c.name;
    if (c.id === me.avatar) b.classList.add("on");
    b.onclick = () => wear(c.id).catch((e) => toast(String(e.message || e)));
    av.appendChild(b);
  }
  const worlds = $("worlds"); worlds.innerHTML = "";
  for (const w of WORLDS) {
    const b = document.createElement("button");
    b.dataset.id = w.id; b.textContent = w.name;
    if (w.id === me.world) b.classList.add("on");
    b.onclick = () => loadWorld(w.id).catch((e) => toast(String(e)));
    worlds.appendChild(b);
  }
}

function bind() {
  addEventListener("keydown", (e) => {
    if (e.code === "KeyT" && !chatFocused) { e.preventDefault(); $("chat-input").focus(); return; }
    if (e.code === "Escape") $("chat-input").blur();
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
    yaw -= e.movementX * 0.0048;
    pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.003, 0.08, 1.12);
  });
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    dist = THREE.MathUtils.clamp(dist + e.deltaY * 0.01, 2.3, 12);
  }, { passive: false });
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    labels.setSize(innerWidth, innerHeight);
  });
}

function loco(actor, moving, running) {
  if (!actor) return;
  const want = moving ? (running && actor.run ? actor.run : actor.walk || actor.idle) : actor.idle;
  for (const a of [actor.idle, actor.walk, actor.run]) {
    if (!a || a === want) continue;
    if (a.isRunning()) a.fadeOut(0.14);
  }
  if (want && !want.isRunning()) want.reset().fadeIn(0.14).play();
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
  const moving = !chatFocused && (fx !== 0 || fz !== 0);
  if (moving) {
    const len = Math.hypot(fx, fz);
    fx /= len; fz /= len;
  }
  const running = !!(keys.ShiftLeft || keys.ShiftRight);
  const speed = running ? 7.1 : 3.6;
  const fX = -Math.sin(yaw), fZ = -Math.cos(yaw);
  const rX = Math.cos(yaw), rZ = -Math.sin(yaw);
  const tx = moving ? (fX * fz + rX * fx) * speed : 0;
  const tz = moving ? (fZ * fz + rZ * fx) * speed : 0;
  vel.x += (tx - vel.x) * Math.min(1, dt * 10);
  vel.z += (tz - vel.z) * Math.min(1, dt * 10);
  me.x = THREE.MathUtils.clamp(me.x + vel.x * dt, bounds.minX, bounds.maxX);
  me.z = THREE.MathUtils.clamp(me.z + vel.z * dt, bounds.minZ, bounds.maxZ);
  me.moving = Math.hypot(vel.x, vel.z) > 0.35;
  if (me.moving) me.yaw = Math.atan2(vel.x, vel.z);

  if (myActor) {
    myActor.root.position.set(me.x, me.y, me.z);
    myActor.root.rotation.y += (me.yaw - myActor.root.rotation.y) * Math.min(1, dt * 10);
    loco(myActor, me.moving, running);
    myActor.mixer.update(dt);
    if (myActor.vrm) { walkPose(myActor.vrm, clock.elapsedTime, me.moving, running); myActor.vrm.update(dt); }
  }

  const lookY = me.y + 1.32;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const wantX = me.x + Math.sin(yaw) * cp * dist;
  const wantY = lookY + sp * dist;
  const wantZ = me.z + Math.cos(yaw) * cp * dist;
  cam.x += (wantX - cam.x) * Math.min(1, dt * 8);
  cam.y += (wantY - cam.y) * Math.min(1, dt * 8);
  cam.z += (wantZ - cam.z) * Math.min(1, dt * 8);
  camera.position.set(cam.x, cam.y, cam.z);
  camera.lookAt(me.x, lookY, me.z);

  for (const [id, st] of others) {
    let actor = remote.get(id);
    const wantAv = st.avatar || "aya";
    if (!actor || actor.root.userData.avatar !== wantAv) {
      if (actor?.root) scene.remove(actor.root);
      remote.delete(id);
      wear(wantAv, "remote", st.name).then((a) => {
        a.root.userData.avatar = wantAv; scene.add(a.root); remote.set(id, a);
      });
      continue;
    }
    actor.root.position.x += ((st.x ?? 0) - actor.root.position.x) * Math.min(1, dt * 8);
    actor.root.position.z += ((st.y ?? 0) - actor.root.position.z) * Math.min(1, dt * 8);
    if (st.angle != null) actor.root.rotation.y += (st.angle - actor.root.rotation.y) * Math.min(1, dt * 8);
    tag(actor, st.name || "Guest");
    loco(actor, !!st.moving, false);
    actor.mixer.update(dt);
    if (actor.vrm) { walkPose(actor.vrm, clock.elapsedTime, !!st.moving, false); actor.vrm.update(dt); }
  }

  session.sendState({ x: me.x, y: me.z, angle: me.yaw, moving: me.moving, avatar: me.avatar });
  renderer.render(scene, camera);
  labels.render(scene, camera);
}

setup();
clock = new THREE.Clock();
bind();
drawUI();
pills();
tick();

enableVrm()
  .then(() => wear("aya"))
  .catch(() => wear("robot"))
  .then(() => loadWorld("sponza"))
  .catch(() => loadWorld("house"))
  .finally(bootOff);

session.autoEnter?.("LAN").then(() => setLink("in world", "ok")).catch(() => setLink("solo", "dim"));
