/*
 * pdLink - musica na chamada: botao de fone ao lado do clipe e a janela do player.
 * Tela grande: fila + abas + barra embaixo. Janela pequena: modo compacto.
 */

import * as DataStore from "@api/DataStore";
import { PluginNative } from "@utils/types";
import { React, ReactDOM, UserStore, useEffect, useRef, useState } from "@webpack/common";

import { plog } from "./logger";
import { currentTrack, LoopMode, MusicSync, Track } from "./musicCore";
import { MusicPlayer } from "./musicPlayer";
import type { Found } from "./musicNative";
import type { Hub } from "./p2p";

const Native = VencordNative.pluginHelpers.pdLink as PluginNative<typeof import("./native")>;
const hasNative = () => typeof (Native as any)?.musicFetch === "function";

export interface Listener { id: string; name: string; }

interface Bound { sync: MusicSync; player: MusicPlayer; myId: string; nameOf: (id: string) => string; }
let bound: Bound | null = null;
let listeners: Listener[] = [];
let open = false;
let volume = 0.6;
let muted = false;
let clockOffset = 0;
let clockAt = 0;
let history: Found[] = [];
let lastCur = "";
const subs = new Set<() => void>();
const emit = () => subs.forEach(f => f());

const HISTORY_KEY = "pdLink_musicHistory";
const PREFS_KEY = "pdLink_musicPrefs";
DataStore.get(HISTORY_KEY).then(v => { if (Array.isArray(v)) { history = v.slice(0, 200); emit(); } }).catch(() => { });
DataStore.get(PREFS_KEY).then(v => { if (v && typeof v.volume === "number") { volume = v.volume; muted = !!v.muted; applyVolume(); emit(); } }).catch(() => { });

function applyVolume() {
    // curva mais suave: o ouvido nao percebe volume em linha reta
    bound?.player.setVolume(volume * volume);
    bound?.player.setMuted(muted);
}
function setVolume(v: number, m = muted) {
    volume = Math.max(0, Math.min(1, v)); muted = m;
    applyVolume(); emit();
    DataStore.set(PREFS_KEY, { volume, muted }).catch(() => { });
}

const now = () => Date.now() + clockOffset;

async function measureClock() {
    if (!hasNative() || Date.now() - clockAt < 30 * 60 * 1000) return;
    try {
        const r = await Native.musicClock();
        if (r?.ok) { clockOffset = r.offset; clockAt = Date.now(); }
    } catch { }
}

async function loadTrack(t: Track) {
    if (!hasNative()) throw new Error("feche e abra o Discord para ativar a musica");
    const r = await Native.musicFetch(t.ref);
    if (!r.ok) throw new Error(r.error);
    return URL.createObjectURL(new Blob([r.data as any], { type: r.mime }));
}

function remember(t: Track) {
    history = [{ src: t.src, ref: t.ref, title: t.title, artist: t.artist, dur: t.dur, img: t.img }, ...history.filter(h => h.ref !== t.ref)].slice(0, 200);
    DataStore.set(HISTORY_KEY, history).catch(() => { });
}

/** Liga a musica a chamada atual. */
export async function startMusic(hub: Hub, myId: string, nameOf: (id: string) => string) {
    stopMusic();
    await measureClock();
    const sync = new MusicSync(myId, now, { publish: (text, keep) => hub.publishMusic(text, keep) });
    const player = new MusicPlayer(sync, now, loadTrack);
    hub.onMusic = text => sync.receive(text);
    sync.onChange = s => {
        if (s.cur !== lastCur) {
            lastCur = s.cur;
            const t = currentTrack(s);
            if (t) { remember(t); plog(`musica: tocando "${t.title}"`); }
        }
        emit();
    };
    player.onStatus = () => { if (player.status) plog("musica: " + player.status); emit(); };
    bound = { sync, player, myId, nameOf };
    applyVolume();
    emit();
    // relogio: confere de novo de vez em quando (o do PC anda um pouco)
    setTimeout(() => { clockAt = 0; if (bound?.sync === sync) measureClock(); }, 30 * 60 * 1000);
}

