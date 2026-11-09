/**
 * Sprawl: one figure, two ways to run N projects, side by side.
 *
 * Left, copied stacks: a box per project, each set down a little askew, each
 * wired to its own port on the operator's desk; the wires cross as N grows.
 * Right, Motherbase: one rack whose slots fill in, aligned, behind a single
 * console on a single wire. Empty slots are dashed. The value is N, 1 to 6.
 *
 * Each half has its own camera, fitted on its own centre: same angle and
 * scale, so they read as one scene.
 */
const { Cam, fit, proj, facing, rings, rrect, prism, put, solid, mk, seg, open, clamp, lerp, rad, tween, tset, tval, tdone, register, disposer } = HL;

const MAX = 6, S = 1.25, CY = 176;

// left: [x, y, turn in degrees, height], hand-picked so it looks dropped, not scattered
const JUNK = [[-30, -26, 12, 26], [8, -36, -18, 20], [-36, 10, -9, 30], [30, -6, 22, 24], [-6, 6, -25, 18], [14, 32, 8, 28]];
const BOX = 11, DESK = [56, 46];
// right: the rack
const RX = 24, RY = 34, RT = 9, RG = 3, RPB = 5, RM = 7, CON = [64, 0];
const RTOP = MAX * (RT + RG);

/** A ring turned by deg about the origin, then moved to (x, y): normals turn with it. */
function turned(ring, deg, x, y) {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  return ring.map((q) => ({ u: x + q.u * c - q.v * s, v: y + q.u * s + q.v * c, nu: q.nu * c - q.nv * s, nv: q.nu * s + q.nv * c }));
}

function mount({ stage, svg, read }, value) {
  const bag = disposer();

  const CL = Cam(45, 0.5, S), CR = Cam(45, 0.5, S);
  fit(CL, [[-50, -50, 0], [64, 56, 0], [64, -50, 0], [-50, 56, 0], [-36, 10, 30]], 104, CY);
  fit(CR, [[-RX - RM, -RY - RM, -RPB], [CON[0] + 10, RY + RM, -RPB], [CON[0] + 10, -RY - RM, -RPB], [-RX - RM, RY + RM, -RPB], [-RX, -RY, RTOP], [RX, RY, RTOP]], 300, CY - 14);
  const PL = proj(CL), PR = proj(CR), fl = facing(CL), fr = facing(CR);

  mk("path", { class: "nf lo dash", d: seg([200, 46], [200, 290]) }, svg);

  // ---- left: wires on the ground first, then boxes far to near, desk last
  const L = mk("g", {}, svg);
  const wires = JUNK.map(([x, y], i) => {
    // sag alternates sides, so neighbours' wires cross on the way to the desk
    const mx = (x + DESK[0]) / 2, my = (y + DESK[1]) / 2, dx = DESK[0] - x, dy = DESK[1] - y, k = (i % 2 ? 0.45 : -0.45);
    const cx = mx - dy * k, cy = my + dx * k, pts = [];
    for (let t = 0; t <= 1.0001; t += 1 / 18) {
      const a = lerp(lerp(x, cx, t), lerp(cx, DESK[0], t), t), b = lerp(lerp(y, cy, t), lerp(cy, DESK[1], t), t);
      pts.push(PL(a, b, 0));
    }
    return mk("path", { class: "nf lo", d: open(pts) }, L);
  });
  const order = JUNK.map((_, i) => i).sort((a, b) => JUNK[a][0] + JUNK[a][1] - (JUNK[b][0] + JUNK[b][1]));
  const boxes = [];
  for (const i of order) {
    const [x, y, deg, h] = JUNK[i];
    boxes[i] = { el: solid(L), h, ring: turned(rrect(-BOX, -BOX, BOX, BOX, 3), deg, x, y), inner: turned(rrect(-BOX + 1.4, -BOX + 1.4, BOX - 1.4, BOX - 1.4, 1.6), deg, x, y), grow: tween(0, 500), drawn: "" };
  }
  const [dr, di] = rings(DESK[0] - 9, DESK[1] - 13, DESK[0] + 9, DESK[1] + 13, 3, 1.2);
  put(solid(L), prism(PL, fl, dr, di, 0, 5));

  // ---- right: plinth, one wire, slots bottom to top, console
  const R = mk("g", {}, svg);
  const [pr, pi] = rings(-RX - RM, -RY - RM, RX + RM, RY + RM, 8, 2);
  put(solid(R), prism(PR, fr, pr, pi, -RPB, 0));
  const wire = mk("path", { class: "nf hi", d: seg(PR(RX + RM, 0, 0), PR(CON[0] - 9, 0, 0)) }, R);
  const slotRing = rings(-RX, -RY, RX, RY, 4, 1.4);
  const slots = [];
  for (let i = 0; i < MAX; i++) {
    const z = i * (RT + RG);
    const empty = mk("path", { class: "nf lo dash", d: prism(PR, fr, slotRing[0], null, z, z + RT).sil }, R);
    const el = solid(R), led = mk("path", { class: "nf hi" }, el.g);
    slots.push({ el, led, empty, z, fill: tween(0, 500), drawn: "" });
  }
  const [kr, ki] = rings(CON[0] - 9, CON[1] - 14, CON[0] + 9, CON[1] + 14, 3, 1.2);
  const con = solid(R);
  con.sil.classList.add("hi");
  put(con, prism(PR, fr, kr, ki, 0, 5));

  function draw(now) {
    let moving = false;
    boxes.forEach((b, i) => {
      const t = tval(b.grow, now), key = t.toFixed(3);
      if (!tdone(b.grow, now)) moving = true;
      if (key === b.drawn) return;
      b.drawn = key;
      b.el.g.style.display = t < 0.02 ? "none" : "";
      wires[i].style.display = t < 0.5 ? "none" : "";
      put(b.el, prism(PL, fl, b.ring, b.inner, 0, b.h * t));
    });
    slots.forEach((s) => {
      const t = tval(s.fill, now), key = t.toFixed(3);
      if (!tdone(s.fill, now)) moving = true;
      if (key === s.drawn) return;
      s.drawn = key;
      // a filled slot slides in from the front on its rails
      const out = (1 - t) * 26;
      s.el.g.style.display = t < 0.02 ? "none" : "";
      s.el.g.style.opacity = String(clamp(t * 1.4, 0, 1));
      const [r, ri] = rings(-RX + out, -RY, RX + out, RY, 4, 1.4);
      put(s.el, prism(PR, fr, r, ri, s.z, s.z + RT));
      s.led.setAttribute("d", seg(PR(RX + out, -RY + 8, s.z + RT / 2), PR(RX + out, -RY + 16, s.z + RT / 2)));
    });
    return moving;
  }

  const B = register(stage, (_dt, now) => draw(now));
  bag.add(B.unregister);

  function set(v) {
    const n = clamp(Math.round(v), 1, MAX), now = performance.now();
    boxes.forEach((b, i) => tset(b.grow, i < n ? 1 : 0, now, i * 60));
    slots.forEach((s, i) => tset(s.fill, i < n ? 1 : 0, now, i * 60));
    read.textContent = `${n} ${n === 1 ? "stack" : "stacks"} to run · 1 console`;
    B.wake();
  }
  set(value);

  bag.add(() => svg.replaceChildren());
  return { set, destroy: bag.dispose };
}

hairline({
  name: "sprawl",
  means: "N projects run two ways: copied stacks wired one by one to a desk, against one rack filling its slots behind one console.",
  rules: [1, 2, 5],
  range: [1, 3, 6],
  mount,
});
