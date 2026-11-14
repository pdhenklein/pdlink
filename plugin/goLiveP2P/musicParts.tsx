/*
 * pdLink - musica: pecas pequenas da janela (icones, botoes, faixa de tempo, volume, controles, quem esta ouvindo).
 */

import { React, UserStore, useEffect, useRef, useState } from "@webpack/common";

import { currentTrack, LoopMode } from "./musicCore";
import type { Found } from "./musicNative";
import { Bound, isLiked, isLocal, S, setVolume, toggleLike } from "./musicState";

export const col = {
    bg: "#111214",
    card: "#1e1f22",
    hover: "#2b2d31",
    text: "#dbdee1",
    strong: "#ffffff",
    muted: "#949ba4",
    line: "#3f4147",
    brand: "var(--brand-500, #5865f2)",
    green: "#23a55a",
    red: "#f23f43"
};

const CSS = [
    "@keyframes pdl-wave{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}",
    "@keyframes pdl-in{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:none}}",
    "@keyframes pdl-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(8px) scale(.98)}}",
    "@keyframes pdl-fade{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}",
    "@keyframes pdl-pop{0%{transform:scale(.5)}60%{transform:scale(1.25)}100%{transform:scale(1)}}",
    "@keyframes pdl-spin{to{transform:rotate(360deg)}}",
    ".pdl-win{animation:pdl-in .22s cubic-bezier(.2,.8,.2,1)}",
    ".pdl-win.pdl-closing{animation:pdl-out .14s ease-in forwards}",
    ".pdl-view{animation:pdl-fade .18s ease-out}",
    ".pdl-row{animation:pdl-fade .2s ease-out}",
    ".pdl-pop{animation:pdl-pop .28s ease-out}",
    ".pdl-b:active{transform:scale(.88)!important}",
    ".pdl-win ::-webkit-scrollbar{width:6px}",
    ".pdl-win ::-webkit-scrollbar-thumb{background:#3f4147;border-radius:3px}",
    ".pdl-win ::-webkit-scrollbar-track{background:transparent}",
    "@keyframes pdl-dot{0%,80%,100%{opacity:.25;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}",
    "@keyframes pdl-bg{from{opacity:0}to{opacity:1}}",
    ".pdl-ly{transition:color .45s ease,opacity .45s ease;cursor:pointer}",
    ".pdl-ly:hover{color:rgba(255,255,255,.88)!important;opacity:1!important}",
    ".pdl-lyb{animation:pdl-bg .6s ease-out}",
    ".pdl-lys::-webkit-scrollbar{width:0!important}"
].join("");
export function ensureCss(doc: Document) {
    if (doc.getElementById("pdl-music-css")) return;
    const st = doc.createElement("style");
    st.id = "pdl-music-css"; st.textContent = CSS;
    doc.head.appendChild(st);
}

const PATHS: Record<string, string> = {
    fone: "M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3",
    proxima: "M5 4l10 8-10 8V4zM19 5v14",
    anterior: "M19 20L9 12l10-8v16zM5 19V5",
    repetir: "M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3",
    x: "M18 6L6 18M6 6l12 12",
    busca: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
    som: "M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14",
    mudo: "M11 5L6 9H2v6h4l5 4V5zM22 9l-6 6M16 9l6 6",
    voltar: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
    fila: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
    historico: "M12 7v5l3 2M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
    mais: "M12 5v14M5 12h14",
    coracao: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z",
    playlist: "M21 15V6M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM12 12H3M16 6H3M12 18H3",
    certo: "M20 6L9 17l-5-5",
    lixo: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
    seta: "M19 12H5M12 19l-7-7 7-7",
    girando: "M21 12a9 9 0 1 1-6.2-8.6",
    pc: "M4 5h16v11H4zM8 20h8M12 16v4",
    pasta: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    microfone: "M11.68 6.86A4.6 4.6 0 1 1 17.05 12.22ZM10.9 7.91 15.99 13 9.06 18.94A2.9 2.9 0 0 1 4.96 14.84Z"
};
/** icones desenhados so com preenchimento (sem contorno) */
const SOLID = new Set(["microfone"]);
export const Icon = ({ n, size = 18, fill, spin }: { n: string; size?: number; fill?: boolean; spin?: boolean; }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill || SOLID.has(n) ? "currentColor" : "none"} stroke={SOLID.has(n) ? "none" : "currentColor"} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", display: "block", animation: spin ? "pdl-spin .8s linear infinite" : undefined }}><path d={PATHS[n]} /></svg>
);
const PlayIcon = ({ playing, size = 16 }: { playing: boolean; size?: number; }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ display: "block" }}><path d={playing ? "M6 4h4v16H6zM14 4h4v16h-4z" : "M7 3l14 9-14 9V3z"} /></svg>
);
export const Grip = () => (
    <svg width={12} height={18} viewBox="0 0 12 18" fill="currentColor" style={{ flex: "none", color: col.muted, cursor: "grab" }}>
        {[3, 9, 15].map(y => [3, 9].map(x => <circle key={x + "-" + y} cx={x} cy={y} r={1.5} />))}
    </svg>
);

