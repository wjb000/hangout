const IDLE_VRMA = "https://cdn.jsdelivr.net/gh/aikeyaorg/aikeya@main/static/animations/idle.vrma";

export function dressLayers(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const n = String(o.name || "").toLowerCase();
    if (/hair|kami|bang/.test(n)) o.renderOrder = 5;
    else if (/cloth|wear|shirt|skirt|dress|jacket|pants|onepiece|uniform|coat/.test(n)) o.renderOrder = 4;
    else if (/face|head|eye|brow|mouth|tooth/.test(n)) o.renderOrder = 3;
    else if (/body|skin/.test(n)) o.renderOrder = 1;
    else o.renderOrder = 2;
    const mats = [].concat(o.material || []);
    for (const m of mats) {
      if (!m) continue;
      if (m.transparent) o.renderOrder += 1;
      m.depthWrite = !m.transparent;
    }
  });
}

function bones(vrm, name) {
  const h = vrm?.humanoid;
  if (!h) return [];
  const out = [];
  const a = h.getNormalizedBoneNode?.(name);
  const b = h.getBoneNode?.(name);
  if (a) out.push(a);
  if (b && b !== a) out.push(b);
  return out;
}
function setAx(vrm, name, axis, value) {
  for (const n of bones(vrm, name)) n.rotation[axis] = value;
}

export function swingWalk(vrm, t, moving, run) {
  if (!vrm?.humanoid) return;
  const spd = run ? 12 : 8;
  const amp = moving ? (run ? 0.9 : 0.55) : 0.06;
  setAx(vrm, "leftUpperLeg", "x", Math.sin(t * spd) * amp);
  setAx(vrm, "rightUpperLeg", "x", Math.sin(t * spd + Math.PI) * amp);
  setAx(vrm, "leftLowerLeg", "x", Math.max(0, -Math.sin(t * spd) * amp * 0.75));
  setAx(vrm, "rightLowerLeg", "x", Math.max(0, -Math.sin(t * spd + Math.PI) * amp * 0.75));
  setAx(vrm, "leftUpperArm", "z", 1.05 + Math.sin(t * spd + Math.PI) * amp * 0.4);
  setAx(vrm, "rightUpperArm", "z", -1.05 + Math.sin(t * spd) * amp * 0.4);
  setAx(vrm, "hips", "y", moving ? Math.sin(t * spd) * 0.06 : 0);
}

export async function bindIdle(loader, vrm) {
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
