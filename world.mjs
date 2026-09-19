import * as THREE from "three";
import { createSession, COLORS } from "./multiplayer.js";

const others = new Map();
const avatars = new Map();
const keys = {};
let chatFocused = false;
let scene, camera, renderer, clock, player, pointerLocked;
const $ = (id) => document.getElementById(id);

function toast(text) {
  const el = $("toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2200);
}
function log(text, cls = "") {
  const box = $("chat-log");
  if (!box) return;
  const p = document.createElement("div");
  if (cls) p.className = cls;
  p.textContent = text;
  box.appendChild(p);
  box.scrollTop = box.scrollHeight;
}
function pills() {
  const el = $("pills");
  if (!el) return;
  el.innerHTML = "";
  const add = (name, color) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="dot" style="background:${color}"></span>${name}`;
    el.appendChild(li);
  };
  add(session.profile.name, session.profile.color);
  add("Bit", "#55c8ff");
  add("Nox", "#ff7aa8");
  for (const p of others.values()) add(p.name || "Guest", p.color || "#fff");
}
function setLink(text, kind) {
  const el = $("link");
  if (!el) return;
  el.textContent = text;
  el.className = kind || "dim";
}

const session = createSession({
  onStatus(msg, kind) {
    if (kind === "good") setLink("together", "ok");
    else setLink(String(msg || "").toLowerCase(), kind === "bad" ? "bad" : "dim");
  },
  onState(id, st) {
    const first = !others.has(id);
    others.set(id, { ...(others.get(id) || {}), ...st });
    if (first && st.name) toast(`${st.name} walked in`);
    pills();
  },
  onLeave(id) {
    const p = others.get(id);
    if (p?.name) toast(`${p.name} left`);
    others.delete(id);
    const mesh = avatars.get(id);
    if (mesh && scene) scene.remove(mesh);
    avatars.delete(id);
    pills();
  },
  onRoster: pills,
  onChat(_from, text, name) { log(`${name}: ${text}`); },
});

session.setProfile({ name: (localStorage.getItem("hangout_name") && localStorage.getItem("hangout_name") !== "Player") ? localStorage.getItem("hangout_name") : "you" });
if (!localStorage.getItem("hangout_color")) session.pickColor((Math.random() * COLORS.length) | 0);
const who = $("who");
if (who) {
  who.textContent = session.profile.name;
  who.onclick = () => {
    const name = prompt("Name", session.profile.name);
    if (!name) return;
    session.setProfile({ name });
    who.textContent = session.profile.name;
    pills();
  };
}
$("chat-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const inp = $("chat-input");
  const t = inp?.value.trim();
  if (!t) return;
  log(`${session.profile.name}: ${t}`, "me");
  session.sendChat?.(t);
  inp.value = "";
  inp.blur();
});
$("chat-input")?.addEventListener("focus", () => { chatFocused = true; });
$("chat-input")?.addEventListener("blur", () => { chatFocused = false; });

function makeAvatar(color, headColor, name) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.7, 6, 12), new THREE.MeshStandardMaterial({ color, roughness: 0.45 }));
  body.position.y = 0.85; body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), new THREE.MeshStandardMaterial({ color: headColor || "#ffe8d2", roughness: 0.35 }));
  head.position.y = 1.48;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.08, 0.08), new THREE.MeshStandardMaterial({ color: "#111", emissive: color, emissiveIntensity: 0.4 }));
  visor.position.set(0, 1.5, 0.16);
  g.add(body, head, visor);
  const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(0,0,0,.5)"; ctx.fillRect(0, 16, 256, 36);
  ctx.fillStyle = "#fff"; ctx.font = "26px sans-serif"; ctx.textAlign = "center"; ctx.fillText(name || "?", 128, 42);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true }));
  spr.scale.set(1.3, 0.32, 1); spr.position.y = 1.88; g.add(spr);
  return g;
}
function addBox(x, y, z, w, h, d, color, opts = {}) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.7, emissive: opts.emissive || 0, emissiveIntensity: opts.ei || 0 }));
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; scene.add(m); return m;
}
function buildLobby() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1418);
  scene.fog = new THREE.Fog(0x1a1418, 22, 52);
  camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.08, 80);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  $("viewport").appendChild(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xffe6c8, 0x1a1020, 0.7));
  const key = new THREE.DirectionalLight(0xffc9a0, 1.2); key.position.set(6, 12, 4); key.castShadow = true; scene.add(key);
  const neon = new THREE.PointLight(0xff7a3d, 2.2, 18); neon.position.set(0, 3.2, -6); scene.add(neon);
  const cyan = new THREE.PointLight(0x44ddff, 1.4, 14); cyan.position.set(-6, 2.4, 4); scene.add(cyan);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(28, 28), new THREE.MeshStandardMaterial({ color: 0x3a2c24, roughness: 0.85 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const grid = new THREE.GridHelper(28, 28, 0x5a4030, 0x2a2018); grid.position.y = 0.01; scene.add(grid);
  addBox(0, 2, -14, 28, 4, 0.4, 0x2a2024);
  addBox(0, 2, 14, 28, 4, 0.4, 0x2a2024);
  addBox(-14, 2, 0, 0.4, 4, 28, 0x2a2024);
  addBox(14, 2, 0, 0.4, 4, 28, 0x2a2024);
  addBox(0, 0.25, -10, 8, 0.5, 4, 0x4a3428);
  addBox(0, 2.4, -12.2, 6, 2.2, 0.12, 0x221018, { emissive: 0xff5522, ei: 0.35 });
  addBox(-6, 0.35, 2, 3.2, 0.7, 1.2, 0x6b3a2a);
  addBox(-6, 0.7, 2.55, 3.2, 0.7, 0.3, 0x5a3024);
  addBox(6, 0.35, 2, 3.2, 0.7, 1.2, 0x3a4a6b);
  addBox(6, 0.7, 2.55, 3.2, 0.7, 0.3, 0x2e3c58);
  addBox(-6, 0.35, 0.4, 1.4, 0.08, 1.4, 0xc9a46a);
  addBox(6, 0.35, 0.4, 1.4, 0.08, 1.4, 0xc9a46a);
  addBox(0, 0.45, 6, 2.4, 0.9, 2.4, 0x243028, { emissive: 0x114422, ei: 0.2 });
  for (const x of [-8, 0, 8]) addBox(x, 3.7, 0, 1.6, 0.08, 1.6, 0xffd8a8, { emissive: 0xffcc88, ei: 0.7 });
  player = { x: 0, y: 1.6, z: 6, vy: 0, yaw: Math.PI, pitch: 0, moving: false };
  const bit = makeAvatar("#55c8ff", "#d0f0ff", "Bit"); bit.position.set(-4, 0, -2); bit.userData.wander = { ox: -4, oz: -2, t: 0 }; scene.add(bit);
  const nox = makeAvatar("#ff7aa8", "#ffd0e4", "Nox"); nox.position.set(4.2, 0, -1.2); nox.userData.wander = { ox: 4.2, oz: -1.2, t: 1.7 }; scene.add(nox);
  scene.userData.npcs = [bit, nox];
}
function bindControls() {
  addEventListener("keydown", (e) => {
    if (e.code === "KeyT" && !chatFocused) { e.preventDefault(); $("chat-input")?.focus(); return; }
    if (chatFocused) return;
    keys[e.code] = true;
  });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  renderer.domElement.addEventListener("click", () => renderer.domElement.requestPointerLock());
  document.addEventListener("pointerlockchange", () => {
    pointerLocked = document.pointerLockElement === renderer.domElement;
    if (pointerLocked) $("hint")?.classList.add("off");
  });
  addEventListener("mousemove", (e) => {
    if (!pointerLocked || chatFocused) return;
    player.yaw -= e.movementX * 0.0022;
    player.pitch = Math.max(-1.2, Math.min(1.2, player.pitch - e.movementY * 0.0022));
  });
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}
function collide(x, z) { return Math.abs(x) > 13.2 || Math.abs(z) > 13.2; }
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  let ix = 0, iz = 0;
  if (!chatFocused) {
    if (keys.KeyW || keys.ArrowUp) iz -= 1;
    if (keys.KeyS || keys.ArrowDown) iz += 1;
    if (keys.KeyA || keys.ArrowLeft) ix -= 1;
    if (keys.KeyD || keys.ArrowRight) ix += 1;
    if (keys.Space && player.y <= 1.61) player.vy = 4.2;
  }
  const speed = keys.ShiftLeft ? 7.2 : 4.4;
  const cs = Math.cos(player.yaw), sn = Math.sin(player.yaw);
  const mx = (ix * cs + iz * sn) * speed;
  const mz = (iz * cs - ix * sn) * speed;
  const nx = player.x + mx * dt, nz = player.z + mz * dt;
  if (!collide(nx, player.z)) player.x = nx;
  if (!collide(player.x, nz)) player.z = nz;
  player.vy -= 14 * dt; player.y += player.vy * dt;
  if (player.y < 1.6) { player.y = 1.6; player.vy = 0; }
  player.moving = Math.abs(mx) + Math.abs(mz) > 0.1;
  camera.position.set(player.x, player.y, player.z);
  camera.rotation.order = "YXZ"; camera.rotation.y = player.yaw; camera.rotation.x = player.pitch;
  for (const npc of scene.userData.npcs || []) {
    const w = npc.userData.wander; w.t += dt * 0.35;
    npc.position.x = w.ox + Math.sin(w.t) * 2.4;
    npc.position.z = w.oz + Math.cos(w.t * 0.8) * 1.6;
    npc.rotation.y = Math.atan2(Math.cos(w.t), -Math.sin(w.t * 0.8));
  }
  for (const [id, st] of others) {
    let mesh = avatars.get(id);
    if (!mesh) { mesh = makeAvatar(st.color || "#88ffaa", st.headColor || "#fff", st.name || "Guest"); scene.add(mesh); avatars.set(id, mesh); }
    const tx = st.x ?? mesh.position.x, tz = st.y ?? mesh.position.z;
    mesh.position.x += (tx - mesh.position.x) * Math.min(1, dt * 8);
    mesh.position.z += (tz - mesh.position.z) * Math.min(1, dt * 8);
    if (st.angle != null) mesh.rotation.y += (st.angle - mesh.rotation.y) * Math.min(1, dt * 8);
  }
  session.sendState({ x: player.x, y: player.z, angle: player.yaw, moving: player.moving, walkPhase: t });
  renderer.render(scene, camera);
}
try {
  buildLobby(); clock = new THREE.Clock(); bindControls(); pills(); tick();
} catch (err) {
  console.error(err); setLink(String(err.message || err), "bad");
}
session.autoEnter?.("LAN").then((r) => {
  setLink(r.role === "host" ? "open for this wifi" : "together", "ok");
}).catch((e) => { setLink("solo for now", "dim"); console.warn(e); });
