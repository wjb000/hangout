import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createSession } from "./multiplayer.js";

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
let me = { x: 0, z: 4, y: 0, yaw: Math.PI, moving: false, avatar: CAST[0].id };
let myRig = null;
let camYaw = 0, camPitch = 0.28;

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
  const add = (n, c) => { const li = document.createElement("li"); li.innerHTML = `<span class="dot" style="background:${c}"></span>${n}`; el.appendChild(li); };
  add(session.profile.name, session.profile.color);
  for (const p of others.values()) add(p.name || "Guest", p.color || "#fff");
}
function setLink(t, k) { const el = $("link"); if (!el) return; el.textContent = t; el.className = k || "dim"; }

const session = createSession({
  onStatus(msg, kind) { if (kind === "good") setLink("in world", "ok"); else setLink(String(msg||"").toLowerCase(), kind === "bad" ? "bad" : "dim"); },
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

function buildWorld() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15101c);
  scene.fog = new THREE.Fog(0x15101c, 16, 42);
  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 80);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  $("viewport").appendChild(renderer.domElement);
  loader = new GLTFLoader();

  scene.add(new THREE.HemisphereLight(0xffe8d2, 0x1a1024, 0.85));
  const sun = new THREE.DirectionalLight(0xffd2a8, 1.35);
  sun.position.set(6, 10, 4); sun.castShadow = true; scene.add(sun);
  scene.add(new THREE.PointLight(0x66ccff, 1.2, 16).translateY(3));

  const floor = new THREE.Mesh(new THREE.CircleGeometry(11, 48), new THREE.MeshStandardMaterial({ color: 0x3b2a22, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.35, 48), new THREE.MeshBasicMaterial({ color: 0x88e0ff, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; scene.add(ring);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a2030, roughness: 0.8 });
  for (const [x, z, ry] of [[0, -10, 0], [10, 0, Math.PI / 2], [-10, 0, Math.PI / 2]]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(20, 5, 0.35), wallMat);
    w.position.set(x, 2.5, z); w.rotation.y = ry; w.receiveShadow = true; scene.add(w);
  }
  const stage = new THREE.Mesh(new THREE.BoxGeometry(6, 0.35, 3), new THREE.MeshStandardMaterial({ color: 0x4a3428 }));
  stage.position.set(0, 0.18, -7); scene.add(stage);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(5, 2.4), new THREE.MeshStandardMaterial({ color: 0x111018, emissive: 0x224466, emissiveIntensity: 0.5 }));
  screen.position.set(0, 2.4, -9.7); scene.add(screen);
  const couch = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.7, 1.1), new THREE.MeshStandardMaterial({ color: 0x6a3a38 }));
  couch.position.set(-5, 0.35, 1); scene.add(couch);
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

function drawPicker() {
  const el = $("picker");
  el.innerHTML = "";
  for (const c of CAST) {
    const b = document.createElement("button");
    b.dataset.id = c.id; b.textContent = c.name;
    if (c.id === me.avatar) b.classList.add("on");
    b.onclick = () => wear(c.id);
    el.appendChild(b);
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
  const speed = keys.ShiftLeft ? 6.2 : 3.6;
  const cs = Math.cos(camYaw), sn = Math.sin(camYaw);
  const mx = (ix * cs + iz * sn) * speed;
  const mz = (iz * cs - ix * sn) * speed;
  me.x = THREE.MathUtils.clamp(me.x + mx * dt, -9, 9);
  me.z = THREE.MathUtils.clamp(me.z + mz * dt, -9, 9);
  me.moving = Math.abs(mx) + Math.abs(mz) > 0.1;
  if (me.moving) me.yaw = Math.atan2(mx, mz);

  if (myRig) {
    myRig.position.set(me.x, 0, me.z);
    myRig.rotation.y = me.yaw;
    if (me.moving) myRig.position.y = Math.abs(Math.sin(clock.elapsedTime * 10)) * 0.05;
  }

  const back = 4.2, lift = 1.7;
  camera.position.set(
    me.x + Math.sin(camYaw) * Math.cos(camPitch) * back,
    lift + Math.sin(camPitch) * 2.2,
    me.z + Math.cos(camYaw) * Math.cos(camPitch) * back
  );
  camera.lookAt(me.x, 1.2, me.z);

  for (const [id, st] of others) {
    let rig = remoteMesh.get(id);
    if (!rig || rig.userData.avatar !== (st.avatar || "xbot")) {
      if (rig) scene.remove(rig);
      wear(st.avatar || "xbot", "remote").then((m) => {
        m.userData.avatar = st.avatar || "xbot";
        scene.add(m); remoteMesh.set(id, m);
      });
      continue;
    }
    rig.position.x += ((st.x ?? 0) - rig.position.x) * Math.min(1, dt * 8);
    rig.position.z += ((st.y ?? 0) - rig.position.z) * Math.min(1, dt * 8);
    if (st.angle != null) rig.rotation.y += (st.angle - rig.rotation.y) * Math.min(1, dt * 8);
  }

  session.sendState({ x: me.x, y: me.z, angle: me.yaw, moving: me.moving, avatar: me.avatar });
  renderer.render(scene, camera);
}

buildWorld();
clock = new THREE.Clock();
bind();
drawPicker();
pills();
wear(me.avatar).then(() => tick());

session.autoEnter?.("LAN").then(() => setLink("in world", "ok")).catch(() => setLink("solo", "dim"));