export function stopMusic() {
    if (!bound) return;
    bound.player.stop();
    bound.sync.stop();
    bound = null;
    lastCur = "";
    listeners = [];
    emit();
}

/** Quem esta na chamada com o mod (ouve a musica junto). */
export function setListeners(list: Listener[]) { listeners = list; emit(); }

function useMusic() {
    const [, force] = useState(0);
    useEffect(() => {
        const f = () => force(n => n + 1);
        subs.add(f);
        return () => { subs.delete(f); };
    }, []);
}

// ------------------------------------------------------------------ interface

const col = {
    bg: "#111214",
    card: "#1e1f22",
    hover: "#2b2d31",
    text: "#dbdee1",
    strong: "#ffffff",
    muted: "#949ba4",
    line: "#3f4147",
    brand: "var(--brand-500, #5865f2)",
    red: "#f23f43"
};

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
    mais: "M12 5v14M5 12h14"
};
const Icon = ({ n, size = 18 }: { n: string; size?: number; }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", display: "block" }}><path d={PATHS[n]} /></svg>
);
const PlayIcon = ({ playing, size = 16 }: { playing: boolean; size?: number; }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ display: "block" }}><path d={playing ? "M6 4h4v16H6zM14 4h4v16h-4z" : "M7 3l14 9-14 9V3z"} /></svg>
);
const Grip = () => (
    <svg width={12} height={18} viewBox="0 0 12 18" fill="currentColor" style={{ flex: "none", color: col.muted, cursor: "grab" }}>
        {[3, 9, 15].map(y => [3, 9].map(x => <circle key={x + "-" + y} cx={x} cy={y} r={1.5} />))}
    </svg>
);

const fmt = (s: number) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
const rid = () => Math.random().toString(36).slice(2, 12);
const toTrack = (f: Found, by: string): Track => ({ id: rid(), src: f.src, ref: f.ref, title: f.title, artist: f.artist, dur: f.dur, by, img: f.img });

function IconBtn({ children, onClick, title, active, size = 30 }: { children: React.ReactNode; onClick: () => void; title: string; active?: boolean; size?: number; }) {
    const [h, setH] = useState(false);
    return (
        <button
            title={title} aria-label={title}
            onClick={e => { e.stopPropagation(); onClick(); }}
            onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
            style={{ all: "unset", cursor: "pointer", width: size, height: size, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", position: "relative", flex: "none", color: active ? col.brand : h ? col.strong : col.text, background: h ? "rgba(255,255,255,.06)" : "transparent" }}
        >{children}</button>
    );
}

function Cover({ img, size }: { img: string; size: number; }) {
    const [bad, setBad] = useState(false);
    return (
        <div style={{ width: size, height: size, borderRadius: Math.max(4, size / 9), background: col.hover, flex: "none", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", color: col.muted }}>
            {img && !bad ? <img src={img} onError={() => setBad(true)} draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Icon n="fone" size={Math.round(size * 0.5)} />}
        </div>
    );
}

/** Faixa de tempo: clicar ou arrastar muda o ponto da musica para todos. */
function SeekBar({ b }: { b: Bound; }) {
    const [, tick] = useState(0);
    const [drag, setDrag] = useState<number | null>(null);
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
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: col.muted, fontVariantNumeric: "tabular-nums" }}>
            <span style={{ minWidth: 30, textAlign: "right" }}>{fmt(pos)}</span>
            <div ref={bar} onMouseDown={down} style={{ flex: 1, padding: "7px 0", cursor: t ? "pointer" : "default" }}>
                <div style={{ height: 4, borderRadius: 2, background: col.line, position: "relative" }}>
                    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: frac * 100 + "%", background: col.brand, borderRadius: 2 }} />
                    {t && <div style={{ position: "absolute", left: frac * 100 + "%", top: -4, width: 12, height: 12, marginLeft: -6, borderRadius: 6, background: "#fff" }} />}
                </div>
            </div>
            <span style={{ minWidth: 30 }}>{dur > 0 ? fmt(dur) : "--:--"}</span>
        </div>
    );
}