/** Barrinhas que mexem: marca a musica que esta tocando agora. */
export const Wave = ({ moving }: { moving: boolean; }) => (
    <div title="Tocando agora" style={{ width: 12, height: 14, display: "flex", alignItems: "flex-end", justifyContent: "space-between", flex: "none" }}>
        {[0, 1, 2].map(i => <span key={i} style={{ width: 3, height: "100%", borderRadius: 1, background: col.green, transformOrigin: "bottom", transform: `scaleY(${[0.5, 1, 0.7][i]})`, animation: moving ? `pdl-wave ${[0.9, 0.7, 1.1][i]}s ease-in-out ${i * 0.15}s infinite` : "none" }} />)}
    </div>
);

export const fmt = (s: number) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
export const ellipsis: React.CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
export const EASE = "background .14s ease, color .14s ease, transform .1s ease, opacity .14s ease";

export function IconBtn({ children, onClick, title, active, size = 30, color }: { children: React.ReactNode; onClick: () => void; title: string; active?: boolean; size?: number; color?: string; }) {
    const [h, setH] = useState(false);
    return (
        <button
            className="pdl-b" title={title} aria-label={title}
            onClick={e => { e.stopPropagation(); onClick(); }}
            onDoubleClick={e => e.stopPropagation()}
            onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
            style={{ all: "unset", cursor: "pointer", width: size, height: size, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", position: "relative", flex: "none", color: color ?? (active ? col.brand : h ? col.strong : col.text), background: h ? "rgba(255,255,255,.08)" : "transparent", transition: EASE }}
        >{children}</button>
    );
}

export const Heart = ({ f, size = 24 }: { f: Found; size?: number; }) => {
    if (isLocal(f)) return null;
    const on = isLiked(f.ref);
    return <IconBtn size={size} title={on ? "Tirar das curtidas" : "Curtir"} color={on ? col.red : undefined} onClick={() => toggleLike(f)}><span key={String(on)} className={on ? "pdl-pop" : undefined} style={{ display: "flex" }}><Icon n="coracao" size={Math.round(size * 0.58)} fill={on} /></span></IconBtn>;
};

export function Cover({ img, size, busy }: { img: string; size: number; busy?: boolean; }) {
    const [bad, setBad] = useState("");
    return (
        <div style={{ width: size, height: size, borderRadius: Math.max(4, size / 9), background: col.hover, flex: "none", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", color: col.muted, position: "relative" }}>
            {img && bad !== img ? <img key={img} className="pdl-view" src={img} onError={() => setBad(img)} draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Icon n="fone" size={Math.round(size * 0.5)} />}
            {busy && <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}><Icon n="girando" size={Math.round(size * 0.5)} spin /></div>}
        </div>
    );
}

/** Faixa de tempo: clicar ou arrastar muda o ponto da musica para todos. */
export function SeekBar({ b }: { b: Bound; }) {
    const [, tick] = useState(0);
    const [drag, setDrag] = useState<number | null>(null);
    const [h, setH] = useState(false);
    const bar = useRef<HTMLDivElement>(null);
    useEffect(() => { const t = setInterval(() => tick(n => n + 1), 250); return () => clearInterval(t); }, []);
    const t = currentTrack(b.sync.state);
    const dur = t?.dur ?? 0;
    const pos = drag ?? b.sync.position();
    const frac = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
    const at = (e: { clientX: number; }) => {
        const r = bar.current!.getBoundingClientRect();
        return Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))) * dur;
    };
    const down = (e: React.MouseEvent) => {
        if (!t || dur <= 0) return;
        e.preventDefault(); e.stopPropagation();
        setDrag(at(e));
        const doc = bar.current!.ownerDocument;
        const move = (ev: MouseEvent) => setDrag(at(ev));
        const up = (ev: MouseEvent) => {
            doc.removeEventListener("mousemove", move); doc.removeEventListener("mouseup", up);
            b.sync.do({ t: "seek", pos: at(ev) });
            setDrag(null);
        };
        doc.addEventListener("mousemove", move); doc.addEventListener("mouseup", up);
    };
    const big = h || drag !== null;
    // anda liso entre uma atualizacao e outra; arrastando, segue o mouse na hora
    const glide = drag === null ? "width .25s linear, left .25s linear" : "none";
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: col.muted, fontVariantNumeric: "tabular-nums" }}>
            <span style={{ minWidth: 30, textAlign: "right" }}>{fmt(pos)}</span>
            <div ref={bar} onMouseDown={down} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} style={{ flex: 1, padding: "7px 0", cursor: t ? "pointer" : "default" }}>
                <div style={{ height: big ? 6 : 4, borderRadius: 3, background: col.line, position: "relative", transition: "height .12s ease" }}>
                    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: frac * 100 + "%", background: col.brand, borderRadius: 3, transition: glide }} />
                    {t && <div style={{ position: "absolute", left: frac * 100 + "%", top: "50%", width: 12, height: 12, margin: "-6px 0 0 -6px", borderRadius: 6, background: "#fff", transform: `scale(${big ? 1.15 : 0.9})`, transition: "transform .12s ease, " + glide }} />}
                </div>
            </div>
            <span style={{ minWidth: 30 }}>{dur > 0 ? fmt(dur) : "--:--"}</span>
        </div>
    );
}

