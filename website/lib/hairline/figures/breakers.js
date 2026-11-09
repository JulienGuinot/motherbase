/**
 * Breakers: a panel of eight breakers laid on its back, one per thing that
 * hurt. Each is a long body with a raised hump and a toggle on it. At rest
 * every toggle leans tripped or off, none quite as far as its neighbour. The picked breaker's lever is thrown home and lights, and the ones
 * beside it shiver, less the farther away. The value picks the breaker (0 is
 * the far one, -1 none), so the page can drive it from a list; the pointer
 * picks one too, and leaving hands it back to the value.
 *
 * Breakers stand in a row along +x and their toggles only lean along y, over
 * their own humps, so drawing them by ascending x stays correct at every pose.
 */
const { Cam, fit, proj, facing, rings, rrect, ringAt, run, hull, prism, put, solid, mk, place, poly, open, flatDot, tween, tset, tval, tdone, register, pointer, disposer } = HL;

const N = 8, W = 13, G = 1.6, Y0 = -30, Y1 = 30, H = 11, HY = 15, H2 = 19, LH = 12, LW = 2.2, TILT = 10, PB = 5, M = 9;
const X0 = -(N * W + (N - 1) * G) / 2, X1 = -X0;
const NAMES = ["projects", "upgrades", "mfa · sso", "studio", "services", "secrets", "custody", "rls"];
// tripped or off, never in a straight line: each toggle's lean at rest, in units of TILT
const REST = [0.9, 0.25, 0.65, 1, 0.4, 0.8, 0.15, 0.55];
const ON = -1, SHIVER = 0.45;
const xOf = (i) => X0 + i * (W + G) + W / 2;

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let want = Math.round(value), hover = -1, act = null;

  const C = Cam(45, 0.5, 2.35);
  fit(C, [[X0 - M, Y0 - M, -PB], [X1 + M, Y1 + M, -PB], [X1 + M, Y0 - M, -PB], [X0 - M, Y1 + M, -PB], [X0, Y0, H2 + LH], [X1, Y1, H2 + LH]], 200, 168);
  const P = proj(C), front = facing(C);

  const g = mk("g", {}, svg);
  const [pr, pi] = rings(X0 - M, Y0 - M, X1 + M, Y1 + M, 8, 2);
  put(solid(g), prism(P, front, pr, pi, -PB, 0));
  // the supply light, on the plate's near end: bright until a breaker is picked
  const supply = flatDot(g, C, 2.4, "dot");
  place(supply, P(X1 + M / 2, Y1 - 4, 0));

  const units = [];
  for (let i = 0; i < N; i++) {
    const x = xOf(i), body = solid(g);
    const [br, bi] = rings(x - W / 2, Y0, x + W / 2, Y1, 2.6, 1.4);
    put(body, prism(P, front, br, bi, 0, H));
    const [hr, hi] = rings(x - W / 2, -HY, x + W / 2, HY, 2.4, 1.3);
    put(solid(body.g), prism(P, front, hr, hi, H, H2));
    // the slot the toggle leans in, and the lamp on the near shoulder
    mk("path", { class: "nf lo", d: poly(ringAt(P, rrect(x - LW - 1, -TILT + 1, x + LW + 1, TILT - 1, 2, 4), H2)) }, body.g);
    const lamp = mk("circle", { r: 1.9, class: "dot off" }, body.g);
    place(lamp, P(x, (HY + Y1) / 2, H));
    const lever = solid(body.g);
    units.push({ x, lever, lamp, pos: tween(REST[i]), drawn: "" });
  }

  function draw(u, pos) {
    const key = pos.toFixed(3);
    if (key === u.drawn) return;
    u.drawn = key;
    // a toggle leaning from its pivot: foot in the slot, top swung along y
    const t = pos * TILT, foot = rrect(u.x - LW, -2.6, u.x + LW, 2.6, 1.2, 4);
    const top = rrect(u.x - LW, t - 2, u.x + LW, t + 2, 1.2, 4), inner = rrect(u.x - LW + 0.7, t - 1.3, u.x + LW - 0.7, t + 1.3, 0.6, 4);
    put(u.lever, { sil: poly(hull(ringAt(P, foot, H2).concat(ringAt(P, top, H2 + LH)))), crease: open(ringAt(P, run(inner, front), H2 + LH)) });
  }

  const B = register(stage, (_dt, now) => {
    let moving = false;
    for (const u of units) {
      draw(u, tval(u.pos, now));
      if (!tdone(u.pos, now)) moving = true;
    }
    return moving;
  });
  bag.add(B.unregister);

  function setActive() {
    const a = hover >= 0 ? hover : want;
    if (a === act) return;
    act = a;
    const now = performance.now();
    units.forEach((u, i) => {
      const d = Math.abs(i - a);
      // neighbours lean toward home a little, and less the farther away; the far ones stay put
      const shiver = a < 0 || d > 2 ? 0 : SHIVER / (d * d + 1);
      tset(u.pos, i === a ? ON : REST[i] - shiver, now, a < 0 ? 0 : d * 40);
      u.lever.sil.classList.toggle("hi", i === a);
      u.lamp.setAttribute("class", i === a ? "dot" : "dot off");
    });
    supply.setAttribute("class", a < 0 ? "dot" : "dot m");
    read.textContent = a < 0 ? "rest" : NAMES[a];
    B.wake();
  }
  setActive();

  // pick by the rest centres of the bodies, which never move
  const centre = units.map((u) => P(u.x, 0, H / 2));
  const top = P(X0, Y0, H2 + LH)[1] - 20, bottom = P(X1, Y1, 0)[1] + 20;
  const left = P(X0 - M, Y1 + M, 0)[0], right = P(X1 + M, Y0 - M, 0)[0];
  function hit([x, y]) {
    if (x < left || x > right || y < top || y > bottom) return -1;
    let best = 0;
    centre.forEach((c, i) => { if (Math.abs(c[0] - x) < Math.abs(centre[best][0] - x)) best = i; });
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
  name: "breakers",
  means: "A panel of eight tripped breakers: the one picked is thrown back on and lights, and its neighbours shiver after it.",
  rules: [1, 2, 5],
  range: [-1, -1, 7],
  mount,
});