function Volume({ width }: { width: number; }) {
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <IconBtn title={muted ? "Ligar o som (so para voce)" : "Mutar (so para voce)"} onClick={() => setVolume(volume, !muted)}><Icon n={muted || volume === 0 ? "mudo" : "som"} size={16} /></IconBtn>
            <input
                type="range" min={0} max={100} step={1} value={muted ? 0 : Math.round(volume * 100)} title="Volume (so para voce)"
                onChange={e => setVolume(Number(e.currentTarget.value) / 100, false)}
                style={{ width, accentColor: "#5865f2", cursor: "pointer" }}
            />
        </div>
    );
}

function Controls({ b, small }: { b: Bound; small?: boolean; }) {
    const s = b.sync.state;
    const loopNext: Record<LoopMode, LoopMode> = { off: "all", all: "one", one: "off" };
    const loopText: Record<LoopMode, string> = { off: "Repetir: desligado", all: "Repetir: a fila toda", one: "Repetir: so esta musica" };
    const big = small ? 30 : 34;
    return (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: small ? 2 : 8 }}>
            {!small && <IconBtn title="Voltar 10 segundos" onClick={() => b.sync.do({ t: "nudge", by: -10 })}><Icon n="voltar" size={17} /><span style={{ position: "absolute", fontSize: 7, fontWeight: 700, marginTop: 1 }}>10</span></IconBtn>}
            {!small && <IconBtn title="Anterior" onClick={() => b.sync.do({ t: "prev" })}><Icon n="anterior" size={17} /></IconBtn>}
            <button
                title={s.playing ? "Pausar para todos" : "Tocar para todos"} aria-label={s.playing ? "Pausar" : "Tocar"}
                onClick={e => { e.stopPropagation(); b.sync.do({ t: s.playing ? "pause" : "play" }); }}
                style={{ all: "unset", cursor: "pointer", width: big, height: big, borderRadius: big / 2, background: "#fff", color: "#111214", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}
            ><PlayIcon playing={s.playing} size={small ? 13 : 15} /></button>
            <IconBtn title="Proxima" onClick={() => b.sync.do({ t: "next" })}><Icon n="proxima" size={17} /></IconBtn>
            {!small && <IconBtn title={loopText[s.loop]} active={s.loop !== "off"} onClick={() => b.sync.do({ t: "loop", mode: loopNext[s.loop] })}><Icon n="repetir" size={17} />{s.loop === "one" && <span style={{ position: "absolute", fontSize: 8, fontWeight: 700 }}>1</span>}</IconBtn>}
        </div>
    );
}

