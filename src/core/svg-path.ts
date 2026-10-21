/**
 * svg-path.ts
 *
 * Parses SVG path data (`d="M3 3 L21 3 A2 2 0 0 1 21 21 Z"`) into absolute
 * moveto / lineto / cubic-curve / close segments, which map one-to-one onto PDF
 * path operators. Relative commands, shorthand curves (S, T), quadratics and
 * elliptical arcs are all converted. Pure and DOM-free.
 */

export type PathSegment =
  | { op: "M"; x: number; y: number }
  | { op: "L"; x: number; y: number }
  | {
      op: "C";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      x: number;
      y: number;
    }
  | { op: "Z" };

const ARITY: Record<string, number> = {
  m: 2,
  l: 2,
  h: 1,
  v: 1,
  c: 6,
  s: 4,
  q: 4,
  t: 2,
  a: 7,
  z: 0,
};

/** Reads the path into [command, numbers[]] groups, honouring implicit repeats and packed arc flags. */
function tokenize(d: string): { cmd: string; args: number[] }[] {
  const out: { cmd: string; args: number[] }[] = [];
  let i = 0;
  const n = d.length;
  const isSpace = (c: string) =>
    c === " " || c === "," || c === "\n" || c === "\t" || c === "\r";

  const readNumber = (): number | null => {
    while (i < n && isSpace(d[i]!)) i++;
    const m = /^[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/.exec(d.slice(i));
    if (!m) return null;
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const readFlag = (): number | null => {
    while (i < n && isSpace(d[i]!)) i++;
    const c = d[i];
    if (c !== "0" && c !== "1") return null;
    i++;
    return c === "1" ? 1 : 0;
  };

  let cmd = "";
  while (i < n) {
    while (i < n && isSpace(d[i]!)) i++;
    if (i >= n) break;
    const c = d[i]!;
    if (/[A-Za-z]/.test(c)) {
      cmd = c;
      i++;
      if (cmd === "z" || cmd === "Z") out.push({ cmd, args: [] });
      else if (!(cmd.toLowerCase() in ARITY))
        throw new Error(`unknown path command ${cmd}`);
      if (cmd === "z" || cmd === "Z") continue;
    } else if (!cmd) {
      throw new Error("path data must start with a command");
    }
    const lower = cmd.toLowerCase();
    const arity = ARITY[lower]!;
    if (arity === 0) continue;
    // Parse one full argument group for the current command (repeats are implicit).
    const args: number[] = [];
    for (let k = 0; k < arity; k++) {
      const v =
        lower === "a" && (k === 3 || k === 4) ? readFlag() : readNumber();
      if (v === null) {
        if (k === 0) return out; // trailing garbage or end
        throw new Error("incomplete path arguments");
      }
      args.push(v);
    }
    out.push({ cmd, args });
    // A moveto followed by more pairs means lineto.
    if (cmd === "M") cmd = "L";
    else if (cmd === "m") cmd = "l";
  }
  return out;
}

/** An elliptical arc as cubic Béziers (the standard endpoint-to-centre conversion). */
function arcToCubics(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  rotationDeg: number,
  largeArc: number,
  sweep: number,
  x2: number,
  y2: number,
): PathSegment[] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (!rx || !ry || (x1 === x2 && y1 === y2))
    return [{ op: "L", x: x2, y: y2 }];

  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  const sign = largeArc === sweep ? -1 : 1;
  const coef = den === 0 ? 0 : sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;

  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / count;
  const k = (4 / 3) * Math.tan(step / 4);
  const segments: PathSegment[] = [];
  let t = theta1;
  const point = (a: number) => ({
    x: cosPhi * rx * Math.cos(a) - sinPhi * ry * Math.sin(a) + cx,
    y: sinPhi * rx * Math.cos(a) + cosPhi * ry * Math.sin(a) + cy,
  });
  const deriv = (a: number) => ({
    x: -cosPhi * rx * Math.sin(a) - sinPhi * ry * Math.cos(a),
    y: -sinPhi * rx * Math.sin(a) + cosPhi * ry * Math.cos(a),
  });
  for (let i = 0; i < count; i++) {
    const p1 = point(t);
    const p2 = point(t + step);
    const d1 = deriv(t);
    const d2 = deriv(t + step);
    segments.push({
      op: "C",
      x1: p1.x + k * d1.x,
      y1: p1.y + k * d1.y,
      x2: p2.x - k * d2.x,
      y2: p2.y - k * d2.y,
      x: i === count - 1 ? x2 : p2.x,
      y: i === count - 1 ? y2 : p2.y,
    });
    t += step;
  }
  return segments;
}

/** Parses path data into absolute segments. Throws on malformed data (callers fall back to a raster). */
export function parseSvgPath(d: string): PathSegment[] {
  const segments: PathSegment[] = [];
  let cx = 0,
    cy = 0; // current point
  let sx = 0,
    sy = 0; // start of the subpath
  let lastCtrlX = 0,
    lastCtrlY = 0; // reflection source for S / T
  let prev = "";

  for (const { cmd, args } of tokenize(d)) {
    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toLowerCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;

    switch (c) {
      case "m": {
        cx = ox + args[0]!;
        cy = oy + args[1]!;
        sx = cx;
        sy = cy;
        segments.push({ op: "M", x: cx, y: cy });
        break;
      }
      case "l": {
        cx = ox + args[0]!;
        cy = oy + args[1]!;
        segments.push({ op: "L", x: cx, y: cy });
        break;
      }
      case "h": {
        cx = (rel ? cx : 0) + args[0]!;
        segments.push({ op: "L", x: cx, y: cy });
        break;
      }
      case "v": {
        cy = (rel ? cy : 0) + args[0]!;
        segments.push({ op: "L", x: cx, y: cy });
        break;
      }
      case "c": {
        const x1 = ox + args[0]!,
          y1 = oy + args[1]!,
          x2 = ox + args[2]!,
          y2 = oy + args[3]!,
          x = ox + args[4]!,
          y = oy + args[5]!;
        segments.push({ op: "C", x1, y1, x2, y2, x, y });
        lastCtrlX = x2;
        lastCtrlY = y2;
        cx = x;
        cy = y;
        break;
      }
      case "s": {
        const reflect = prev === "c" || prev === "s";
        const x1 = reflect ? 2 * cx - lastCtrlX : cx;
        const y1 = reflect ? 2 * cy - lastCtrlY : cy;
        const x2 = ox + args[0]!,
          y2 = oy + args[1]!,
          x = ox + args[2]!,
          y = oy + args[3]!;
        segments.push({ op: "C", x1, y1, x2, y2, x, y });
        lastCtrlX = x2;
        lastCtrlY = y2;
        cx = x;
        cy = y;
        break;
      }
      case "q":
      case "t": {
        let qx: number, qy: number, x: number, y: number;
        if (c === "q") {
          qx = ox + args[0]!;
          qy = oy + args[1]!;
          x = ox + args[2]!;
          y = oy + args[3]!;
        } else {
          const reflect = prev === "q" || prev === "t";
          qx = reflect ? 2 * cx - lastCtrlX : cx;
          qy = reflect ? 2 * cy - lastCtrlY : cy;
          x = ox + args[0]!;
          y = oy + args[1]!;
        }
        // Quadratic to cubic: control points two thirds of the way to the quadratic control.
        segments.push({
          op: "C",
          x1: cx + (2 / 3) * (qx - cx),
          y1: cy + (2 / 3) * (qy - cy),
          x2: x + (2 / 3) * (qx - x),
          y2: y + (2 / 3) * (qy - y),
          x,
          y,
        });
        lastCtrlX = qx;
        lastCtrlY = qy;
        cx = x;
        cy = y;
        break;
      }
      case "a": {
        const x = ox + args[5]!,
          y = oy + args[6]!;
        segments.push(
          ...arcToCubics(
            cx,
            cy,
            args[0]!,
            args[1]!,
            args[2]!,
            args[3]!,
            args[4]!,
            x,
            y,
          ),
        );
        cx = x;
        cy = y;
        break;
      }
      case "z": {
        segments.push({ op: "Z" });
        cx = sx;
        cy = sy;
        break;
      }
    }
    prev = c;
  }
  return segments;
}
