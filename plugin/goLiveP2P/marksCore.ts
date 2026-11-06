// Marcacoes na live (ping e desenho). Este arquivo e puro: nada de Discord nem React, porque a MESMA funcao
// roda em dois lugares: na tela de quem assiste (renderer) e na janela transparente de quem transmite
// (o codigo dela e gerado a partir do texto desta funcao). Por isso `makeBoard` nao pode usar nada de fora dela.
//
// Todas as posicoes sao fracoes da IMAGEM transmitida (0 a 1), nunca pixels: assim 1080p, 1440p, janela
// redimensionada ou tela cheia caem exatamente no mesmo ponto.

export interface Mark {
    t: "ping" | "d" | "clear";
    from?: string;
    n?: string; // nome de quem marcou (so para exibir)
    x?: number;
    y?: number;
    pts?: [number, number][];
    c?: string;
    w?: number;
    e?: boolean; // borracha
    s?: boolean; // comeca um traco novo
}

export interface View {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Board {
    sanitize(m: any): Mark | null;
    apply(m: Mark, now: number): boolean;
    draw(ctx: CanvasRenderingContext2D, W: number, H: number, now: number, view: View): boolean;
    busy(now: number): boolean;
    clear(from: string): void;
    reset(): void;
}

export function makeBoard(): Board {
    const PING_MS = 3200;
    const MAX_POINTS = 24000;
    const pings: any[] = [];
    const layers = new Map<string, any>();
    let dirty = false;

    function num(v: any, lo: number, hi: number, fallback: number) {
        return typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
    }

    function sanitize(m: any): Mark | null {
        if (!m || typeof m !== "object") return null;
        const c = typeof m.c === "string" && /^#[0-9a-fA-F]{6}$/.test(m.c) ? m.c : "#3b82f6";
        if (m.t === "ping") {
            if (typeof m.x !== "number" || typeof m.y !== "number" || !(m.x >= 0 && m.x <= 1 && m.y >= 0 && m.y <= 1)) return null;
            return { t: "ping", x: m.x, y: m.y, c } as Mark;
        }
        if (m.t === "d") {
            if (!Array.isArray(m.pts)) return null;
            const pts: [number, number][] = [];
            for (const p of m.pts.slice(0, 256)) {
                if (Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number" && p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1) pts.push([p[0], p[1]]);
            }
            if (!pts.length) return null;
            return { t: "d", pts, c, w: num(m.w, 1, 80, 6), e: !!m.e, s: !!m.s } as Mark;
        }
        if (m.t === "clear") return { t: "clear" } as Mark;
        return null;
    }

    function apply(m: Mark, now: number) {
        const from = String(m.from ?? "");
        if (m.t === "ping") {
            pings.push({ x: m.x, y: m.y, c: m.c ?? "#3b82f6", n: String(m.n ?? "").slice(0, 32), t0: now });
            while (pings.length > 40) pings.shift();
            dirty = true;
            return true;
        }
        if (m.t === "clear") {
            const had = layers.delete(from);
            dirty = true;
            return had;
        }
        if (m.t === "d" && m.pts) {
            let layer = layers.get(from);
            if (!layer) {
                layer = { strokes: [], cur: null, count: 0, canvas: null, cw: 0, ch: 0 };
                layers.set(from, layer);
            }
            if (m.s || !layer.cur) {
                layer.cur = { c: m.c ?? "#3b82f6", w: m.w ?? 6, e: !!m.e, p: [], done: 0 };
                layer.strokes.push(layer.cur);
            }
            for (const p of m.pts) {
                layer.cur.p.push(p[0], p[1]);
                layer.count++;
            }
            // limite de memoria: descarta os tracos mais antigos
            while (layer.count > MAX_POINTS && layer.strokes.length > 1) {
                const old = layer.strokes.shift();
                layer.count -= old.p.length / 2;
                layer.canvas = null; // forca refazer o desenho sem o traco antigo
            }
            dirty = true;
            return true;
        }
        return false;
    }

    function paintStroke(g: CanvasRenderingContext2D, st: any, view: View) {
        const n = st.p.length / 2;
        if (n === 0 || st.done >= n) return;
        g.globalCompositeOperation = st.e ? "destination-out" : "source-over";
        g.strokeStyle = st.c;
        g.fillStyle = st.c;
        g.lineCap = "round";
        g.lineJoin = "round";
        const lw = Math.max(1.2, st.w * view.h / 1080);
        g.lineWidth = lw;
        if (n === 1) {
            g.beginPath();
            g.arc(st.p[0] * view.w, st.p[1] * view.h, lw / 2, 0, Math.PI * 2);
            g.fill();
        } else {
            const i = Math.max(0, st.done - 1);
            g.beginPath();
            g.moveTo(st.p[i * 2] * view.w, st.p[i * 2 + 1] * view.h);
            for (let j = i + 1; j < n; j++) g.lineTo(st.p[j * 2] * view.w, st.p[j * 2 + 1] * view.h);
            g.stroke();
        }
        st.done = n;
    }

    function layerCanvas(layer: any, view: View) {
        const w = Math.max(1, Math.round(view.w)), h = Math.max(1, Math.round(view.h));
        if (!layer.canvas || layer.cw !== w || layer.ch !== h) {
            layer.canvas = document.createElement("canvas");
            layer.canvas.width = w;
            layer.canvas.height = h;
            layer.cw = w;
            layer.ch = h;
            for (const st of layer.strokes) st.done = 0; // tamanho mudou: refaz tudo na nova escala
        }
        const g = layer.canvas.getContext("2d") as CanvasRenderingContext2D;
        const v = { x: 0, y: 0, w, h };
        for (const st of layer.strokes) paintStroke(g, st, v);
        g.globalCompositeOperation = "source-over";
        return layer.canvas;
    }

    function drawPing(ctx: CanvasRenderingContext2D, p: any, age: number, view: View) {
        const s = Math.max(0.55, view.h / 1080);
        const px = view.x + p.x * view.w, py = view.y + p.y * view.h;
        const fade = age > PING_MS - 700 ? Math.max(0, (PING_MS - age) / 700) : 1;
        // ondas que se espalham
        for (let k = 0; k < 3; k++) {
            const ra = age - k * 230;
            if (ra <= 0 || ra > 1500) continue;
            const e = 1 - Math.pow(1 - ra / 1500, 3);
            ctx.globalAlpha = (1 - ra / 1500) * 0.85 * fade;
            ctx.strokeStyle = p.c;
            ctx.lineWidth = 4 * s;
            ctx.beginPath();
            ctx.arc(px, py, (12 + 78 * e) * s, 0, Math.PI * 2);
            ctx.stroke();
        }
        // ponto central com contorno branco
        const pop = Math.min(1, age / 160);
        const r = 9 * s * (0.4 + 0.6 * pop);
        ctx.globalAlpha = fade;
        ctx.fillStyle = p.c;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.6 * s;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // nome de quem marcou
        if (p.n) {
            const fs = 15 * s;
            ctx.font = "600 " + fs + "px sans-serif";
            const tw = ctx.measureText(p.n).width;
            const bw = tw + 14 * s, bh = fs + 8 * s;
            const bx = Math.min(view.x + view.w - bw - 2, Math.max(view.x + 2, px - bw / 2));
            const by = Math.max(view.y + 2, py - 22 * s - bh);
            ctx.globalAlpha = 0.88 * fade;
            ctx.fillStyle = p.c;
            ctx.beginPath();
            const rad = 6 * s;
            ctx.moveTo(bx + rad, by);
            ctx.arcTo(bx + bw, by, bx + bw, by + bh, rad);
            ctx.arcTo(bx + bw, by + bh, bx, by + bh, rad);
            ctx.arcTo(bx, by + bh, bx, by, rad);
            ctx.arcTo(bx, by, bx + bw, by, rad);
            ctx.closePath();
            ctx.fill();
            ctx.globalAlpha = fade;
            ctx.fillStyle = "#ffffff";
            ctx.shadowColor = "rgba(0,0,0,.55)";
            ctx.shadowBlur = 3 * s;
            ctx.textBaseline = "middle";
            ctx.fillText(p.n, bx + 7 * s, by + bh / 2 + 0.5);
            ctx.shadowBlur = 0;
        }
        ctx.globalAlpha = 1;
    }

    // devolve true enquanto ainda ha animacao (quem chama continua pedindo quadros)
    function draw(ctx: CanvasRenderingContext2D, W: number, H: number, now: number, view: View) {
        ctx.clearRect(0, 0, W, H);
        ctx.save();
        ctx.beginPath();
        ctx.rect(view.x, view.y, view.w, view.h);
        ctx.clip();
        for (const layer of layers.values()) ctx.drawImage(layerCanvas(layer, view), view.x, view.y);
        for (let i = pings.length - 1; i >= 0; i--) if (now - pings[i].t0 > PING_MS) pings.splice(i, 1);
        for (const p of pings) drawPing(ctx, p, now - p.t0, view);
        ctx.restore();
        dirty = false;
        return pings.length > 0;
    }

    function busy(now: number) {
        return dirty || pings.some(p => now - p.t0 <= PING_MS);
    }

    function clear(from: string) {
        layers.delete(from);
        dirty = true;
    }

    function reset() {
        layers.clear();
        pings.length = 0;
        dirty = true;
    }

    return { sanitize, apply, draw, busy, clear, reset };
}

const checker = makeBoard();

/** Confere uma mensagem vinda da rede (valores fora do intervalo, cores estranhas e listas enormes sao descartados). */
export function sanitizeMark(m: any): Mark | null {
    return checker.sanitize(m);
}
