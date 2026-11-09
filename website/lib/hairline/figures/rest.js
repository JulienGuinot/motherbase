/**
 * Rest: a pneumatic tube, the REST round trip. A glass tube runs from a
 * station on the left, up and over, down into a cabinet of four drawers, one
 * drawer a row. At rest a capsule waits in the station and one drawer stands
 * ajar. The drawer under the pointer is requested: the capsule rides the tube
 * to the cabinet, the drawer slides out, and the capsule rides back. The
 * slider is the capsule's trip, in ms.
 *
 * Picking reads the drawers' resting fronts on the cabinet face, which never
 * move (rule 01).
 */
const {
  Cam, circ, clamp, facing, fit, open, poly, prism, proj, put, rings, rrect,
  tdone, tset, tval, tween, disposer, mk, place, pointer, register, solid,
} = HL;

// cabinet, station, tube (world units; +x down-right, +y down-left, z up)
const CX0 = 40, CX1 = 80, CY = 26, CH = 100, FY = 23;
const SX0 = -78, SX1 = -34, SY = 20, SH = 34;
const TR = 5, CR = 7.5, TZ = 132, BEND = 14, TX0 = -56, TX1 = 60;
const N = 4, OPEN = 26, AJAR = [0, 0, 7, 0];
const ZT = Array.from({ length: N }, (_, k) => CH - 6 - k * 23), ZB = ZT.map((z) => z - 19);

/** The tube's centreline in the x–z plane (y = 0): up from the station, over, down into the cabinet, with rounded bends. */
function centreline() {
  const pts = [[TX0, SH + 4]];
  const arc = (cx, cz, a0, a1) => { for (let i = 1; i <= 8; i++) { const a = a0 + ((a1 - a0) * i) / 8; pts.push([cx + BEND * Math.cos(a), cz + BEND * Math.sin(a)]); } };
  pts.push([TX0, TZ - BEND]);
  arc(TX0 + BEND, TZ - BEND, Math.PI, Math.PI / 2);
  pts.push([TX1 - BEND, TZ]);
  arc(TX1 - BEND, TZ - BEND, Math.PI / 2, 0);
  pts.push([TX1, CH + 4]);
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, len };
}

/** A ring moved to (cx, cy) on the ground. */
const at = (ring, cx, cy) => ring.map((q) => ({ ...q, u: q.u + cx, v: q.v + cy }));

