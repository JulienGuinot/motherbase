/**
 * Dominoes: a curved run of six dominoes on a plinth, the nearest one already
 * tipped, armed. The domino under the pointer fires: it and every one behind
 * it topple in turn, each onto the next, the last lying flat, staggered out
 * from the one fired. Each face carries its number in pips over a dividing
 * line. The slider is the stagger, in ms.
 *
 * Picking reads the rest centres of the dominoes, which never move (rule 01).
 */
const {
  Cam, clamp, facing, fit, hull, poly, prism, proj, put, rad, rings, rrect, seg,
  tdone, tset, tval, tween, disposer, mk, place, pointer, register, solid,
} = HL;

const N = 6, H = 46, W = 24, T = 7, G = 26, R = 3, B = 1.6;
const ARMED = 7, LEAN = Math.asin((G - T) / H) * 180 / Math.PI, FLAT = 90;
/** Domino i stands at x, y: 0 is the nearest, the run curls away from the viewer. */
const XS = Array.from({ length: N }, (_, i) => (N - 1 - i) * G);
const YS = Array.from({ length: N }, (_, i) => 5 * Math.sin(i * 0.95 + 0.3));
const PX0 = -H - 8, PX1 = XS[0] + T + 10, PY0 = -W / 2 - 12, PY1 = W / 2 + 12;
/** Pip positions on a half face, in (v, h) from its centre, for 1 to 6. */
const PIPS = [
  [[0, 0]],
  [[-5, 5], [5, -5]],
  [[-5, 5], [0, 0], [5, -5]],
  [[-5, 5], [5, 5], [-5, -5], [5, -5]],
  [[-5, 5], [5, 5], [0, 0], [-5, -5], [5, -5]],
  [[-5, 5], [5, 5], [-5, 0], [5, 0], [-5, -5], [5, -5]],
];

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let stag = value;

  const C = Cam(45, 0.5, 1.5);
  fit(C, [[PX0, PY0, -6], [PX1, PY1, -6], [PX1, PY0, 0], [PX0, PY1, 0], [XS[0], 0, H], [XS[N - 1], 0, H]], 200, 166);
  const P = proj(C);

  /** A point of domino i in its own frame (u through it, v across, h up), leaning phi degrees onto the next. */
  const at = (i, phi) => {
    const s = Math.sin(rad(phi)), c = Math.cos(rad(phi));
    return (u, v, h) => P(XS[i] + u * c - h * s, YS[i] + v, u * s + h * c);
  };
  const face = rrect(-W / 2, 0, W / 2, H, R, 4), inset = rrect(-W / 2 + B, B, W / 2 - B, H - B, R - B, 4);

  const g = mk("g", {}, svg);
  const [pr, pi] = rings(PX0, PY0, PX1, PY1, 6, 1.8);
  put(solid(g), prism(P, facing(C), pr, pi, -6, 0));

  // far to near: the highest index is the farthest
  const ds = [];
  for (let i = N - 1; i >= 0; i--) {
    const grp = mk("g", {}, g);
    const sil = mk("path", { class: "sil" }, grp), cr = mk("path", { class: "nf lo" }, grp), mid = mk("path", { class: "nf lo" }, grp);
    const pips = PIPS[i].map(() => mk("circle", { r: 1.4, class: "dot off" }, grp));
    ds[i] = { sil, pips, cr, mid, a: tween(i === 0 ? ARMED : 0), last: null };
  }

  function draw(i, phi) {
    const d = ds[i];
    if (d.last === phi) return;
    d.last = phi;
    const w = at(i, phi);
    d.sil.setAttribute("d", poly(hull(face.map((q) => w(0, q.u, q.v)).concat(face.map((q) => w(T, q.u, q.v))))));
    d.cr.setAttribute("d", poly(inset.map((q) => w(T, q.u, q.v))));
    d.mid.setAttribute("d", seg(w(T, -W / 2 + 4, H / 2), w(T, W / 2 - 4, H / 2)));
    PIPS[i].forEach(([v, h], k) => place(d.pips[k], w(T, v, H * 0.75 + h)));
  }

  const L = register(stage, (_dt, now) => {
    let moving = false;
    ds.forEach((d, i) => { draw(i, tval(d.a, now)); if (!tdone(d.a, now)) moving = true; });
    return moving;
  });
  bag.add(L.unregister);

  // hit: the rest centres, which never move
  const centres = XS.map((x, i) => P(x + T / 2, YS[i], H / 2));
  function hit([x, y]) {
    let best = -1, bd = 34;
    centres.forEach(([cx, cy], i) => { const dd = Math.hypot(x - cx, (y - cy) * 0.5); if (dd < bd) { bd = dd; best = i; } });
    return best;
  }

  let act = -2;
  /** Fires domino a: it and every one behind it topple (-1 stands them all back up). */
  function setActive(a) {
    if (a === act) return;
    const now = performance.now(), from = a >= 0 ? a : act;
    act = a;
    ds.forEach((d, i) => {
      const phi = a < 0 || i < a ? (i === 0 ? ARMED : 0) : i === N - 1 ? FLAT : LEAN;
      tset(d.a, phi, now, Math.abs(i - from) * stag);
      const on = a < 0 ? i === 0 : i === a;
      d.sil.classList.toggle("hi", on);
      d.pips.forEach((p) => p.classList.toggle("m", on));
    });
    read.textContent = a < 0 ? "rest" : String(a + 1).padStart(2, "0");
    L.wake();
  }

  setActive(-1);
  bag.add(pointer(stage, { move: (p) => setActive(hit(p)), leave: () => setActive(-1) }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { stag = clamp(v, 0, 200); },
    destroy: bag.dispose,
  };
}

hairline({
  name: "dominoes",
  means: "A run of six dominoes: the one under the pointer fires, and every one behind it topples in turn.",
  rules: [1, 2, 5, 10],
  range: [30, 60, 110],
  mount,
});
