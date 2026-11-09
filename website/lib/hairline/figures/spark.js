/**
 * Spark: the four-pointed spark that has come to mean "AI", built as a thick
 * solid standing over a round plinth, with two small sparks beside it. The
 * pointer is where it should look: the big spark turns about the upright and
 * tips toward it, and the small ones follow on a softer spring, so they
 * arrive late. At rest it stands three-quarters on. The slider is how far it
 * may turn, in degrees.
 *
 * A spark is concave, so its solid is not a hull: the back face, then the
 * band between the faces as one fill, then the front face over it.
 */
const { Cam, circ, clamp, facing, fillet, fit, flatDot, poly, prism, proj, put, rad, rings, seg, spring, stepS, disposer, mk, place, pointer, register, solid } = HL;

const ZC = 84, R = 58, ASP = 0.8, W = 12, EXP = 3.4, M = 48, YAW0 = 20, PITCH0 = -8, PL = 36;
const V = [Math.SQRT1_2 * Math.sqrt(0.75), Math.SQRT1_2 * Math.sqrt(0.75), 0.5]; // toward the camera at Cam(45, 0.5)
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The spark's outline in its own plane, [across, up]: four tips joined by inward curves, tips rounded. */
function outline(r, w) {
  const pts = [];
  for (let k = 0; k < M; k++) {
    const t = (k / M) * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
    pts.push([r * ASP * Math.sign(c) * Math.abs(c) ** EXP, r * Math.sign(s) * Math.abs(s) ** EXP]);
  }
  return fillet(pts, pts.map((_, k) => (k % (M / 4) === 0 ? w * 0.5 : 0)), 3);
}

/** One spark: a group of back face, band, front face and crease, and how to draw it at a yaw and pitch. */
function spark(parent, P, at, r, w, bright) {
  const g = mk("g", {}, parent);
  const back = mk("path", { class: "sil" }, g), band = mk("path", { class: "fo" }, g);
  const face = mk("path", { class: bright ? "hi" : "sil" }, g), crease = mk("path", { class: "nf lo" }, g);
  const out = outline(r, w), inner = out.map(([a, b]) => [a * 0.82, b * 0.82]);
  let drawn = "";
  return (yaw, pitch) => {
    const key = yaw.toFixed(2) + "," + pitch.toFixed(2);
    if (key === drawn) return;
    drawn = key;
    const f = rad(yaw), t = rad(pitch);
    const e1 = [-Math.sin(f), Math.cos(f), 0], n = [Math.cos(f) * Math.cos(t), Math.sin(f) * Math.cos(t), Math.sin(t)];
    const e2 = cross(n, e1), s = dot(V, n) >= 0 ? 1 : -1;
    const ring = (pts, off) => pts.map(([a, b]) => P(at[0] + e1[0] * a + e2[0] * b + n[0] * off, at[1] + e1[1] * a + e2[1] * b + n[1] * off, at[2] + e1[2] * a + e2[2] * b + n[2] * off));
    const fr = ring(out, (s * w) / 2), bk = ring(out, (-s * w) / 2);
    back.setAttribute("d", poly(bk));
    band.setAttribute("d", fr.map((p, k) => { const q = (k + 1) % fr.length; return poly([bk[k], bk[q], fr[q], p]); }).join(""));
    face.setAttribute("d", poly(fr));
    crease.setAttribute("d", poly(ring(inner, (s * w) / 2)));
  };
}

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let swing = value;

  const C = Cam(45, 0.5, 1.5);
  fit(C, [[-PL, -PL, -7], [PL, PL, -7], [PL, -PL, -7], [-PL, PL, -7], [0, 0, ZC + R], [-30, 50, 138], [52, -30, 30], [0, -R, ZC], [0, R, ZC]], 200, 160);
  const P = proj(C), front = facing(C);

  const g = mk("g", {}, svg);
  put(solid(g), prism(P, front, circ(PL, 64), circ(PL - 2.2, 64), -7, 0));
  // where it would stand: a guide down to the plinth, and a mark on it
  mk("path", { class: "nf dash", d: seg(P(0, 0, 0), P(0, 0, ZC - R)) }, g);
  place(flatDot(g, C, 2.4, "dot m"), P(0, 0, 0));

  // back to front by x + y: the big spark, then the two small ones nearer the viewer
  const big = spark(g, P, [0, 0, ZC], R, W, true);
  const small = [spark(g, P, [-30, 50, 122], 16, 4, false), spark(g, P, [52, -30, 44], 12, 3.4, false)];

  const yaw = spring(YAW0), pitch = spring(PITCH0);
  const lag = [spring(YAW0 + 14, { k: 46, c: 11 }), spring(YAW0 - 10, { k: 46, c: 11 })];
  const B = register(stage, (dt) => {
    let m = stepS(yaw, dt) | stepS(pitch, dt);
    lag.forEach((l) => { m |= stepS(l, dt); });
    big(yaw.x, pitch.x);
    small[0](lag[0].x, pitch.x * 0.6);
    small[1](lag[1].x, -pitch.x * 0.6);
    return !!m;
  });
  bag.add(B.unregister);

  const centre = P(0, 0, ZC);
  function aim(p) {
    if (!p) {
      yaw.t = YAW0; pitch.t = PITCH0; lag[0].t = YAW0 + 14; lag[1].t = YAW0 - 10;
      read.textContent = "rest";
      return B.wake();
    }
    const dx = clamp((p[0] - centre[0]) / 150, -1, 1), dy = clamp((centre[1] - p[1]) / 120, -1, 1);
    yaw.t = YAW0 - dx * swing; pitch.t = dy * swing * 0.5;
    lag[0].t = yaw.t + 14; lag[1].t = yaw.t - 10;
    read.textContent = `${Math.round(yaw.t - YAW0)}° · ${Math.round(pitch.t)}°`;
    B.wake();
  }
  aim(null);

  bag.add(pointer(stage, { move: aim, leave: () => aim(null) }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { swing = v; },
    destroy: bag.dispose,
  };
}

hairline({
  name: "spark",
  means: "The four-pointed spark of AI, built as a solid: it turns to look at the pointer, and two small sparks follow it late.",
  rules: [5, 8, 9, 10],
  range: [25, 45, 65],
  mount,
});