function Avatars() {
    const [show, setShow] = useState(false);
    const list = listeners;
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
                <div style={{ position: "absolute", right: 0, top: "100%", paddingTop: 6, zIndex: 5 }}>
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

function QueueRow({ b, t, i, compact, over, setOver }: { b: Bound; t: Track; i: number; compact: boolean; over: number | null; setOver: (n: number | null) => void; }) {
    const [h, setH] = useState(false);
    const cur = b.sync.state.cur === t.id;
    return (
        <div
            draggable
            onDragStart={e => { e.dataTransfer.setData("text/pdlink-track", t.id); e.dataTransfer.effectAllowed = "move"; }}
            onDragOver={e => { if (e.dataTransfer.types.includes("text/pdlink-track")) { e.preventDefault(); e.stopPropagation(); if (over !== i) setOver(i); } }}
            onDrop={e => {
                const id = e.dataTransfer.getData("text/pdlink-track");
                e.preventDefault(); e.stopPropagation(); setOver(null);
                if (id && id !== t.id) b.sync.do({ t: "move", id, to: i });
            }}
            onDragEnd={() => setOver(null)}
            onDoubleClick={() => b.sync.do({ t: "jump", id: t.id })}
            onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
            title="Arraste para mudar a posicao. Dois cliques para tocar agora."
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderRadius: 6, background: cur ? col.hover : h ? "rgba(255,255,255,.04)" : "transparent", boxShadow: over === i ? `inset 0 2px 0 ${"#5865f2"}` : "none", userSelect: "none" }}
        >
            <Grip />
            {!compact && <Cover img={t.img} size={30} />}
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: cur ? col.strong : col.text, fontSize: 13, fontWeight: cur ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</div>
                <div style={{ color: col.muted, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{[t.artist, b.nameOf(t.by) && "por " + b.nameOf(t.by)].filter(Boolean).join(" · ")}</div>
            </div>
            <span style={{ color: col.muted, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{t.dur > 0 ? fmt(t.dur) : ""}</span>
            <div style={{ visibility: h ? "visible" : "hidden" }}><IconBtn size={24} title="Tirar da fila" onClick={() => b.sync.do({ t: "remove", id: t.id })}><Icon n="x" size={14} /></IconBtn></div>
        </div>
    );
}

function Queue({ b, compact }: { b: Bound; compact: boolean; }) {
    const [over, setOver] = useState<number | null>(null);
    const q = b.sync.state.queue;
    if (!q.length) {
        return (
            <div style={{ padding: "28px 12px", textAlign: "center", color: col.muted, fontSize: 13 }}>
                <div style={{ color: col.text, fontWeight: 600, marginBottom: 4 }}>Coloque a primeira musica</div>
                Busque por nome ou cole um link do YouTube, SoundCloud ou Suno. Toca para todo mundo da chamada que tem o pdLink.
            </div>
        );
    }
    return <div>{q.map((t, i) => <QueueRow key={t.id} b={b} t={t} i={i} compact={compact} over={over} setOver={setOver} />)}</div>;
}

function FoundRow({ f, onAdd, onNext }: { f: Found; onAdd: () => void; onNext: () => void; }) {
    const [h, setH] = useState(false);
    return (
        <div onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} onDoubleClick={onAdd} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderRadius: 6, background: h ? "rgba(255,255,255,.04)" : "transparent" }}>
            <Cover img={f.img} size={30} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: col.text, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.title}</div>
                <div style={{ color: col.muted, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.artist}</div>
            </div>
            <span style={{ color: col.muted, fontSize: 11 }}>{f.dur > 0 ? fmt(f.dur) : ""}</span>
            <IconBtn size={24} title="Tocar em seguida" onClick={onNext}><Icon n="proxima" size={14} /></IconBtn>
            <IconBtn size={24} title="Adicionar no fim da fila" onClick={onAdd}><Icon n="mais" size={15} /></IconBtn>
        </div>
    );
}

type View = "fila" | "busca" | "historico";
interface SearchState { busy: boolean; error: string; items: Found[]; query: string; }

function useSearch(b: Bound, setView: (v: View) => void) {
    const [st, setSt] = useState<SearchState>({ busy: false, error: "", items: [], query: "" });
    const run = async (query: string) => {
        query = query.trim();
        if (!query || st.busy) return;
        if (!hasNative()) { setSt({ busy: false, error: "Feche e abra o Discord para ativar a musica.", items: [], query }); setView("busca"); return; }
        setSt({ busy: true, error: "", items: [], query }); setView("busca");
        const r = await Native.musicSearch(query);
        if (!r.ok) { setSt({ busy: false, error: r.error, items: [], query }); return; }
        const isUrl = /^https?:\/\//i.test(query);
        if (isUrl && r.items.length === 1 && !r.list) {
            // link de uma musica so: ja entra na fila
            b.sync.do({ t: "add", tracks: [toTrack(r.items[0], b.myId)] });
            setSt({ busy: false, error: "", items: [], query: "" }); setView("fila");
            return;
        }
        setSt({ busy: false, error: r.items.length ? "" : "Nao achei nada.", items: r.items, query });
    };
    return { st, run };
}

