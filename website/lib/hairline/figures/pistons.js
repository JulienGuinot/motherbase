/**
 * Pistons: an inline block of six bores, a piston standing in each at its own
 * point of the cycle. The piston under the pointer fires to the top of its
 * stroke; its neighbours follow it up, less the farther away, staggered out
 * from it, and the rest sink to the bottom of theirs. Each crown has two ring
 * grooves under it. The slider is how far the firing reaches, in pistons.
 *
 * Picking reads the rest centres of the bores, which never move (rule 01).
 */
const {
  Cam, circ, facing, fit, open, poly, prism, proj, put, rings, ringAt, run,
  tdone, tset, tval, tween, disposer, mk, pointer, register, solid,
} = HL;

const N = 6, PR = 9.5, STEP = 27, BH = 26, FIRE = 46, LOW = 4, X0 = -6, X1 = (N - 1) * STEP + 34, Y0 = -19, Y1 = 19;
const xs = Array.from({ length: N }, (_, i) => 14 + i * STEP);
/** The rest: the crank caught mid-turn, every piston somewhere else on its stroke. */
const REST = xs.map((_, i) => 8 + 15 * (0.5 + 0.5 * Math.cos(i * 2.2 + 0.4)));
const RA = REST.indexOf(Math.max(...REST));

/** A ring of samples moved to (dx, 0). */
const at = (ring, dx) => ring.map((q) => ({ ...q, u: q.u + dx }));

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let reach = value;

  const C = Cam(45, 0.5, 1.95);
  fit(C, [[X0 - 4, Y0 - 4, -6], [X1 + 4, Y1 + 4, -6], [X1 + 4, Y0 - 4, -6], [X0 - 4, Y1 + 4, -6], [xs[0], 0, BH + FIRE], [xs[N - 1], 0, BH + FIRE]], 200, 170);
  const P = proj(C), front = facing(C);

  const g = mk("g", {}, svg);
  const [sr, si] = rings(X0 - 4, Y0 - 4, X1 + 4, Y1 + 4, 8, 2);
  put(solid(g), prism(P, front, sr, si, -6, 0));
  const [br, bi] = rings(X0, Y0, X1, Y1, 7, 2);
  put(solid(g), prism(P, front, br, bi, 0, BH));

  const ring = circ(PR, 40), crown = circ(PR - 1.4, 40), bore = circ(PR + 2.2, 40);
  // left to right along the row: each piston is nearer than the one before it
  const pis = xs.map((x, i) => {
    mk("path", { d: poly(ringAt(P, at(bore, x), BH)), class: "nf lo" }, g);
    const el = solid(g), grooves = mk("path", { class: "nf lo" }, el.g);
    return { x, el, grooves, h: tween(REST[i]), drawn: NaN };
  });

  function draw(p, h) {
    if (h === p.drawn) return;
    p.drawn = h;
    const z1 = BH + h, side = run(at(ring, p.x), front);
    put(p.el, prism(P, front, at(ring, p.x), at(crown, p.x), BH, z1));
    p.grooves.setAttribute("d", h > 8 ? open(ringAt(P, side, z1 - 3.2)) + open(ringAt(P, side, z1 - 5.8)) : "");
  }

  const B = register(stage, (_dt, now) => {
    let moving = false;
    for (const p of pis) { draw(p, tval(p.h, now)); if (!tdone(p.h, now)) moving = true; }
    return moving;
  });
  bag.add(B.unregister);

  // the bores' centres on screen, and the band the row stands in: fixed
  const cx = xs.map((x) => P(x, 0, BH)[0]);
  const top = P(xs[0], 0, BH + FIRE)[1] - 12, bottom = P(xs[N - 1], Y1, 0)[1];
  function hit([x, y]) {
    if (y < top || y > bottom || x < cx[0] - 22 || x > cx[N - 1] + 22) return -1;
    let best = 0;
    cx.forEach((c, i) => { if (Math.abs(c - x) < Math.abs(cx[best] - x)) best = i; });
    return best;
  }

  let act = -1;
  function setActive(a, force) {
    if (a === act && !force) return;
    const now = performance.now(), from = a >= 0 ? a : act >= 0 ? act : RA;
    act = a;
    pis.forEach((p, i) => {
      const d = Math.abs(i - from);
      const h = a < 0 ? REST[i] : d === 0 ? FIRE : Math.max(LOW, FIRE * 0.6 * Math.exp(-(d * d) / (reach * reach)));
      tset(p.h, h, now, d * 45);
      p.el.sil.classList.toggle("hi", a < 0 ? i === RA : i === a);
    });
    read.textContent = a < 0 ? "rest" : "fn " + (a + 1);
    B.wake();
  }
  setActive(-1, true);

  bag.add(pointer(stage, { move: (p) => setActive(hit(p)), leave: () => setActive(-1) }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { reach = v; if (act >= 0) setActive(act, true); },
    destroy: bag.dispose,
  };
}

hairline({
  name: "pistons",
  means: "An inline block of six pistons: the one under the pointer fires to the top, and its neighbours follow it, less the farther away.",
  rules: [1, 2, 3, 5],
  range: [0.5, 1.2, 2.4],
  mount,
});
