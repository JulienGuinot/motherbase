/**
 * Rack: the VPS as a server rack on a plinth, four units stacked under a cap,
 * one per project. The active unit slides out on its rails toward the viewer
 * and lights; the others stay seated. The value picks the unit from the top
 * (0 is the top one, -1 none), so the page can drive it from a list; the
 * pointer's height picks one too, and leaving hands it back to the value.
 *
 * A unit only ever slides along +x, away from the ones above it, so drawing
 * bottom to top stays correct at every pose.
 */
const { Cam, fit, proj, facing, rings, prism, put, solid, mk, place, seg, tween, tset, tval, tdone, register, pointer, disposer } = HL;

const N = 4, X0 = -36, X1 = 36, Y0 = -56, Y1 = 56, T = 14, GAP = 5, SLIDE = 30, PB = 6, M = 8, CAP = 6;
const TOP = N * (T + GAP) - GAP;
/** The base height of project p's unit: project 0 sits on top. */
const zOf = (p) => (N - 1 - p) * (T + GAP);

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let want = Math.round(value), hover = -1, act = null;

  const C = Cam(45, 0.5, 1.6);
  fit(C, [[X0 - M, Y0 - M, -PB], [X1 + M, Y1 + M, -PB], [X1 + M, Y0 - M, -PB], [X0 - M, Y1 + M, -PB], [X1 + SLIDE, Y1, 0], [X1 + SLIDE, Y0, 0], [X0, Y0, TOP + GAP + CAP], [X1, Y1, TOP + GAP + CAP]], 200, 160);
  const P = proj(C), front = facing(C);

  const g = mk("g", {}, svg);
  const [pr, pi] = rings(X0 - M, Y0 - M, X1 + M, Y1 + M, 10, 2.2);
  put(solid(g), prism(P, front, pr, pi, -PB, 0));

  // bottom to top: the last project is the lowest unit
  const units = [];
  for (let p = N - 1; p >= 0; p--) {
    const el = solid(g), vent = mk("path", { class: "nf lo" }, el.g), led = mk("circle", { r: 2.2, class: "dot m" }, el.g);
    units[p] = { el, vent, led, out: tween(0), drawn: "" };
  }
  const [cr, ci] = rings(X0, Y0, X1, Y1, 6, 1.8);
  put(solid(g), prism(P, front, cr, ci, TOP + GAP, TOP + GAP + CAP));

  function draw(p, out) {
    const u = units[p], key = out.toFixed(2);
    if (key === u.drawn) return;
    u.drawn = key;
    const a = zOf(p), zm = a + T / 2, xf = X1 + out;
    const [r, ri] = rings(X0 + out, Y0, xf, Y1, 5, 1.6);
    put(u.el, prism(P, front, r, ri, a, a + T));
    // two vent slots and a status light on the front face
    u.vent.setAttribute("d", seg(P(xf, Y0 + 30, zm - 2.5), P(xf, Y1 - 12, zm - 2.5)) + seg(P(xf, Y0 + 30, zm + 2.5), P(xf, Y1 - 12, zm + 2.5)));
    place(u.led, P(xf, Y0 + 15, zm));
  }

  const B = register(stage, (_dt, now) => {
    let moving = false;
    units.forEach((u, p) => {
      draw(p, tval(u.out, now));
      if (!tdone(u.out, now)) moving = true;
    });
    return moving;
  });
  bag.add(B.unregister);

  function setActive() {
    const a = hover >= 0 ? hover : want;
    if (a === act) return;
    act = a;
    const now = performance.now();
    units.forEach((u, p) => {
      tset(u.out, p === a ? SLIDE : 0, now, 0);
      u.el.sil.classList.toggle("hi", p === a);
      u.led.setAttribute("class", p === a ? "dot" : "dot m");
    });
    read.textContent = a < 0 ? "rest" : "project " + (a + 1);
    B.wake();
  }
  setActive();

  // the rest centres on screen never move, so a sliding unit cannot flip the pick
  const centre = units.map((_, p) => P(0, 0, zOf(p) + T / 2)), cx = centre[0][0];
  const reach = (X1 - X0 + Y1 - Y0) * C.S * 0.4;
  function hit([x, y]) {
    if (Math.abs(x - cx) > reach || y < centre[0][1] - 50 || y > centre[N - 1][1] + 50) return -1;
    let best = 0;
    centre.forEach((c, p) => { if (Math.abs(c[1] - y) < Math.abs(centre[best][1] - y)) best = p; });
    return best;
  }

  bag.add(pointer(stage, {
    move: (pt) => { hover = hit(pt); setActive(); },
    leave: () => { hover = -1; setActive(); },
  }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { want = Math.round(v); setActive(); },
    destroy: bag.dispose,
  };
}

hairline({
  name: "rack",
  means: "A server rack with one unit per project: the picked unit slides out on its rails and lights.",
  rules: [1, 2, 5],
  range: [-1, 1, 3],
  mount,
});