function SearchBox({ run, busy, compact }: { run: (q: string) => void; busy: boolean; compact?: boolean; }) {
    const [q, setQ] = useState("");
    return (
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, background: col.card, borderRadius: 6, padding: "0 10px", height: 32, color: col.muted }}>
            <Icon n={compact ? "mais" : "busca"} size={15} />
            <input
                value={q} placeholder={busy ? "Buscando..." : "Buscar ou colar um link"} spellCheck={false}
                onChange={e => setQ(e.currentTarget.value)}
                onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") { run(q); setQ(""); } }}
                onPaste={e => { const text = e.clipboardData.getData("text").trim(); if (/^https?:\/\/\S+$/i.test(text)) { e.preventDefault(); run(text); setQ(""); } }}
                style={{ all: "unset", flex: 1, minWidth: 0, color: col.text, fontSize: 13 }}
            />
        </div>
    );
}

function Results({ b, st, items, empty }: { b: Bound; st?: SearchState; items: Found[]; empty: string; }) {
    const add = (f: Found, next?: boolean) => b.sync.do({ t: "add", tracks: [toTrack(f, b.myId)], next });
    if (st?.busy) return <div style={{ padding: 24, textAlign: "center", color: col.muted, fontSize: 13 }}>Buscando...</div>;
    if (st?.error) return <div style={{ padding: 24, textAlign: "center", color: col.muted, fontSize: 13 }}>{st.error}</div>;
    if (!items.length) return <div style={{ padding: 24, textAlign: "center", color: col.muted, fontSize: 13 }}>{empty}</div>;
    return (
        <div>
            {st && items.length > 1 && /^https?:/i.test(st.query) && (
                <div style={{ padding: "2px 6px 8px" }}>
                    <button onClick={() => b.sync.do({ t: "add", tracks: items.map(f => toTrack(f, b.myId)) })} style={{ all: "unset", cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#fff", background: col.brand, padding: "5px 12px", borderRadius: 6 }}>Adicionar as {items.length} na fila</button>
                </div>
            )}
            {items.map((f, i) => <FoundRow key={f.ref + i} f={f} onAdd={() => add(f)} onNext={() => add(f, true)} />)}
        </div>
    );
}

function NowLine({ b }: { b: Bound; }) {
    const t = currentTrack(b.sync.state);
    const st = b.player.status;
    return (
        <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: col.strong, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t ? t.title : "Nada tocando"}</div>
            <div title={st} style={{ color: st.startsWith("erro") ? col.red : col.muted, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {st === "carregando" ? "Carregando..." : st.startsWith("erro") ? "Nao consegui tocar: " + st.slice(6) : t ? t.artist : "A fila esta vazia"}
            </div>
        </div>
    );
}

const scroll: React.CSSProperties = { overflowY: "auto", minHeight: 0, flex: 1, scrollbarWidth: "thin" };

function Body({ b, compact, close, dragProps }: { b: Bound; compact: boolean; close: () => void; dragProps: any; }) {
    const [view, setView] = useState<View>("fila");
    const { st, run } = useSearch(b, setView);
    const t = currentTrack(b.sync.state);
    const list = view === "fila" ? <Queue b={b} compact={compact} />
        : view === "busca" ? <Results b={b} st={st} items={st.items} empty="Digite o nome de uma musica." />
            : <Results b={b} items={history} empty="As musicas que tocarem aparecem aqui." />;
    const Tab = ({ v, icon, label }: { v: View; icon: string; label: string; }) => (
        <button onClick={() => setView(v)} title={label} style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, fontSize: 13, color: view === v ? col.strong : col.muted, background: view === v ? col.hover : "transparent" }}>
            <Icon n={icon} size={16} />{!compact && label}
        </button>
    );

    if (compact) {
        return (
            <>
                <div {...dragProps} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 8px 6px 12px", cursor: "move" }}>
                    <span style={{ fontWeight: 600, color: col.strong, fontSize: 13, flex: 1 }}>Musica</span>
                    <Avatars />
                    <IconBtn size={24} title="Fechar a janela (a musica continua)" onClick={close}><Icon n="x" size={14} /></IconBtn>
                </div>
                <div style={{ background: col.card, borderRadius: 8, padding: 10, margin: "0 10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Cover img={t?.img ?? ""} size={40} />
                        <NowLine b={b} />
                        <Controls b={b} small />
                    </div>
                    <div style={{ marginTop: 4 }}><SeekBar b={b} /></div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 10px 4px" }}>
                    <SearchBox run={run} busy={st.busy} compact />
                    <Tab v="fila" icon="fila" label="Fila" />
                    <Tab v="historico" icon="historico" label="Historico" />
                </div>
                <div style={{ ...scroll, padding: "0 6px" }}>{list}</div>
                <div style={{ padding: "2px 8px 6px" }}><Volume width={90} /></div>
            </>
        );
    }
    return (
        <>
            <div {...dragProps} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 10px 10px 12px", cursor: "move" }}>
                <div onMouseDown={e => e.stopPropagation()} style={{ flex: 1, minWidth: 0, display: "flex", cursor: "default" }}><SearchBox run={run} busy={st.busy} /></div>
                <Avatars />
                <IconBtn size={26} title="Fechar a janela (a musica continua)" onClick={close}><Icon n="x" size={15} /></IconBtn>
            </div>
            <div style={{ display: "flex", gap: 10, padding: "0 12px", flex: 1, minHeight: 0 }}>
                <div style={{ width: 120, flex: "none", background: col.card, borderRadius: 8, padding: 6, display: "flex", flexDirection: "column", gap: 2 }}>
                    <Tab v="fila" icon="fila" label="Fila" />
                    {(view === "busca" || st.items.length > 0) && <Tab v="busca" icon="busca" label="Busca" />}
                    <Tab v="historico" icon="historico" label="Historico" />
                </div>
                <div style={{ flex: 1, minWidth: 0, background: col.card, borderRadius: 8, padding: 6, display: "flex", flexDirection: "column" }}>
                    <div style={scroll}>{list}</div>
                </div>
            </div>
            <div style={{ margin: 12, marginTop: 10, background: col.card, borderRadius: 8, padding: "10px 12px", display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.5fr) minmax(0,1fr)", gap: 12, alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}><Cover img={t?.img ?? ""} size={40} /><NowLine b={b} /></div>
                <div><Controls b={b} /><SeekBar b={b} /></div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}><Volume width={90} /></div>
            </div>
        </>
    );
}

// posicao e tamanho da janela (ficam enquanto o Discord estiver aberto)
const frame = { x: -1, y: -1, w: 760, h: 470 };

function Window({ target, close }: { target: HTMLElement; close: () => void; }) {
    useMusic();
    const [, tick] = useState(0);
    const win = target.ownerDocument.defaultView ?? window;
    if (frame.x < 0) { frame.w = Math.min(frame.w, win.innerWidth - 40); frame.h = Math.min(frame.h, win.innerHeight - 120); frame.x = Math.round((win.innerWidth - frame.w) / 2); frame.y = Math.round((win.innerHeight - frame.h) / 2); }
    const clamp = () => {
        frame.w = Math.max(300, Math.min(frame.w, win.innerWidth)); frame.h = Math.max(300, Math.min(frame.h, win.innerHeight));
        frame.x = Math.max(60 - frame.w, Math.min(frame.x, win.innerWidth - 60)); frame.y = Math.max(0, Math.min(frame.y, win.innerHeight - 40));
    };
    const track = (e: React.MouseEvent, mode: "move" | "size") => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const sx = e.clientX, sy = e.clientY, f = { ...frame };
        const doc = target.ownerDocument;
        const move = (ev: MouseEvent) => {
            if (mode === "move") { frame.x = f.x + ev.clientX - sx; frame.y = f.y + ev.clientY - sy; }
            else { frame.w = f.w + ev.clientX - sx; frame.h = f.h + ev.clientY - sy; }
            clamp(); tick(n => n + 1);
        };
        const up = () => { doc.removeEventListener("mousemove", move); doc.removeEventListener("mouseup", up); };
        doc.addEventListener("mousemove", move); doc.addEventListener("mouseup", up);
    };
    clamp();
    const compact = frame.w < 540;
    return ReactDOM.createPortal(
        <div
            onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()}
            style={{
                position: "fixed", left: frame.x, top: frame.y, width: frame.w, height: frame.h, zIndex: 1050, display: "flex", flexDirection: "column",
                background: col.bg, color: col.text, borderRadius: 12, boxShadow: "0 10px 40px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.06)", overflow: "hidden",
                fontFamily: "var(--font-primary, 'Segoe UI', sans-serif)", fontSize: 13, lineHeight: 1.35, WebkitAppRegion: "no-drag"
            } as any}
        >
            {bound ? <Body b={bound} compact={compact} close={close} dragProps={{ onMouseDown: (e: React.MouseEvent) => track(e, "move") }} /> : (
                <div onMouseDown={e => track(e, "move")} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: col.muted, padding: 24, textAlign: "center", cursor: "move" }}>Entre numa chamada para ouvir musica com a galera.</div>
            )}
            <div onMouseDown={e => track(e, "size")} title="Arraste para mudar o tamanho" style={{ position: "absolute", right: 0, bottom: 0, width: 16, height: 16, cursor: "nwse-resize" }} />
        </div>,
        target
    );
}

