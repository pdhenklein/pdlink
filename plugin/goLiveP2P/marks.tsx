import { React, ReactDOM, useEffect, useRef, useState, UserStore } from "@webpack/common";

import { Board, makeBoard, Mark, View } from "./marksCore";

// Ping e desenho de quem assiste: uma camada transparente sobre o video, uma barra de ferramentas que aparece
// quando o mouse esta em cima, e a ponte com o transmissor (canal "m" do P2P).

// ------------------------------------------------------------------ sessoes (uma por live assistida)

export interface MarkSession {
    board: Board;
    allowed(): boolean;
    send(m: Mark): void;
    wake(): void;
    listeners: Set<() => void>;
}

const sessions = new Map<string, MarkSession>();
const sessionSubs = new Set<() => void>();

export function createMarkSession(allowed: () => boolean, send: (m: Mark) => void): MarkSession {
    const s: MarkSession = {
        board: makeBoard(), allowed, send, listeners: new Set(),
        wake() { for (const l of s.listeners) l(); }
    };
    return s;
}

export function registerMarkSession(ownerId: string, s: MarkSession) {
    sessions.set(ownerId, s);
    sessionSubs.forEach(f => f());
}

export function dropMarkSession(ownerId: string) {
    const s = sessions.get(ownerId);
    if (!s) return;
    s.board.reset();
    sessions.delete(ownerId);
    if (sessions.size === 0 && ui.mode !== "off") ui = { ...ui, mode: "off", tool: "pen" };
    sessionSubs.forEach(f => f());
}

export function notifyMarkSessions() {
    sessionSubs.forEach(f => f());
}

// ------------------------------------------------------------------ preferencias da barra

export type Mode = "off" | "ping" | "draw";
export type Tool = "pen" | "eraser";

export const COLORS = ["#3b82f6", "#ef4444", "#22c55e", "#eab308", "#f97316", "#ec4899", "#a855f7", "#ffffff"];
const WIDTHS = [3, 6, 12];
const ERASER_W = 34;

function load(key: string, fallback: string) {
    try { return localStorage.getItem("golive-p2p:" + key) || fallback; } catch { return fallback; }
}
function save(key: string, value: string) {
    try { localStorage.setItem("golive-p2p:" + key, value); } catch { }
}

interface Ui { mode: Mode; tool: Tool; color: string; width: number; }
const initialColor = load("markColor", COLORS[0]);
let ui: Ui = {
    mode: "off", tool: "pen",
    color: /^#[0-9a-fA-F]{6}$/.test(initialColor) ? initialColor : COLORS[0],
    width: Math.max(0, WIDTHS.indexOf(Number(load("markWidth", "6"))))
};
if (ui.width < 0) ui.width = 1;
const uiSubs = new Set<() => void>();

function setUi(patch: Partial<Ui>) {
    ui = { ...ui, ...patch };
    if (patch.color) save("markColor", ui.color);
    if (patch.width != null) save("markWidth", String(WIDTHS[ui.width]));
    uiSubs.forEach(f => f());
}

/** Sai do modo desenho (ou troca para outro): o desenho de quem saiu some para todo mundo. */
function changeMode(mode: Mode) {
    if (ui.mode === "draw" && mode !== "draw") {
        const self = UserStore.getCurrentUser()?.id as string | undefined;
        for (const [, s] of sessions) {
            if (self) s.board.clear(self);
            if (s.allowed()) s.send({ t: "clear" });
            s.wake();
        }
    }
    setUi({ mode, tool: "pen" });
}

function useBus() {
    const [, force] = useState(0);
    useEffect(() => {
        const f = () => force(n => n + 1);
        uiSubs.add(f);
        sessionSubs.add(f);
        return () => { uiSubs.delete(f); sessionSubs.delete(f); };
    }, []);
}

// ------------------------------------------------------------------ geometria