export function Volume({ width }: { width: number; }) {
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <IconBtn title={S.muted ? "Ligar o som (so para voce)" : "Mutar (so para voce)"} onClick={() => setVolume(S.volume, !S.muted)}><Icon n={S.muted || S.volume === 0 ? "mudo" : "som"} size={16} /></IconBtn>
            <input
                type="range" min={0} max={100} step={1} value={S.muted ? 0 : Math.round(S.volume * 100)} title="Volume (so para voce)"
                onChange={e => setVolume(Number(e.currentTarget.value) / 100, false)}
                style={{ width, accentColor: "#5865f2", cursor: "pointer" }}
            />
        </div>
    );
}

export function Controls({ b, small }: { b: Bound; small?: boolean; }) {
    const s = b.sync.state;
    const [h, setH] = useState(false);
    const loopNext: Record<LoopMode, LoopMode> = { off: "all", all: "one", one: "off" };
    const loopText: Record<LoopMode, string> = { off: "Repetir: desligado", all: "Repetir: a fila toda", one: "Repetir: so esta musica" };
    const big = small ? 30 : 34;
    return (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: small ? 2 : 8 }}>
            {!small && <IconBtn title="Voltar 10 segundos" onClick={() => b.sync.do({ t: "nudge", by: -10 })}><Icon n="voltar" size={17} /><span style={{ position: "absolute", fontSize: 7, fontWeight: 700, marginTop: 1 }}>10</span></IconBtn>}
            {!small && <IconBtn title="Voltar ao comeco da musica" onClick={() => b.sync.do({ t: "restart" })}><Icon n="anterior" size={17} /></IconBtn>}
            <button
                className="pdl-b" title={s.playing ? "Pausar para todos" : "Tocar para todos"} aria-label={s.playing ? "Pausar" : "Tocar"}
                onClick={e => { e.stopPropagation(); b.sync.do({ t: s.playing ? "pause" : "play" }); }}
                onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
                style={{ all: "unset", cursor: "pointer", width: big, height: big, borderRadius: big / 2, background: "#fff", color: "#111214", display: "flex", alignItems: "center", justifyContent: "center", flex: "none", transform: h ? "scale(1.08)" : "none", transition: "transform .12s ease" }}
            ><span key={String(s.playing)} className="pdl-pop" style={{ display: "flex" }}><PlayIcon playing={s.playing} size={small ? 13 : 15} /></span></button>
            <IconBtn title="Proxima" onClick={() => b.sync.do({ t: "next" })}><Icon n="proxima" size={17} /></IconBtn>
            {!small && <IconBtn title={loopText[s.loop]} active={s.loop !== "off"} onClick={() => b.sync.do({ t: "loop", mode: loopNext[s.loop] })}><Icon n="repetir" size={17} />{s.loop === "one" && <span style={{ position: "absolute", fontSize: 8, fontWeight: 700 }}>1</span>}</IconBtn>}
        </div>
    );
}

export function Avatars() {
    const [show, setShow] = useState(false);
    const list = S.listeners;
    if (!list.length) return null;
    const url = (id: string) => { try { return (UserStore.getUser(id) as any)?.getAvatarURL?.(undefined, 32) ?? ""; } catch { return ""; } };
    const Face = ({ id, size, ml }: { id: string; size: number; ml?: number; }) => (
        <img src={url(id)} draggable={false} style={{ width: size, height: size, borderRadius: size / 2, marginLeft: ml ?? 0, border: `2px solid ${col.bg}`, background: col.hover, objectFit: "cover", flex: "none" }} />
    );
    return (
        <div onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)} style={{ position: "relative", display: "flex", alignItems: "center", paddingLeft: 6, flex: "none" }}>
            {list.slice(0, 4).map(p => <Face key={p.id} id={p.id} size={22} ml={-6} />)}
            {list.length > 4 && <span style={{ fontSize: 11, color: col.muted, marginLeft: 4 }}>+{list.length - 4}</span>}
            {show && (
                <div className="pdl-view" style={{ position: "absolute", right: 0, top: "100%", paddingTop: 6, zIndex: 5 }}>
                    <div style={{ background: "#0b0c0d", borderRadius: 8, padding: "10px 12px", minWidth: 170, boxShadow: "0 6px 22px rgba(0,0,0,.5)" }}>
                        <div style={{ fontSize: 12, color: col.muted, marginBottom: 6 }}>Ouvindo - {list.length}</div>
                        {list.map(p => (
                            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 13, color: col.text, whiteSpace: "nowrap" }}><Face id={p.id} size={20} />{p.name}</div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