/** Botao de fone na barra da chamada, ao lado do clipe. */
export function MusicButton() {
    useMusic();
    const btn = useRef<HTMLButtonElement>(null);
    const [, tick] = useState(0);
    useEffect(() => {
        const doc = btn.current?.ownerDocument;
        if (!doc) return;
        const f = () => tick(n => n + 1);
        doc.addEventListener("fullscreenchange", f);
        tick(n => n + 1);
        return () => doc.removeEventListener("fullscreenchange", f);
    }, []);
    const doc = btn.current?.ownerDocument;
    const fs = doc?.fullscreenElement as HTMLElement | null | undefined;
    const target: HTMLElement | null = doc ? (fs && btn.current && fs.contains(btn.current) ? fs : doc.body) : null;
    const playing = !!bound?.sync.state.playing;
    const setOpen = (v: boolean) => { open = v; emit(); };
    return (
        <div style={{ display: "flex", alignItems: "center", marginRight: 8 }}>
            <div style={{ position: "relative", display: "flex", alignItems: "center", padding: 4, borderRadius: 12, background: "var(--background-base-lowest, rgba(30,31,34,.9))" }}>
                <button
                    ref={btn}
                    title="Musica na chamada (pdLink)" aria-label="Musica na chamada"
                    onClick={e => { e.stopPropagation(); setOpen(!open); }}
                    style={{ all: "unset", cursor: "pointer", width: 40, height: 40, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: open ? "#fff" : "var(--interactive-normal, #b5bac1)", background: open ? col.brand : "transparent" }}
                ><Icon n="fone" size={22} /></button>
                {playing && !open && <span style={{ position: "absolute", top: 2, right: 2, width: 10, height: 10, borderRadius: 5, background: "#23a55a", border: "2px solid #1e1f22" }} />}
            </div>
            {open && target && <Window target={target} close={() => setOpen(false)} />}
        </div>
    );
}
