export type FruitId =
  | 'watermelon'
  | 'strawberry'
  | 'banana'
  | 'orange'
  | 'grapes'
  | 'tomato'
  | 'coconut'
  | 'pineapple'
  | 'bomb';

export interface FruitDef {
  id: FruitId;
  label: string;
  /** Radius as a fraction of viewport height, so fruit scales with the window. */
  size: number;
  points: number;
  /** Juice / particle colour. */
  juice: string;
  /** Secondary splatter colour. */
  juice2: string;
  /** Heavier fruit resists the cut, so its halves drift apart more slowly. */
  mass: number;
  draw: (ctx: CanvasRenderingContext2D, r: number) => void;
  /** Cross-section shown on a cut face. */
  flesh: (ctx: CanvasRenderingContext2D, r: number) => void;
}

const TAU = Math.PI * 2;

function radial(
  ctx: CanvasRenderingContext2D,
  r: number,
  stops: [number, string][],
  ox = -0.32,
  oy = -0.35,
) {
  const g = ctx.createRadialGradient(ox * r, oy * r, r * 0.06, 0, 0, r);
  for (const [t, c] of stops) g.addColorStop(t, c);
  return g;
}

function ball(ctx: CanvasRenderingContext2D, r: number, stops: [number, string][]) {
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fillStyle = radial(ctx, r, stops);
  ctx.fill();
}

/** Specular highlight, sold separately because every fruit wants one. */
function gloss(ctx: CanvasRenderingContext2D, r: number, alpha = 0.4) {
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.beginPath();
  ctx.ellipse(-r * 0.34, -r * 0.4, r * 0.26, r * 0.17, -0.6, 0, TAU);
  ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  ctx.fill();
  ctx.restore();
}

function stem(ctx: CanvasRenderingContext2D, r: number, color = '#4a7c26') {
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.92);
  ctx.quadraticCurveTo(r * 0.06, -r * 1.2, r * 0.2, -r * 1.28);
  ctx.lineWidth = r * 0.11;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.stroke();
}

function leaf(ctx: CanvasRenderingContext2D, r: number, angle: number, len = 0.55) {
  ctx.save();
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.9);
  ctx.quadraticCurveTo(r * 0.36, -r * (0.9 + len * 0.5), r * 0.06, -r * (0.9 + len));
  ctx.quadraticCurveTo(-r * 0.16, -r * (0.9 + len * 0.45), 0, -r * 0.9);
  const g = ctx.createLinearGradient(0, -r, 0, -r * 1.5);
  g.addColorStop(0, '#5da62f');
  g.addColorStop(1, '#2f6b18');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
}

/** Radiating segment wedges — citrus flesh, grape flesh, tomato locules. */
function segments(
  ctx: CanvasRenderingContext2D,
  r: number,
  count: number,
  color: string,
  inset = 0.86,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, r * 0.035);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 0.06, Math.sin(a) * r * 0.06);
    ctx.lineTo(Math.cos(a) * r * inset, Math.sin(a) * r * inset);
    ctx.stroke();
  }
  ctx.restore();
}

function rindRing(ctx: CanvasRenderingContext2D, r: number, outer: string, inner: string) {
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fillStyle = outer;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.9, 0, TAU);
  ctx.fillStyle = inner;
  ctx.fill();
}