/** Onde a imagem realmente aparece dentro do <video> (respeita object-fit; as faixas pretas ficam de fora). */
export function frameRect(video: HTMLVideoElement, boxW: number, boxH: number): View | null {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !boxW || !boxH) return null;
    const fit = getComputedStyle(video).objectFit || "fill";
    let sx = boxW / vw, sy = boxH / vh;
    if (fit === "contain" || fit === "scale-down") sx = sy = Math.min(sx, sy);
    else if (fit === "cover") sx = sy = Math.max(sx, sy);
    else if (fit === "none") sx = sy = 1;
    const w = vw * sx, h = vh * sy;
    return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

// ------------------------------------------------------------------ icones

const I = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "currentColor" } as const;
const PingIcon = () => <svg {...I}><path d="M12 2a1 1 0 0 1 1 1v2.06A7 7 0 0 1 18.94 11H21a1 1 0 1 1 0 2h-2.06A7 7 0 0 1 13 18.94V21a1 1 0 1 1-2 0v-2.06A7 7 0 0 1 5.06 13H3a1 1 0 1 1 0-2h2.06A7 7 0 0 1 11 5.06V3a1 1 0 0 1 1-1Zm0 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z" /></svg>;
const PenIcon = () => <svg {...I}><path d="m16.9 3.3 3.8 3.8a1.5 1.5 0 0 1 0 2.1L9.6 20.3 4 21l.7-5.6L15.9 3.3a1.5 1.5 0 0 1 1-.4Z" /></svg>;
const EraserIcon = () => <svg {...I}><path d="m15.1 3.6 5.3 5.3a2 2 0 0 1 0 2.8L12 20h8v2H8.6l-4.9-4.9a2 2 0 0 1 0-2.8l9.3-9.3a2 2 0 0 1 2.8 0ZM7 15.4 9.6 18l5.2-5.2L12.2 10 7 15.4Z" /></svg>;
const TrashIcon = () => <svg {...I}><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z" /></svg>;
const CloseIcon = () => <svg {...I}><path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z" /></svg>;

// ------------------------------------------------------------------ a camada

function Btn({ title, active, onClick, children }: { title: string; active?: boolean; onClick: () => void; children: React.ReactNode; }) {
    return (
        <button
            title={title}
            onClick={e => { e.stopPropagation(); onClick(); }}
            style={{
                all: "unset", cursor: "pointer", width: 30, height: 30, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center",
                color: active ? "#fff" : "#c7cad1", background: active ? "var(--brand-500, #5865f2)" : "transparent"
            }}
        >
            {children}
        </button>
    );
}

