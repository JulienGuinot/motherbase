/**
 * Gateway: a 1U patch panel seen nearly head on, twenty-four ports in two
 * rows with a status light over each, and screw holes in its ears. One port
 * is lit at a time: the value picks it (-1 none), so the page can light the
 * port a request goes through; the pointer lights the port under it, and
 * leaving hands it back to the value.
 *
 * Nothing moves, so there is no frame loop: lighting a port is a class change.
 */
const { Cam, fit, proj, facing, rings, prism, put, solid, mk, poly, place, circ, disposer, pointer } = HL;

const COLS = 12, ROWS = 2, L = 120, D = 14, H = 34, IN = 100, PW = 10, PH = 7;
const ROW_Z = [23, 10];
const colX = (c) => -IN + (2 * IN * (c + 0.5)) / COLS;

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let want = Math.round(value), hover = -1, act = null;

  const C = Cam(16, 0.42, 1.3);
  fit(C, [[-L, -D, 0], [L, D, 0], [L, -D, 0], [-L, D, 0], [-L, -D, H], [L, D, H]], 200, 160);
  const P = proj(C), front = facing(C);
  // a rectangle on the front face, centred on (x, z)
  const onFace = (x, z, w, h) => poly([P(x - w / 2, D, z - h / 2), P(x + w / 2, D, z - h / 2), P(x + w / 2, D, z + h / 2), P(x - w / 2, D, z + h / 2)]);

  const g = mk("g", {}, svg);
  const [br, bi] = rings(-L, -D, L, D, 3, 1.2);
  put(solid(g), prism(P, front, br, bi, 0, H));

  // ears: two screw holes each end, and the line where the ear meets the body
  for (const x of [-L + 8, L - 8]) for (const z of [9, 25]) {
    mk("path", { class: "nf lo", d: poly(circ(2.2, 16).map((q) => P(x + q.u, D, z + q.v))) }, g);
  }
  for (const x of [-IN - 6, IN + 6]) mk("path", { class: "nf lo", d: poly([P(x, D, 3), P(x, D, H - 3)]) }, g);

  const ports = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const x = colX(c), z = ROW_Z[r];
    const jack = mk("path", { class: "nf", d: onFace(x, z, PW, PH) }, g);
    const pin = mk("path", { class: "nf lo", d: onFace(x, z - 0.6, PW * 0.5, PH * 0.38) }, g);
    const led = mk("circle", { r: 1.3, class: "dot off" }, g);
    place(led, P(x + PW / 2 - 1.5, D, z + PH / 2 + 2.6));
    ports.push({ jack, pin, led, at: P(x, D, z) });
  }

  function light() {
    const a = hover >= 0 ? hover : want;
    if (a === act) return;
    act = a;
    ports.forEach((p, i) => {
      p.jack.setAttribute("class", i === a ? "nf hi" : "nf");
      p.pin.setAttribute("class", i === a ? "nf hi" : "nf lo");
      p.led.setAttribute("class", i === a ? "dot" : "dot off");
    });
    read.textContent = a < 0 ? "rest" : "port " + (a + 1);
  }
  light();

  const reach = PW * C.S * 1.2;
  function hit([x, y]) {
    let best = -1, d = reach;
    ports.forEach((p, i) => { const e = Math.hypot(p.at[0] - x, p.at[1] - y); if (e < d) { d = e; best = i; } });
    return best;
  }

  bag.add(pointer(stage, {
    move: (pt) => { hover = hit(pt); light(); },
    leave: () => { hover = -1; light(); },
  }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { want = Math.round(v); light(); },
    destroy: bag.dispose,
  };
}

hairline({
  name: "gateway",
  means: "A patch panel of twenty-four ports: the port a request is routed through lights, with its status light.",
  rules: [1, 5],
  range: [-1, 0, 23],
  mount,
});
