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
let me = { x: -4, z: 2, y: 0, yaw: 0.6, moving: false, avatar: CAST[0].id };
let myRig = null;
let camYaw = 0.6, camPitch = 0.22;

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
  onStatus(msg, kind) { if (kind === "good") setLink("black cat", "ok"); else setLink(String(msg||"").toLowerCase(), kind === "bad" ? "bad" : "dim"); },
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

function box(x, y, z, w, h, d, color, opts = {}) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({
      color, roughness: opts.r ?? 0.75, metalness: opts.m ?? 0,
      emissive: opts.e || 0, emissiveIntensity: opts.ei || 0,
    })
  );
  m.position.set(x, y, z);
  if (opts.ry) m.rotation.y = opts.ry;
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m); return m;
}

function buildWorld() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b090c);
  scene.fog = new THREE.Fog(0x0b090c, 18, 36);
  camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.08, 70);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  $("viewport").appendChild(renderer.domElement);
  loader = new GLTFLoader();

  scene.add(new THREE.HemisphereLight(0xffd8b0, 0x08060a, 0.35));
  const key = new THREE.DirectionalLight(0xffe0c0, 0.55);
  key.position.set(-6, 8, 3); key.castShadow = true; scene.add(key);

  // split floors: wood dance left, dark carpet right
  const wood = new THREE.Mesh(new THREE.PlaneGeometry(12, 16), new THREE.MeshStandardMaterial({ color: 0x6a4a30, roughness: 0.7 }));
  wood.rotation.x = -Math.PI / 2; wood.position.set(-5, 0, 0); wood.receiveShadow = true; scene.add(wood);
  const carpet = new THREE.Mesh(new THREE.PlaneGeometry(14, 16), new THREE.MeshStandardMaterial({ color: 0x161416, roughness: 0.95 }));
  carpet.rotation.x = -Math.PI / 2; carpet.position.set(6, 0, 0); carpet.receiveShadow = true; scene.add(carpet);
  box(-5.9, 0.08, 0, 0.25, 0.16, 16, 0x4a3424); // step lip

  // room shell
  box(0, 2.6, -8.1, 24, 5.2, 0.35, 0x1c1818);
  box(0, 2.6, 8.1, 24, 5.2, 0.35, 0x1c1818);
  box(-12, 2.6, 0, 0.35, 5.2, 16.4, 0x2a2420);
  box(12.9, 2.6, 0, 0.35, 5.2, 16.4, 0x1a1818);
  box(0, 5.15, 0, 26, 0.2, 17, 0x121010);

  // cream wall + lounge (Black Cat left lobby)
  box(-10.2, 1.5, -3.6, 3.2, 3, 0.12, 0xd8cbb8);
  box(-10.6, 0.42, -5.1, 1.3, 0.72, 1.15, 0xc4b49a);
  box(-9.1, 0.42, -5.1, 1.3, 0.72, 1.15, 0xc4b49a);
  box(-9.85, 0.28, -4.15, 0.7, 0.08, 0.7, 0x3a2a20);
  const lamp = new THREE.PointLight(0xffc37a, 1.6, 6); lamp.position.set(-9.85, 1.05, -4.15); scene.add(lamp);

  // center circular bar + cat tower
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(2.55, 2.55, 1.05, 28, 1, true), new THREE.MeshStandardMaterial({ color: 0x2a2a2c, roughness: 0.55 }));
  bar.position.set(2.2, 0.52, 0.4); scene.add(bar);
  const top = new THREE.Mesh(new THREE.TorusGeometry(2.55, 0.16, 8, 28), new THREE.MeshStandardMaterial({ color: 0xc9a36a, roughness: 0.4 }));
  top.rotation.x = Math.PI / 2; top.position.set(2.2, 1.05, 0.4); scene.add(top);
  box(2.2, 2.7, 0.4, 2.4, 3.4, 2.4, 0x111111);
  // glowing cat eyes
  const eyeM = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffee, emissiveIntensity: 2.2 });
  const e1 = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), eyeM); e1.position.set(1.85, 3.55, 1.55); scene.add(e1);
  const e2 = e1.clone(); e2.position.set(2.55, 3.55, 1.55); scene.add(e2);
  const ear = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.4, 4), new THREE.MeshStandardMaterial({ color: 0x111111 }));
  ear.position.set(1.7, 4.45, 0.5); scene.add(ear);
  const ear2 = ear.clone(); ear2.position.set(2.7, 4.45, 0.5); scene.add(ear2);
  const barLight = new THREE.PointLight(0xffaa66, 2.0, 10); barLight.position.set(2.2, 2.2, 0.4); scene.add(barLight);
  // stools
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    box(2.2 + Math.cos(a) * 3.15, 0.42, 0.4 + Math.sin(a) * 3.15, 0.32, 0.84, 0.32, 0x1a1a1a);
  }
  // bottles
  for (const ox of [-0.4, 0, 0.4]) box(2.2 + ox, 1.45, 0.15, 0.08, 0.32, 0.08, 0x66aacc, { e: 0x224466, ei: 0.4 });

  // booths along +X windows
  for (let i = 0; i < 4; i++) {
    const z = -5.2 + i * 3.1;
    box(10.4, 0.55, z, 2.4, 1.1, 1.5, 0xc4a06a);
    box(11.35, 0.95, z, 0.25, 1.9, 1.5, 0x2a2420);
    box(10.4, 0.38, z - 0.95, 1.1, 0.08, 0.7, 0x3a2a22);
  }
  // window wall glow
  for (let i = 0; i < 5; i++) {
    box(12.6, 2.3, -6 + i * 3, 0.08, 3.2, 1.5, 0x1a2230, { e: 0x334466, ei: 0.25 });
  }

  // dining tables -X of bar
  for (const [x, z] of [[-2.2, 4.2], [-2.2, 6.2], [6.4, 5.5], [6.4, 3.4]]) {
    box(x, 0.42, z, 1.15, 0.08, 1.15, 0x5a4030);
    box(x, 0.22, z, 0.12, 0.44, 0.12, 0x2a2018);
  }

  // stage + red curtain
  box(-5.2, 0.22, -6.4, 6.4, 0.44, 3.2, 0x5a4030);
  box(-5.2, 2.3, -7.75, 5.2, 2.6, 0.08, 0x8a2030, { e: 0x400810, ei: 0.2 });
  const spot = new THREE.SpotLight(0xffe6c4, 3.2, 14, 0.55, 0.4); spot.position.set(-5.2, 4.6, -4.2); spot.target.position.set(-5.2, 0, -6.4); scene.add(spot); scene.add(spot.target);

  // hanging cage lights
  for (const [x, z] of [[8, -2], [8, 2], [8, 5], [-8, 1], [-3, 5]]) {
    const pl = new THREE.PointLight(0xffcc88, 1.1, 6); pl.position.set(x, 3.3, z); scene.add(pl);
    box(x, 3.55, z, 0.35, 0.12, 0.35, 0x222018, { e: 0xffcc88, ei: 0.6 });
  }
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
  const el = $("picker"); el.innerHTML = "";
  for (const c of CAST) {
    const b = document.createElement("button");
    b.dataset.id = c.id; b.textContent = c.name;
    if (c.id === me.avatar) b.classList.add("on");
    b.onclick = () => wear(c.id); el.appendChild(b);
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
  me.x = THREE.MathUtils.clamp(me.x + mx * dt, -11, 11.5);
  me.z = THREE.MathUtils.clamp(me.z + mz * dt, -7.2, 7.2);
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

buildWorld();
clock = new THREE.Clock();
bind();
drawPicker();
pills();
wear(me.avatar).then(() => tick());
session.autoEnter?.("LAN").then(() => setLink("the black cat", "ok")).catch(() => setLink("solo", "dim"));
