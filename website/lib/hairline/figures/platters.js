/**
 * Platters: a stack of five database platters on a plinth, each a thick disc
 * with a track and a hub on its top face. At rest the middle one sits half
 * out. The pointer's height picks a platter: it slides out toward the viewer,
 * and the stack above it lifts to let it go, staggered outwards from it. The
 * slider is the gap the stack opens, in world units.
 *
 * Picking reads the rest centres of the platters, which never move (rule 01).
 */
const {
  Cam, circ, facing, fit, poly, prism, proj, put, rings, ringAt,
  tdone, tset, tval, tween, disposer, mk, pointer, register, solid,
} = HL;

const N = 5, R = 44, T = 9, PITCH = 13, SLIDE = 36, REST_A = 2, REST_OUT = 14, PL = R + 10, PB = 6;

/** A ring of samples moved dx along x. */
const shift = (ring, dx) => ring.map((q) => ({ ...q, u: q.u + dx }));

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let gap = value;

  const C = Cam(45, 0.5, 1.78);
  fit(C, [[-PL, -PL, -PB], [PL, PL, -PB], [PL, -PL, -PB], [-PL, PL, -PB], [SLIDE + R, R, 0], [SLIDE + R, -R, 0], [0, 0, N * PITCH + 14]], 200, 166);
  const P = proj(C), front = facing(C);

  const outer = circ(R, 72), inner = circ(R - 1.8, 72), track = circ(R * 0.62, 56), hub = circ(R * 0.16, 28);
  const g = mk("g", {}, svg);
  const [pr, pi] = rings(-PL, -PL, PL, PL, 12, 2.2);
  put(solid(g), prism(P, front, pr, pi, -PB, 0));

  // bottom to top: a platter higher up covers the ones under it
  const plates = [];
  for (let i = 0; i < N; i++) {
    const el = solid(g), tr = mk("path", { class: "nf lo" }, el.g), hb = mk("path", { class: "nf" }, el.g);
    const out0 = i === REST_A ? REST_OUT : 0;
    plates.push({ el, tr, hb, out: tween(out0), lift: tween(0), out0, drawn: "" });
  }

  function draw(i, out, lift) {
    const pl = plates[i], key = out.toFixed(2) + "," + lift.toFixed(2);
    if (key === pl.drawn) return;
    pl.drawn = key;
    const z0 = i * PITCH + lift, z1 = z0 + T;
    put(pl.el, prism(P, front, shift(outer, out), shift(inner, out), z0, z1));
    pl.tr.setAttribute("d", poly(ringAt(P, shift(track, out), z1)));
    pl.hb.setAttribute("d", poly(ringAt(P, shift(hub, out), z1)));
  }

  const B = register(stage, (_dt, now) => {
    let moving = false;
    plates.forEach((pl, i) => {
      draw(i, tval(pl.out, now), tval(pl.lift, now));
      if (!tdone(pl.out, now) || !tdone(pl.lift, now)) moving = true;
    });
    return moving;
  });
  bag.add(B.unregister);

  // the rest centres on screen: fixed, so a platter sliding away cannot flip the pick
  const centre = plates.map((_, i) => P(0, 0, i * PITCH + T / 2));
  const top = P(0, 0, N * PITCH)[1] - R * C.S * 0.5, bottom = P(0, 0, 0)[1] + R * C.S * 0.5;
  function hit([x, y]) {
    if (Math.abs(x - centre[0][0]) > R * C.S * 1.1 || y < top || y > bottom) return -1;
    let best = 0;
    centre.forEach((c, i) => { if (Math.abs(c[1] - y) < Math.abs(centre[best][1] - y)) best = i; });
    return best;
  }

  let act = -1;
  function setActive(a, force) {
    if (a === act && !force) return;
    const now = performance.now(), from = a >= 0 ? a : act >= 0 ? act : REST_A;
    act = a;
    plates.forEach((pl, i) => {
      const delay = Math.abs(i - from) * 45;
      tset(pl.out, a < 0 ? pl.out0 : i === a ? SLIDE : 0, now, delay);
      tset(pl.lift, a < 0 ? 0 : i > a ? gap : i === a ? gap / 2 : 0, now, delay);
      pl.el.sil.classList.toggle("hi", a < 0 ? i === REST_A : i === a);
    });
    read.textContent = a < 0 ? "rest" : "table " + (a + 1);
    B.wake();
  }
  setActive(-1, true);

  bag.add(pointer(stage, { move: (p) => setActive(hit(p)), leave: () => setActive(-1) }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { gap = v; setActive(act, true); },
    destroy: bag.dispose,
  };
}

hairline({
  name: "platters",
  means: "A stack of database platters: the one under the pointer slides out, and the stack above lifts to let it go.",
  rules: [1, 2, 5, 9],
  range: [4, 9, 14],
  mount,
});