function mount({ stage, svg, read }, value) {
  const bag = disposer();

  const C = Cam(45, 0.5, 1.34);
  fit(C, [[SX0, -SY, 0], [SX0, SY, 0], [CX1 + OPEN, CY, 0], [CX1 + OPEN, -CY, 0], [TX0, 0, TZ + TR], [TX1, 0, TZ + TR], [CX0, -CY, CH]], 200, 166);
  const P = proj(C), front = facing(C);
  const g = mk("g", {}, svg);

  // the station: a receiver with a landing slot on its face, and a collar where the tube leaves
  const [sr, si] = rings(SX0, -SY, SX1, SY, 5, 1.6);
  put(solid(g), prism(P, front, sr, si, 0, SH));
  mk("path", { d: poly(rrect(-12, 7, 12, 17, 3, 4).map((q) => P(SX1, q.u, q.v))), class: "nf" }, g);
  mk("path", { d: poly(rrect(-9, 9.5, 9, 14.5, 1.5, 4).map((q) => P(SX1, q.u, q.v))), class: "nf lo" }, g);
  const collar = circ(CR, 10), collarIn = circ(CR - 1.4, 10);
  put(solid(g), prism(P, front, at(collar, TX0, 0), at(collarIn, TX0, 0), SH, SH + 4));

  // the cabinet: its body, a collar on top, and four drawers painted bottom to top so an open one covers the one under it
  const [cr, ci] = rings(CX0, -CY, CX1, CY, 4, 1.6);
  put(solid(g), prism(P, front, cr, ci, 0, CH));
  put(solid(g), prism(P, front, at(collar, TX1, 0), at(collarIn, TX1, 0), CH, CH + 4));
  const drawers = [];
  for (let k = N - 1; k >= 0; k--) {
    const grp = mk("g", {}, g), body = solid(grp);
    const face = mk("path", { class: "sil" }, grp), pull = mk("path", { class: "nf" }, grp);
    drawers[k] = { body, face, pull, d: tween(AJAR[k]), last: null };
  }

  // the glass tube, last: two walls and no fill, so the capsule shows inside it
  const { pts, len } = centreline(), total = len[len.length - 1];
  const wall = (side) => pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const tx = b[0] - a[0], tz = b[1] - a[1], m = Math.hypot(tx, tz);
    return P(p[0] - (tz / m) * TR * side, 0, p[1] + (tx / m) * TR * side);
  });
  mk("path", { d: open(wall(1)) + open(wall(-1)), class: "nf" }, g);
  const capsule = mk("circle", { r: 3.4, class: "dot" }, g);

  /** The capsule's place at s, 0 the station and 1 the cabinet, along the centreline. */
  function along(s) {
    const t = clamp(s, 0, 1) * total;
    let i = 1;
    while (i < len.length - 1 && len[i] < t) i++;
    const f = (t - len[i - 1]) / (len[i] - len[i - 1] || 1), a = pts[i - 1], b = pts[i];
    return P(a[0] + (b[0] - a[0]) * f, 0, a[1] + (b[1] - a[1]) * f);
  }

  function drawDrawer(k, d) {
    const dr = drawers[k];
    if (dr.last === d) return;
    dr.last = d;
    const x = CX1 + d;
    if (d > 1.5) {
      const [br, bi] = rings(CX1, -FY, x, FY, 2, 1);
      put(dr.body, prism(P, front, br, bi, ZB[k], ZT[k]));
    } else put(dr.body, { sil: "", crease: "" });
    dr.face.setAttribute("d", poly(rrect(-FY, ZB[k], FY, ZT[k], 2, 4).map((q) => P(x, q.u, q.v))));
    const zm = (ZB[k] + ZT[k]) / 2;
    dr.pull.setAttribute("d", poly(rrect(-7, zm - 1.8, 7, zm + 1.8, 1.8, 4).map((q) => P(x, q.u, q.v))));
  }

  let trip = value, cap = tween(0, trip), capTo = 0, act = -1;
  const send = (to, now, delay = 0) => { capTo = to; tset(cap, to, now, delay); };

  const B = register(stage, (_dt, now) => {
    let moving = false;
    drawers.forEach((dr, k) => { drawDrawer(k, tval(dr.d, now)); if (!tdone(dr.d, now)) moving = true; });
    place(capsule, along(tval(cap, now)));
    // the capsule reached the cabinet: open the row it asked for, then ride home
    if (capTo === 1 && tval(cap, now) > 0.995) {
      if (act >= 0) tset(drawers[act].d, OPEN, now, 0);
      send(0, now, 220);
    }
    return moving || !tdone(cap, now);
  });
  bag.add(B.unregister);

  // hit: the pointer on the cabinet's resting front face, solved for (y, z) on the plane x = CX1
  const o = P(CX1, 0, 0), ey = P(CX1, 1, 0), ez = P(CX1, 0, 1);
  const a1 = [ey[0] - o[0], ey[1] - o[1]], a2 = [ez[0] - o[0], ez[1] - o[1]], det = a1[0] * a2[1] - a1[1] * a2[0];
  function hit([sx, sy]) {
    const qx = sx - o[0], qy = sy - o[1];
    const y = (qx * a2[1] - qy * a2[0]) / det, z = (a1[0] * qy - a1[1] * qx) / det;
    if (Math.abs(y) > CY + 6) return -1;
    for (let k = 0; k < N; k++) if (z >= ZB[k] - 2 && z <= ZT[k] + 2) return k;
    return -1;
  }

  function setActive(a) {
    if (a === act) return;
    const now = performance.now();
    act = a;
    drawers.forEach((dr, k) => {
      tset(dr.d, a < 0 ? AJAR[k] : 0, now, Math.abs(k - Math.max(a, 0)) * 40);
      dr.face.classList.toggle("hi", k === a);
    });
    capsule.setAttribute("class", a < 0 ? "dot" : "dot m");
    send(a < 0 ? 0 : 1, now);
    read.textContent = a < 0 ? "rest" : `row ${a + 1}`;
    B.wake();
  }

  bag.add(pointer(stage, { move: (p) => setActive(hit(p)), leave: () => setActive(-1) }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { trip = v; const now = performance.now(), s = tval(cap, now); cap = tween(s, trip); tset(cap, capTo, now, 0); B.wake(); },
    destroy: bag.dispose,
  };
}

hairline({
  name: "rest",
  means: "A pneumatic tube to a cabinet of rows: the drawer under the pointer is requested, and the capsule rides out and back.",
  rules: [1, 4, 5, 8],
  range: [1100, 700, 420],
  mount,
});