export function MarkLayer({ video, ownerId }: { video: React.RefObject<HTMLVideoElement | null>; ownerId: string; }) {
    useBus();
    const session = sessions.get(ownerId);
    const [box, setBox] = useState<{ l: number; t: number; w: number; h: number; } | null>(null);
    const [hover, setHover] = useState(false);
    const [palette, setPalette] = useState(false);
    const [idle, setIdle] = useState(false);
    const [, setTick] = useState(0);
    const idleTimer = useRef<any>(0);
    const paletteOpen = useRef(false);
    paletteOpen.current = palette;
    const canvas = useRef<HTMLCanvasElement>(null);
    const loop = useRef(0);
    const stroke = useRef<{ pts: [number, number][]; first: boolean; raf: number; down: boolean; } | null>(null);
    const lastPing = useRef(0);
    const pingAt = useRef<((cx: number, cy: number) => boolean) | null>(null);
    const midHandled = useRef(0);
    const allowed = !!session && session.allowed();
    const active = ui.mode !== "off";

    const measure = () => {
        const v = video.current;
        if (!v || !v.isConnected) return null;
        const r = v.getBoundingClientRect();
        return { l: r.left, t: r.top, w: r.width, h: r.height };
    };

    const paint = () => {
        const v = video.current, cv = canvas.current, s = sessions.get(ownerId);
        if (!v || !cv || !s) return false;
        const b = measure();
        if (!b || b.w < 2 || b.h < 2) return false;
        const dpr = v.ownerDocument.defaultView?.devicePixelRatio ?? 1;
        const W = Math.round(b.w * dpr), H = Math.round(b.h * dpr);
        if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
        const fr = frameRect(v, b.w, b.h);
        if (!fr) return false;
        return s.board.draw(cv.getContext("2d")!, W, H, performance.now(), { x: fr.x * dpr, y: fr.y * dpr, w: fr.w * dpr, h: fr.h * dpr });
    };

    // quadro a quadro enquanto houver o que animar ou o modo de marcacao estiver ligado (acompanha o tamanho do quadro na tela)
    const kick = () => {
        if (loop.current) return;
        const tick = () => {
            loop.current = 0;
            const b = measure();
            setBox(prev => (b && (!prev || prev.l !== b.l || prev.t !== b.t || prev.w !== b.w || prev.h !== b.h)) ? b : prev);
            const animating = paint();
            const s = sessions.get(ownerId);
            if (ui.mode !== "off" || animating || (s && s.board.busy(performance.now()))) loop.current = requestAnimationFrame(tick);
        };
        loop.current = requestAnimationFrame(tick);
    };

    useEffect(() => {
        const s = sessions.get(ownerId);
        const wake = () => kick();
        s?.listeners.add(wake);
        return () => { s?.listeners.delete(wake); };
    }, [session]);

    useEffect(() => { kick(); }, [ui.mode, session]);
    useEffect(() => () => { cancelAnimationFrame(loop.current); loop.current = 0; }, []);

    // a barra aparece quando o mouse passa por cima do video (mesmo com camadas do Discord na frente dele)
    useEffect(() => {
        const v = video.current;
        if (!v) return;
        const doc = v.ownerDocument;
        let last = false;
        // como os controles do Discord: somem depois de uns segundos sem mexer o mouse (nao somem enquanto desenha ou com a paleta aberta)
        const arm = () => {
            clearTimeout(idleTimer.current);
            idleTimer.current = setTimeout(() => { if (paletteOpen.current || stroke.current) arm(); else setIdle(true); }, 3000);
        };
        const move = (e: MouseEvent) => {
            const r = v.getBoundingClientRect();
            const inside = r.width > 0 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
            if (inside) { setIdle(false); arm(); }
            if (inside !== last) {
                last = inside;
                setHover(inside);
                if (inside) { setBox({ l: r.left, t: r.top, w: r.width, h: r.height }); kick(); }
            }
        };
        const key = (e: KeyboardEvent) => { if (e.key === "Escape" && ui.mode !== "off") changeMode("off"); };
        // botao do meio (roda do mouse) pinga direto, sem ligar o modo ping, como nos jogos
        const onMid = (e: MouseEvent) => {
            if (e.button !== 1 || !pingAt.current) return;
            const r = v.getBoundingClientRect();
            if (!(r.width > 0 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)) return;
            const top = doc.elementFromPoint(e.clientX, e.clientY);
            if (top?.closest('[role="dialog"], [role="menu"], [class*="layerContainer"]')) return; // janelas e menus do Discord na frente
            if (pingAt.current(e.clientX, e.clientY)) {
                e.preventDefault(); // evita a rolagem automatica do botao do meio
                e.stopPropagation();
                midHandled.current = performance.now();
            }
        };
        const onAux = (e: MouseEvent) => {
            if (e.button === 1 && performance.now() - midHandled.current < 1500) { e.preventDefault(); e.stopPropagation(); }
        };
        doc.addEventListener("mousedown", onMid, true);
        doc.addEventListener("auxclick", onAux, true);
        // se a janela mudar de tamanho ou a tela rolar, o desenho precisa acompanhar o video
        const relayout = () => kick();
        // em tela cheia o Discord so mostra o elemento da tela cheia (e o que estiver dentro dele): a camada tem que ir para la
        const onFullscreen = () => { setTick(n => n + 1); relayout(); };
        const win = doc.defaultView;
        doc.addEventListener("fullscreenchange", onFullscreen);
        doc.addEventListener("mousemove", move, { passive: true });
        doc.addEventListener("keydown", key);
        win?.addEventListener("resize", relayout);
        doc.addEventListener("scroll", relayout, true);
        return () => {
            doc.removeEventListener("mousemove", move);
            doc.removeEventListener("keydown", key);
            win?.removeEventListener("resize", relayout);
            doc.removeEventListener("scroll", relayout, true);
            doc.removeEventListener("fullscreenchange", onFullscreen);
            doc.removeEventListener("mousedown", onMid, true);
            doc.removeEventListener("auxclick", onAux, true);
            clearTimeout(idleTimer.current);
        };
    }, []);

    pingAt.current = null;
    if (!session || !allowed || !box || box.w < 120 || box.h < 70) return null;
    const v = video.current;
    const doc = v?.ownerDocument;
    if (!v || !doc) return null;
    const fs = doc.fullscreenElement as HTMLElement | null;
    const target: HTMLElement = fs && fs !== v && fs.contains(v) ? fs : doc.body;
    const self = UserStore.getCurrentUser()?.id as string | undefined;
    const showBar = hover || active;

    const toNorm = (cx: number, cy: number): [number, number] | null => {
        const b = measure(), vv = video.current;
        if (!b || !vv) return null;
        const fr = frameRect(vv, b.w, b.h);
        if (!fr) return null;
        const u = (cx - b.l - fr.x) / fr.w, w = (cy - b.t - fr.y) / fr.h;
        return u >= 0 && u <= 1 && w >= 0 && w <= 1 ? [u, w] : null;
    };
    const r4 = (n: number) => Math.round(n * 10000) / 10000;

    // ping no ponto (usado pelo modo ping e pelo botao do meio); false = clique fora da imagem (faixa preta)
    const doPing = (cx: number, cy: number) => {
        const p = toNorm(cx, cy);
        if (!p) return false;
        const now = performance.now();
        if (now - lastPing.current < 150) return true;
        lastPing.current = now;
        const m: Mark = { t: "ping", x: r4(p[0]), y: r4(p[1]), c: ui.color };
        if (self) session.board.apply({ ...m, from: self, n: "" }, now);
        session.send(m);
        kick();
        return true;
    };
    pingAt.current = doPing;

    const flush = () => {
        const st = stroke.current;
        if (!st || !st.pts.length) return;
        const eraser = ui.tool === "eraser";
        const m: Mark = {
            t: "d", pts: st.pts.map(p => [r4(p[0]), r4(p[1])] as [number, number]), c: ui.color,
            w: eraser ? ERASER_W : WIDTHS[ui.width], e: eraser, s: st.first
        };
        st.pts = [];
        st.first = false;
        if (self) session.board.apply({ ...m, from: self }, performance.now());
        session.send(m);
        kick();
    };

    const onDown = (e: React.PointerEvent) => {
        e.stopPropagation();
        e.preventDefault();
        if (e.button !== 0) return; // o botao do meio e tratado pelo ouvinte do documento (ping direto)
        const p = toNorm(e.clientX, e.clientY);
        if (ui.mode === "ping") {
            doPing(e.clientX, e.clientY);
        } else if (ui.mode === "draw") {
            try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { }
            stroke.current = { pts: p ? [p] : [], first: true, raf: 0, down: true };
            if (p) flush();
        }
    };
    const onMove = (e: React.PointerEvent) => {
        e.stopPropagation();
        const st = stroke.current;
        if (!st?.down || ui.mode !== "draw") return;
        const evs = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [];
        const list = evs.length ? evs : [e.nativeEvent as PointerEvent];
        for (const pe of list) {
            const p = toNorm(pe.clientX, pe.clientY);
            if (p) st.pts.push(p);
            else if (!st.first) { flush(); st.first = true; } // saiu da imagem: o proximo ponto comeca outro traco
        }
        if (!st.raf) st.raf = requestAnimationFrame(() => { st.raf = 0; flush(); });
    };
    const onUp = (e: React.PointerEvent) => {
        e.stopPropagation();
        const st = stroke.current;
        if (!st) return;
        st.down = false;
        cancelAnimationFrame(st.raf);
        flush();
        stroke.current = null;
    };
    const swallow = (e: React.SyntheticEvent) => { e.stopPropagation(); };

    const colorBtn = (
        <button
            title="Cor"
            onClick={e => { e.stopPropagation(); setPalette(p => !p); }}
            style={{ all: "unset", cursor: "pointer", width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
            <span style={{ width: 18, height: 18, borderRadius: "50%", background: ui.color, border: "2px solid #fff", boxSizing: "border-box" }} />
        </button>
    );

    const pickColor = (c: string) => { setUi({ color: c }); setPalette(false); };

    return ReactDOM.createPortal(
        <div
            style={{ position: "fixed", left: box.l, top: box.t, width: box.w, height: box.h, zIndex: 999, pointerEvents: "none", overflow: "hidden" }}
        >
            <canvas ref={canvas} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />
            {active && (
                <div
                    onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
                    onClick={swallow} onDoubleClick={swallow} onContextMenu={e => { e.stopPropagation(); e.preventDefault(); }} onMouseDown={swallow}
                    style={{ position: "absolute", inset: 0, pointerEvents: "auto", cursor: "crosshair", touchAction: "none" }}
                />
            )}
            {showBar && (
                <div
                    onClick={swallow} onDoubleClick={swallow} onMouseDown={swallow} onPointerDown={swallow} onContextMenu={swallow}
                    style={{
                        position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)",
                        pointerEvents: idle ? "none" : "auto", opacity: idle ? 0 : 1, transition: "opacity .25s",
                        display: "flex", alignItems: "center", gap: 2, padding: 4, borderRadius: 10,
                        background: "rgba(24,25,28,.92)", boxShadow: "0 4px 14px rgba(0,0,0,.45)", userSelect: "none"
                    }}
                >
                    <Btn title="Ping (ou clique com o botão do meio do mouse)" active={ui.mode === "ping"} onClick={() => changeMode(ui.mode === "ping" ? "off" : "ping")}><PingIcon /></Btn>
                    <Btn title="Desenhar" active={ui.mode === "draw" && ui.tool === "pen"} onClick={() => { if (ui.mode !== "draw") changeMode("draw"); setUi({ tool: "pen" }); }}><PenIcon /></Btn>
                    {ui.mode === "draw" && <Btn title="Borracha" active={ui.tool === "eraser"} onClick={() => setUi({ tool: ui.tool === "eraser" ? "pen" : "eraser" })}><EraserIcon /></Btn>}
                    {active && colorBtn}
                    {ui.mode === "draw" && ui.tool === "pen" && (
                        <Btn title="Espessura do traco" onClick={() => setUi({ width: (ui.width + 1) % WIDTHS.length })}>
                            <span style={{ width: 6 + ui.width * 4, height: 6 + ui.width * 4, borderRadius: "50%", background: "#c7cad1" }} />
                        </Btn>
                    )}
                    {ui.mode === "draw" && (
                        <Btn
                            title="Apagar todo o meu desenho"
                            onClick={() => { if (self) session.board.clear(self); session.send({ t: "clear" }); session.wake(); }}
                        ><TrashIcon /></Btn>
                    )}
                    {active && <Btn title="Fechar (Esc). Fechar o desenho apaga o que voce desenhou" onClick={() => changeMode("off")}><CloseIcon /></Btn>}
                    {palette && active && (
                        <div style={{ position: "absolute", top: 42, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 6, padding: 8, borderRadius: 10, background: "rgba(24,25,28,.96)", boxShadow: "0 4px 14px rgba(0,0,0,.45)", alignItems: "center" }}>
                            {COLORS.map(c => (
                                <button
                                    key={c} title={c} onClick={e => { e.stopPropagation(); pickColor(c); }}
                                    style={{ all: "unset", cursor: "pointer", width: 22, height: 22, borderRadius: "50%", background: c, boxSizing: "border-box", border: c === ui.color ? "3px solid #fff" : "2px solid rgba(255,255,255,.35)" }}
                                />
                            ))}
                            <input
                                type="color" value={ui.color} title="Outra cor"
                                onChange={e => setUi({ color: e.target.value })}
                                onClick={e => e.stopPropagation()}
                                style={{ width: 26, height: 26, padding: 0, border: "none", background: "none", cursor: "pointer" }}
                            />
                        </div>
                    )}
                </div>
            )}
        </div>,
        target
    );
}
