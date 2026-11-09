/**
 * Gyroscope: a rotor in two gimbals, inside a fixed hoop on a stand. The
 * pointer is where it should look: the middle gimbal turns about the upright
 * axis toward it, and the inner one tips after it on a softer spring, so it
 * arrives late. At rest the rotor looks off to one side. The slider is how
 * far the gimbals may swing, in degrees.
 *
 * Every hoop is a band drawn in two halves: the far half before what is inside
 * it, the near half after, so the band hides what it passes in front of.
 */
const { Cam, circ, clamp, facing, fit, hull, poly, prism, proj, put, rad, rings, spring, stepS, disposer, mk, place, pointer, register, solid } = HL;

const ZC = 76, R0 = 60, R1 = 49, R2 = 38, RR = 22, RT = 7, BW = 5, YAW0 = 28, PITCH0 = -16;
const V = [Math.SQRT1_2 * Math.sqrt(0.75), Math.SQRT1_2 * Math.sqrt(0.75), 0.5]; // toward the camera at Cam(45, 0.5)
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const comb = (...terms) => [0, 1, 2].map((k) => terms.reduce((s, [v, w]) => s + v[k] * w, 0));
const O = [0, 0, ZC];

/** A circle of radius r about c in the plane spanned by e1, e2, offset w along n, from angle t0 to t1. */
function arc(c, e1, e2, n, r, w, t0, t1, m) {
  const out = [];
  for (let k = 0; k <= m; k++) {
    const t = t0 + ((t1 - t0) * k) / m;
    out.push(comb([c, 1], [e1, r * Math.cos(t)], [e2, r * Math.sin(t)], [n, w]));
  }
  return out;
}

/** A hoop of radius r with normal n and axis e1 in its plane: its far and near halves, as band outlines. */
function hoop(P, n, e1, r) {
  const e2 = cross(n, e1), a = Math.atan2(dot(V, e2), dot(V, e1));
  const half = (t0) => {
    const top = arc(O, e1, e2, n, r, BW / 2, t0, t0 + Math.PI, 24), bot = arc(O, e1, e2, n, r, -BW / 2, t0, t0 + Math.PI, 24);
    return poly(top.concat(bot.reverse()).map((p) => P(...p)));
  };
  return { far: half(a + Math.PI / 2), near: half(a - Math.PI / 2) };
}

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let swing = value;

  const C = Cam(45, 0.5, 1.82);
  fit(C, [[-40, -40, -6], [40, 40, -6], [40, -40, -6], [-40, 40, -6], [0, 0, ZC + R0 + 3], [0, -R0, ZC], [0, R0, ZC]], 200, 160);
  const P = proj(C), front = facing(C);

  const g = mk("g", {}, svg);
  const [br, bi] = rings(-40, -40, 40, 40, 14, 2.2);
  put(solid(g), prism(P, front, br, bi, -6, 0));
  put(solid(g), prism(P, front, circ(5, 24), circ(3.8, 24), 0, ZC - R0));

  // back to front: hoop halves far, rotor, hoop halves near
  const L = ["far0", "far1", "far2", "rotor", "near2", "near1", "near0"];
  const el = {};
  for (const k of L) el[k] = k === "rotor" ? solid(g) : mk("path", { class: k.endsWith("0") ? "sil" : "" }, g);
  const hub = mk("path", { class: "nf" }, el.rotor.g), pins = [0, 1, 2, 3].map(() => mk("circle", { r: 1.6, class: "dot m" }, g));
  el.rotor.sil.classList.add("hi");
  el.rotor.cr.classList.add("nf");

  // outer hoop: fixed, upright, its plane across the x axis
  const outer = hoop(P, [1, 0, 0], [0, 0, 1], R0);
  el.far0.setAttribute("d", outer.far);
  el.near0.setAttribute("d", outer.near);

  const yaw = spring(YAW0), pitch = spring(PITCH0, { k: 46, c: 11 });
  let drawn = "";

  function draw() {
    const key = yaw.x.toFixed(2) + "," + pitch.x.toFixed(2);
    if (key === drawn) return;
    drawn = key;
    const f = rad(yaw.x), t = rad(pitch.x), z = [0, 0, 1];
    const n1 = [Math.cos(f), Math.sin(f), 0], ax = [-Math.sin(f), Math.cos(f), 0];
    const n2 = comb([n1, Math.cos(t)], [z, Math.sin(t)]);
    const h1 = hoop(P, n1, z, R1), h2 = hoop(P, n2, ax, R2);
    el.far1.setAttribute("d", h1.far); el.near1.setAttribute("d", h1.near);
    el.far2.setAttribute("d", h2.far); el.near2.setAttribute("d", h2.near);
    // the rotor spins about the inner gimbal's normal: a thick disc facing where it looks
    const e2 = cross(n2, ax), face = (w, r) => arc(O, ax, e2, n2, r, w, 0, 2 * Math.PI, 48).map((p) => P(...p));
    const lit = dot(V, n2) >= 0 ? RT / 2 : -RT / 2;
    el.rotor.sil.setAttribute("d", poly(hull(face(RT / 2, RR).concat(face(-RT / 2, RR)))));
    el.rotor.cr.setAttribute("d", poly(face(lit, RR - 1.6)));
    hub.setAttribute("d", poly(face(lit, 4.5)));
    // the pivots: outer to middle on the upright, middle to inner across
    [[0, 0, ZC + R1], [0, 0, ZC - R1], comb([O, 1], [ax, R1]), comb([O, 1], [ax, -R1])].forEach((p, i) => {
      place(pins[i], P(...p));
    });
  }

  const B = register(stage, (dt) => {
    const m = stepS(yaw, dt) | stepS(pitch, dt);
    draw();
    return !!m;
  });
  bag.add(B.unregister);

  const centre = P(...O);
  function aim(p) {
    if (!p) { yaw.t = YAW0; pitch.t = PITCH0; read.textContent = "rest"; return B.wake(); }
    const dx = clamp((p[0] - centre[0]) / 150, -1, 1), dy = clamp((centre[1] - p[1]) / 120, -1, 1);
    yaw.t = YAW0 - dx * swing; pitch.t = dy * swing;
    read.textContent = `${Math.round(yaw.t - YAW0)}° · ${Math.round(pitch.t)}°`;
    B.wake();
  }
  draw();

  bag.add(pointer(stage, { move: aim, leave: () => aim(null) }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { swing = v; },
    destroy: bag.dispose,
  };
}

hairline({
  name: "gyroscope",
  means: "A rotor in two gimbals turns to look at the pointer; the inner gimbal follows the outer one late, on a softer spring.",
  rules: [3, 5, 6, 8],
  range: [20, 40, 60],
  mount,
});