export const FRUITS: Record<FruitId, FruitDef> = {
  watermelon: {
    id: 'watermelon',
    label: 'Watermelon',
    size: 0.082,
    points: 10,
    juice: '#ef3d5c',
    juice2: '#ff7b90',
    mass: 1.6,
    draw(ctx, r) {
      ball(ctx, r, [
        [0, '#8ed24a'],
        [0.55, '#4b9c2c'],
        [1, '#1f5c17'],
      ]);
      // Dark meridian stripes, squeezed toward the silhouette edges.
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.clip();
      ctx.strokeStyle = 'rgba(20,64,16,0.75)';
      ctx.lineWidth = r * 0.15;
      for (let i = -3; i <= 3; i++) {
        const off = (i / 3.4) * r;
        ctx.beginPath();
        ctx.moveTo(off, -r);
        ctx.quadraticCurveTo(off * 1.55, 0, off, r);
        ctx.stroke();
      }
      ctx.restore();
      gloss(ctx, r, 0.3);
      stem(ctx, r, '#3f6b1f');
    },
    flesh(ctx, r) {
      rindRing(ctx, r, '#2f6b18', '#eafbe0');
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.82, 0, TAU);
      ctx.fillStyle = radial(ctx, r, [
        [0, '#ff6b82'],
        [1, '#d9264a'],
      ]);
      ctx.fill();
      ctx.fillStyle = '#2b1410';
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * TAU + 0.4;
        const d = r * (0.34 + (i % 3) * 0.17);
        ctx.save();
        ctx.translate(Math.cos(a) * d, Math.sin(a) * d);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.07, r * 0.045, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
    },
  },

  strawberry: {
    id: 'strawberry',
    label: 'Strawberry',
    size: 0.05,
    points: 15,
    juice: '#e8244a',
    juice2: '#ff8098',
    mass: 0.7,
    draw(ctx, r) {
      // Heart-ish body: wide shoulders tapering to a point.
      ctx.beginPath();
      ctx.moveTo(0, r);
      ctx.bezierCurveTo(r * 1.15, r * 0.22, r * 0.95, -r * 0.95, 0, -r * 0.78);
      ctx.bezierCurveTo(-r * 0.95, -r * 0.95, -r * 1.15, r * 0.22, 0, r);
      ctx.fillStyle = radial(ctx, r, [
        [0, '#ff5f74'],
        [0.5, '#e11f3f'],
        [1, '#96122b'],
      ]);
      ctx.fill();
      // Seeds.
      ctx.fillStyle = '#ffe08a';
      for (let i = 0; i < 16; i++) {
        const a = (i * 2.399) % TAU;
        const d = r * (0.25 + ((i * 37) % 60) / 100);
        const x = Math.cos(a) * d * 0.82;
        const y = Math.sin(a) * d * 0.85 + r * 0.05;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.atan2(y, x));
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.055, r * 0.033, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
      gloss(ctx, r, 0.35);
      for (let i = 0; i < 5; i++) leaf(ctx, r * 0.72, (i - 2) * 0.55, 0.5);
      stem(ctx, r * 0.8, '#3f7a22');
    },
    flesh(ctx, r) {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fillStyle = '#c8163a';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.86, 0, TAU);
      ctx.fillStyle = radial(ctx, r, [
        [0, '#fff0f2'],
        [0.6, '#ff9aab'],
        [1, '#e8455f'],
      ]);
      ctx.fill();
      segments(ctx, r, 12, 'rgba(255,255,255,0.55)', 0.8);
    },
  },

  banana: {
    id: 'banana',
    label: 'Banana',
    size: 0.062,
    points: 12,
    juice: '#f7e07a',
    juice2: '#fff6c4',
    mass: 0.8,
    draw(ctx, r) {
      ctx.save();
      ctx.rotate(-0.3);

      // Crescent built once as a path, then reused for fill, outline and clip.
      const body = new Path2D();
      body.moveTo(-r * 0.92, -r * 0.42);
      body.quadraticCurveTo(0, r * 1.7, r * 0.92, -r * 0.42);
      body.quadraticCurveTo(r * 1.02, -r * 0.06, r * 0.68, -r * 0.1);
      body.quadraticCurveTo(0, r * 0.7, -r * 0.68, -r * 0.1);
      body.quadraticCurveTo(-r * 1.02, -r * 0.06, -r * 0.92, -r * 0.42);
      body.closePath();

      const g = ctx.createLinearGradient(0, -r * 0.4, 0, r * 0.9);
      g.addColorStop(0, '#fff08c');
      g.addColorStop(0.45, '#f6cf33');
      g.addColorStop(1, '#c08d10');
      ctx.fillStyle = g;
      ctx.fill(body);

      // The highlight is composited in 'screen' mode, so it has to stay inside
      // the silhouette — over transparent pixels it would show as a grey smear.
      ctx.save();
      ctx.clip(body);
      ctx.globalCompositeOperation = 'screen';
      ctx.beginPath();
      ctx.ellipse(-r * 0.12, r * 0.28, r * 0.5, r * 0.11, 0.12, 0, TAU);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fill();
      ctx.restore();

      // Ridge along the inner edge.
      ctx.save();
      ctx.clip(body);
      ctx.beginPath();
      ctx.moveTo(-r * 0.7, -r * 0.12);
      ctx.quadraticCurveTo(0, r * 0.72, r * 0.7, -r * 0.12);
      ctx.strokeStyle = 'rgba(150,105,10,0.35)';
      ctx.lineWidth = r * 0.06;
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = 'rgba(140,98,8,0.55)';
      ctx.lineWidth = r * 0.035;
      ctx.stroke(body);

      // Browned tips.
      ctx.fillStyle = '#6b4a17';
      ctx.beginPath();
      ctx.ellipse(-r * 0.92, -r * 0.42, r * 0.1, r * 0.075, 0.4, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(r * 0.92, -r * 0.42, r * 0.09, r * 0.07, -0.4, 0, TAU);
      ctx.fill();
      ctx.restore();
    },
    flesh(ctx, r) {
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.8, 0, TAU);
      ctx.fillStyle = '#e8c53a';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.68, 0, TAU);
      ctx.fillStyle = '#fff4c9';
      ctx.fill();
      segments(ctx, r * 0.6, 3, 'rgba(180,150,60,0.6)', 0.7);
    },
  },

  orange: {
    id: 'orange',
    label: 'Orange',
    size: 0.062,
    points: 20,
    juice: '#ff9c1a',
    juice2: '#ffd27a',
    mass: 1.0,
    draw(ctx, r) {
      ball(ctx, r, [
        [0, '#ffbb52'],
        [0.6, '#f5871f'],
        [1, '#b8530a'],
      ]);
      // Pitted rind.
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.clip();
      ctx.fillStyle = 'rgba(140,60,5,0.22)';
      for (let i = 0; i < 44; i++) {
        const a = (i * 2.399) % TAU;
        const d = r * Math.sqrt(((i * 53) % 100) / 100) * 0.95;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * d, Math.sin(a) * d, r * 0.035, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
      gloss(ctx, r, 0.35);
      ctx.beginPath();
      ctx.arc(r * 0.05, -r * 0.9, r * 0.11, 0, TAU);
      ctx.fillStyle = '#7a4a12';
      ctx.fill();
      leaf(ctx, r * 0.95, 0.3, 0.42);
    },
    flesh(ctx, r) {
      rindRing(ctx, r, '#e0770f', '#ffe6bd');
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.8, 0, TAU);
      ctx.fillStyle = radial(ctx, r, [
        [0, '#ffc768'],
        [1, '#f58a12'],
      ]);
      ctx.fill();
      segments(ctx, r, 9, 'rgba(255,240,205,0.85)', 0.79);
    },
  },

  grapes: {
    id: 'grapes',
    label: 'Grapes',
    size: 0.065,
    points: 25,
    juice: '#8d4bd6',
    juice2: '#c79bf0',
    mass: 0.9,
    draw(ctx, r) {
      leaf(ctx, r * 0.85, -0.35, 0.45);
      leaf(ctx, r * 0.85, 0.45, 0.4);
      stem(ctx, r * 0.9, '#4a7c26');
      // Cluster laid out as a rough inverted triangle.
      const rows = [
        { n: 3, y: -0.48 },
        { n: 3, y: 0.04 },
        { n: 2, y: 0.52 },
        { n: 1, y: 0.94 },
      ];
      const br = r * 0.31;
      for (const row of rows) {
        for (let i = 0; i < row.n; i++) {
          const x = (i - (row.n - 1) / 2) * br * 1.7;
          ctx.save();
          ctx.translate(x, row.y * r);
          ball(ctx, br, [
            [0, '#b07ae8'],
            [0.55, '#7a35c4'],
            [1, '#43156f'],
          ]);
          gloss(ctx, br, 0.45);
          ctx.restore();
        }
      }
    },
    flesh(ctx, r) {
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.7, 0, TAU);
      ctx.fillStyle = '#5e219c';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.58, 0, TAU);
      ctx.fillStyle = '#d9c2f2';
      ctx.fill();
    },
  },

  tomato: {
    id: 'tomato',
    label: 'Tomato',
    size: 0.058,
    points: 20,
    juice: '#e0281f',
    juice2: '#ff7d63',
    mass: 0.9,
    draw(ctx, r) {
      ctx.save();
      ctx.scale(1, 0.9);
      ball(ctx, r, [
        [0, '#ff6a4d'],
        [0.55, '#e02318'],
        [1, '#8e1109'],
      ]);
      ctx.restore();
      gloss(ctx, r, 0.42);
      // Green calyx: five short sepals splayed over the shoulder.
      ctx.save();
      ctx.translate(0, -r * 0.72);
      for (let i = 0; i < 5; i++) {
        ctx.save();
        ctx.rotate((i / 5) * TAU);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(r * 0.16, r * 0.1, r * 0.02, r * 0.42);
        ctx.quadraticCurveTo(-r * 0.14, r * 0.1, 0, 0);
        ctx.fillStyle = i % 2 ? '#3f7a22' : '#4f9129';
        ctx.fill();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.09, 0, TAU);
      ctx.fillStyle = '#2f5c17';
      ctx.fill();
      ctx.restore();
    },
    flesh(ctx, r) {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fillStyle = '#c81b12';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.88, 0, TAU);
      ctx.fillStyle = radial(ctx, r, [
        [0, '#ffd9c4'],
        [1, '#f0523a'],
      ]);
      ctx.fill();
      // Seed cavities.
      ctx.fillStyle = 'rgba(255,244,214,0.85)';
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU + 0.3;
        ctx.beginPath();
        ctx.ellipse(Math.cos(a) * r * 0.48, Math.sin(a) * r * 0.48, r * 0.17, r * 0.11, a, 0, TAU);
        ctx.fill();
      }
    },
  },

  coconut: {
    id: 'coconut',
    label: 'Coconut',
    size: 0.062,
    points: 30,
    juice: '#f5efe0',
    juice2: '#d8c7a4',
    mass: 2.4,
    draw(ctx, r) {
      ball(ctx, r, [
        [0, '#a9764a'],
        [0.55, '#71441f'],
        [1, '#3d2410'],
      ]);
      // Husk fibres.
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.clip();
      ctx.strokeStyle = 'rgba(40,22,8,0.4)';
      ctx.lineWidth = r * 0.035;
      for (let i = 0; i < 22; i++) {
        const a = (i * 2.399) % TAU;
        const d = r * (0.2 + ((i * 41) % 70) / 100);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * d, Math.sin(a) * d);
        ctx.lineTo(Math.cos(a + 0.25) * (d + r * 0.4), Math.sin(a + 0.25) * (d + r * 0.4));
        ctx.stroke();
      }
      ctx.restore();
      // The three germination pores.
      ctx.fillStyle = '#241305';
      for (let i = 0; i < 3; i++) {
        const a = -1.2 + i * 0.5;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r * 0.42, Math.sin(a) * r * 0.42 - r * 0.1, r * 0.1, 0, TAU);
        ctx.fill();
      }
      gloss(ctx, r, 0.18);
    },
    flesh(ctx, r) {
      rindRing(ctx, r, '#5c360f', '#f7f2e4');
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.62, 0, TAU);
      ctx.fillStyle = '#cbb894';
      ctx.fill();
    },
  },

  pineapple: {
    id: 'pineapple',
    label: 'Pineapple',
    size: 0.078,
    points: 35,
    juice: '#ffd93b',
    juice2: '#fff2a8',
    mass: 2.0,
    draw(ctx, r) {
      ctx.save();
      ctx.scale(0.82, 1.05);
      ball(ctx, r, [
        [0, '#ffd95e'],
        [0.6, '#e0a018'],
        [1, '#9c6a06'],
      ]);
      // Diamond crosshatch of the rind.
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.clip();
      ctx.strokeStyle = 'rgba(110,70,5,0.55)';
      ctx.lineWidth = r * 0.045;
      for (let i = -6; i <= 6; i++) {
        ctx.beginPath();
        ctx.moveTo(-r * 1.2, i * r * 0.3 - r * 1.2);
        ctx.lineTo(r * 1.2, i * r * 0.3 + r * 1.2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-r * 1.2, -i * r * 0.3 + r * 1.2);
        ctx.lineTo(r * 1.2, -i * r * 0.3 - r * 1.2);
        ctx.stroke();
      }
      ctx.restore();
      ctx.restore();
      // Spiky crown.
      for (let i = -3; i <= 3; i++) {
        ctx.save();
        ctx.rotate(i * 0.24);
        ctx.beginPath();
        ctx.moveTo(-r * 0.12, -r * 0.9);
        ctx.lineTo(0, -r * (1.65 - Math.abs(i) * 0.12));
        ctx.lineTo(r * 0.12, -r * 0.9);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, -r * 1.6, 0, -r * 0.9);
        g.addColorStop(0, '#3f8a1f');
        g.addColorStop(1, '#77b83c');
        ctx.fillStyle = g;
        ctx.fill();
        ctx.restore();
      }
      gloss(ctx, r * 0.9, 0.22);
    },
    flesh(ctx, r) {
      rindRing(ctx, r, '#b07c0c', '#ffe98f');
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.78, 0, TAU);
      ctx.fillStyle = radial(ctx, r, [
        [0, '#fff3b0'],
        [1, '#f0c22e'],
      ]);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.16, 0, TAU);
      ctx.fillStyle = '#d9a91c';
      ctx.fill();
      segments(ctx, r, 14, 'rgba(200,150,20,0.4)', 0.76);
    },
  },

  bomb: {
    id: 'bomb',
    label: 'Bomb',
    size: 0.056,
    points: 0,
    juice: '#3a3a44',
    juice2: '#ff9d3d',
    mass: 1.4,
    draw(ctx, r) {
      ball(ctx, r, [
        [0, '#5a5f6b'],
        [0.5, '#25282f'],
        [1, '#0c0d10'],
      ]);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = r * 0.05;
      ctx.stroke();
      gloss(ctx, r, 0.55);
      // Cap and fuse.
      ctx.save();
      ctx.rotate(0.5);
      ctx.fillStyle = '#8a6134';
      ctx.fillRect(-r * 0.17, -r * 1.18, r * 0.34, r * 0.34);
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.15);
      ctx.quadraticCurveTo(r * 0.55, -r * 1.6, r * 0.3, -r * 1.95);
      ctx.lineWidth = r * 0.1;
      ctx.strokeStyle = '#c9b28a';
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();
    },
    flesh(ctx, r) {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fillStyle = '#1a1c21';
      ctx.fill();
    },
  },
};

/** Accent colour for the sword, popups and UI chrome. */
export const SLICE_COLOR = '#5ee7ff';
