/*
 * pdLink - musica na chamada: botao de fone ao lado do clipe e a janela do player, presa na area da chamada.
 * Larga: abas + lista + barra embaixo. Estreita: modo compacto.
 */

import { React, ReactDOM, useEffect, useRef, useState } from "@webpack/common";

import { currentTrack, Track } from "./musicCore";
import type { Found } from "./musicNative";
import { Avatars, col, Controls, Cover, EASE, ellipsis, ensureCss, fmt, Grip, Heart, Icon, IconBtn, SeekBar, Volume, Wave } from "./musicParts";
import { addLocalFiles, Bound, emit, isLocal, plain, removeLocal, runSearch, S, sameLocal, saveLists, setView, subs, toTrack, View } from "./musicState";

export { setListeners, startMusic, stopMusic } from "./musicState";

function useMusic() {
    const [, force] = useState(0);
    useEffect(() => {
        const f = () => force(n => n + 1);
        subs.add(f);
        return () => { subs.delete(f); };
    }, []);
}

const Label = ({ children }: { children: React.ReactNode; }) => <div style={{ fontSize: 11, fontWeight: 600, color: col.muted, padding: "6px 6px 4px" }}>{children}</div>;
const Empty = ({ children }: { children: React.ReactNode; }) => <div style={{ padding: 24, textAlign: "center", color: col.muted, fontSize: 13 }}>{children}</div>;
const rowBase: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderRadius: 6, transition: EASE };

function QueueRow({ b, t, i, compact, over, setOver }: { b: Bound; t: Track; i: number; compact: boolean; over: number | null; setOver: (n: number | null) => void; }) {
    const [h, setH] = useState(false);
    const s = b.sync.state;
    const cur = i === 0;
    const by = b.nameOf(t.by);
    return (
        <div
            className="pdl-row"
            draggable={!cur}
            onDragStart={e => { e.dataTransfer.setData("text/pdlink-track", t.id); e.dataTransfer.effectAllowed = "move"; }}
            onDragOver={e => { if (!cur && e.dataTransfer.types.includes("text/pdlink-track")) { e.preventDefault(); e.stopPropagation(); if (over !== i) setOver(i); } }}
            onDrop={e => {
                const id = e.dataTransfer.getData("text/pdlink-track");
                e.preventDefault(); e.stopPropagation(); setOver(null);
                if (id && id !== t.id) b.sync.do({ t: "move", id, to: i });
            }}
            onDragEnd={() => setOver(null)}
            onDoubleClick={() => { if (!cur) b.sync.do({ t: "jump", id: t.id }); }}
            onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
            title={cur ? undefined : "Arraste para mudar a posicao. Dois cliques para tocar agora."}
            style={{ ...rowBase, background: cur ? col.hover : h ? "rgba(255,255,255,.05)" : "transparent", boxShadow: over === i ? "inset 0 2px 0 #5865f2" : "none", userSelect: "none" }}
        >
            {cur ? <Wave moving={s.playing && !s.wait} /> : <Grip />}
            {!compact && <Cover img={t.img} size={30} />}
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: cur ? col.strong : col.text, fontSize: 13, fontWeight: cur ? 600 : 400, ...ellipsis }}>{t.title}</div>
                <div style={{ color: col.muted, fontSize: 11, ...ellipsis }}>{[isLocal(t) ? "Do PC" : t.artist, by && (isLocal(t) ? "de " : "por ") + by].filter(Boolean).join(" · ")}</div>
            </div>
            {h && !compact && <Heart f={t} />}
            <span style={{ color: col.muted, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{t.dur > 0 ? fmt(t.dur) : ""}</span>
            <div style={{ opacity: h ? 1 : 0, transition: "opacity .14s ease" }}><IconBtn size={24} title={cur ? "Tirar da fila (pula para a proxima)" : "Tirar da fila"} onClick={() => b.sync.do({ t: "remove", id: t.id })}><Icon n="x" size={14} /></IconBtn></div>
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
    return (
        <div>
            <Label>Tocando agora</Label>
            <QueueRow key={q[0].id} b={b} t={q[0]} i={0} compact={compact} over={over} setOver={setOver} />
            {q.length > 1 && <Label>A seguir - {q.length - 1}</Label>}
            {q.slice(1).map((t, i) => <QueueRow key={t.id} b={b} t={t} i={i + 1} compact={compact} over={over} setOver={setOver} />)}
        </div>
    );
}

function FoundRow({ b, f, onRemove }: { b: Bound; f: Found; onRemove?: () => void; }) {
    const [h, setH] = useState(false);
    const count = b.sync.state.queue.filter(t => (isLocal(f) ? sameLocal(t, f.ref.slice(3)) : t.ref === f.ref)).length;
    const add = (next?: boolean) => b.sync.do({ t: "add", tracks: [toTrack(f, b.myId)], next });
    return (
        <div onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} style={{ ...rowBase, background: h ? "rgba(255,255,255,.05)" : "transparent" }}>
            <Cover img={f.img} size={30} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: col.text, fontSize: 13, ...ellipsis }}>{f.title}</div>
                <div style={{ color: count ? col.green : col.muted, fontSize: 11, transition: "color .2s ease", ...ellipsis }}>{count ? (count > 1 ? `Na fila ${count} vezes` : "Na fila") + (f.artist ? " · " + f.artist : "") : f.artist}</div>
            </div>
            <span style={{ color: col.muted, fontSize: 11 }}>{f.dur > 0 ? fmt(f.dur) : ""}</span>
            <Heart f={f} />
            <IconBtn size={24} title="Tocar em seguida" onClick={() => add(true)}><Icon n="proxima" size={14} /></IconBtn>
            <IconBtn size={24} title={count ? "Ja esta na fila. Clique para adicionar de novo" : "Adicionar no fim da fila"} color={count ? col.green : undefined} onClick={() => add()}><span key={count} className={count ? "pdl-pop" : undefined} style={{ display: "flex" }}><Icon n={count ? "certo" : "mais"} size={15} /></span></IconBtn>
            {onRemove && <IconBtn size={24} title="Tirar desta lista" onClick={onRemove}><Icon n="x" size={14} /></IconBtn>}
        </div>
    );
}

const pill: React.CSSProperties = { all: "unset", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: "5px 12px", borderRadius: 6, whiteSpace: "nowrap", transition: EASE };

/** Botao que vira um campo de nome: salva essas musicas como playlist (no seu PC). */
function SaveAs({ items }: { items: Found[]; }) {
    const [name, setName] = useState<string | null>(null);
    if (name === null) return <button className="pdl-b" onClick={() => setName("")} style={{ ...pill, color: col.text, background: col.hover }}>Salvar como playlist</button>;
    const save = () => {
        const n = name.trim().slice(0, 60);
        if (!n) return;
        S.playlists = [{ name: n, items: items.filter(f => !isLocal(f)).map(plain).slice(0, 500) }, ...S.playlists.filter(p => p.name !== n)];
        setName(null); S.openList = 0; S.view = "playlists"; saveLists();
    };
    return (
        <input
            autoFocus value={name} placeholder="Nome da playlist, depois Enter" spellCheck={false}
            onChange={e => setName(e.currentTarget.value)} onBlur={() => { if (!name.trim()) setName(null); }}
            onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") save(); if (e.key === "Escape") setName(null); }}
            style={{ all: "unset", fontSize: 12, color: col.text, background: col.hover, padding: "5px 10px", borderRadius: 6, width: 190 }}
        />
    );
}

const addAll = (b: Bound, items: Found[]) => b.sync.do({ t: "add", tracks: items.map(f => toTrack(f, b.myId)) });

function Results({ b, items, empty, bulk, onRemove }: { b: Bound; items: Found[]; empty: string; bulk?: boolean; onRemove?: (f: Found) => void; }) {
    if (!items.length) return <Empty>{empty}</Empty>;
    return (
        <div>
            {bulk && items.length > 1 && (
                <div style={{ display: "flex", gap: 8, padding: "2px 6px 8px", flexWrap: "wrap" }}>
                    <button className="pdl-b" onClick={() => addAll(b, items)} style={{ ...pill, color: "#fff", background: col.brand }}>Adicionar as {items.length} na fila</button>
                    <SaveAs items={items} />
                </div>
            )}
            {items.map((f, i) => <FoundRow key={f.ref + i} b={b} f={f} onRemove={onRemove && (() => onRemove(f))} />)}
        </div>
    );
}

function Playlists({ b }: { b: Bound; }) {
    const p = S.playlists[S.openList];
    if (p) {
        return (
            <div className="pdl-view">
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 2px 4px" }}>
                    <IconBtn size={26} title="Voltar para as playlists" onClick={() => { S.openList = -1; emit(); }}><Icon n="seta" size={15} /></IconBtn>
                    <div style={{ flex: 1, minWidth: 0, fontWeight: 600, color: col.strong, ...ellipsis }}>{p.name}</div>
                    {p.items.length > 0 && <button className="pdl-b" onClick={() => addAll(b, p.items)} style={{ ...pill, color: "#fff", background: col.brand }}>Adicionar as {p.items.length} na fila</button>}
                </div>
                <Results b={b} items={p.items} empty="Esta playlist esta vazia." onRemove={f => { p.items = p.items.filter(x => x !== f); saveLists(); }} />
            </div>
        );
    }
    const q = b.sync.state.queue;
    return (
        <div>
            {q.length > 0 && <div style={{ padding: "2px 6px 8px" }}><SaveAs items={q} /></div>}
            {!S.playlists.length && <Empty>Salve a fila atual, as curtidas ou um link de playlist do YouTube. As playlists ficam guardadas no seu PC.</Empty>}
            {S.playlists.map((pl, i) => <ListRow key={pl.name} name={pl.name} count={pl.items.length} img={pl.items[0]?.img ?? ""} onOpen={() => { S.openList = i; emit(); }} onDelete={() => { S.playlists = S.playlists.filter(x => x !== pl); saveLists(); }} />)}
        </div>
    );
}

function ListRow({ name, count, img, onOpen, onDelete }: { name: string; count: number; img: string; onOpen: () => void; onDelete: () => void; }) {
    const [h, setH] = useState(false);
    return (
        <div className="pdl-row" onClick={onOpen} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} style={{ ...rowBase, padding: 6, cursor: "pointer", background: h ? "rgba(255,255,255,.05)" : "transparent" }}>
            <Cover img={img} size={30} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: col.text, fontSize: 13, ...ellipsis }}>{name}</div>
                <div style={{ color: col.muted, fontSize: 11 }}>{count} {count === 1 ? "musica" : "musicas"}</div>
            </div>
            <IconBtn size={24} title="Apagar esta playlist" onClick={onDelete}><Icon n="lixo" size={14} /></IconBtn>
        </div>
    );
}

/** Aba "Do PC": arquivos de musica deste PC. O arquivo fica aqui; a chamada ouve o som transmitido por mim. */
function LocalFiles({ b }: { b: Bound; }) {
    const input = useRef<HTMLInputElement>(null);
    const [drag, setDrag] = useState(false);
    const [busy, setBusy] = useState(false);
    const add = async (list: FileList | null) => {
        if (!list?.length || busy) return;
        setBusy(true);
        try { await addLocalFiles(Array.from(list)); } finally { setBusy(false); }
    };
    return (
        <div>
            <div
                onClick={() => input.current?.click()}
                onDragOver={e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDrag(true); } }}
                onDragLeave={() => setDrag(false)}
                onDrop={e => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
                style={{ margin: "2px 4px 8px", padding: "14px 12px", borderRadius: 8, border: `1.5px dashed ${drag ? "#5865f2" : col.line}`, background: drag ? "rgba(88,101,242,.12)" : "transparent", textAlign: "center", cursor: "pointer", transition: "background .15s ease, border-color .15s ease" }}
            >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: col.strong, fontWeight: 600, fontSize: 13 }}>
                    <Icon n={busy ? "girando" : "pasta"} size={16} spin={busy} />{busy ? "Abrindo..." : "Escolher musicas do PC ou arrastar aqui"}
                </div>
                <div style={{ color: col.muted, fontSize: 11, marginTop: 4 }}>O arquivo fica no seu PC. A chamada so ouve, transmitido por voce, e o som para se voce sair da chamada.</div>
                <input ref={input} type="file" multiple accept="audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.webm" style={{ display: "none" }} onChange={e => { add(e.currentTarget.files); e.currentTarget.value = ""; }} />
            </div>
            {S.localError && <div style={{ color: col.red, fontSize: 12, padding: "0 6px 6px" }}>{S.localError}</div>}
            {S.locals.length > 1 && <div style={{ padding: "0 6px 8px" }}><button className="pdl-b" onClick={() => addAll(b, S.locals.map(l => l.found))} style={{ ...pill, color: "#fff", background: col.brand }}>Adicionar as {S.locals.length} na fila</button></div>}
            {S.locals.map(l => <FoundRow key={l.key} b={b} f={l.found} onRemove={() => removeLocal(l.key)} />)}
        </div>
    );
}

function SearchBox({ b, compact }: { b: Bound; compact?: boolean; }) {
    const [q, setQ] = useState("");
    const [focus, setFocus] = useState(false);
    return (
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, background: col.card, borderRadius: 6, padding: "0 10px", height: 32, color: focus ? col.text : col.muted, boxShadow: focus ? "0 0 0 1px #5865f2" : "0 0 0 1px transparent", transition: "box-shadow .15s ease, color .15s ease" }}>
            <Icon n={S.search.busy ? "girando" : compact ? "mais" : "busca"} size={15} spin={S.search.busy} />
            <input
                value={q} placeholder={S.search.busy ? "Buscando..." : "Buscar ou colar um link"} spellCheck={false}
                onChange={e => setQ(e.currentTarget.value)} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
                onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") { runSearch(b, q); setQ(""); } }}
                onPaste={e => { const text = e.clipboardData.getData("text").trim(); if (/^https?:\/\/\S+$/i.test(text)) { e.preventDefault(); runSearch(b, text); setQ(""); } }}
                style={{ all: "unset", flex: 1, minWidth: 0, color: col.text, fontSize: 13 }}
            />
        </div>
    );
}

const loading = (b: Bound) => !!currentTrack(b.sync.state) && (b.sync.state.wait || b.player.status === "carregando");

function NowLine({ b }: { b: Bound; }) {
    const t = currentTrack(b.sync.state);
    const st = b.player.status;
    const err = st.startsWith("erro");
    return (
        <div key={t?.id ?? ""} className="pdl-view" style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: col.strong, fontSize: 13, fontWeight: 600, ...ellipsis }}>{t ? t.title : "Nada tocando"}</div>
            <div title={st} style={{ color: err ? col.red : col.muted, fontSize: 11, ...ellipsis }}>
                {err ? "Nao consegui tocar: " + st.slice(6) : loading(b) ? "Carregando..." : t ? t.artist : "A fila esta vazia"}
            </div>
        </div>
    );
}

const scroll: React.CSSProperties = { overflowY: "auto", minHeight: 0, flex: 1 };
const TABS: [View, string, string][] = [["fila", "fila", "Fila"], ["busca", "busca", "Busca"], ["pc", "pc", "Do PC"], ["historico", "historico", "Historico"], ["curtidas", "coracao", "Curtidas"], ["playlists", "playlist", "Playlists"]];

function Tab({ v, icon, label, compact }: { v: View; icon: string; label: string; compact: boolean; }) {
    const [h, setH] = useState(false);
    const on = S.view === v;
    return (
        <button className="pdl-b" onClick={() => setView(v)} title={label} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: compact ? 6 : "6px 8px", borderRadius: 6, fontSize: 13, color: on || h ? col.strong : col.muted, background: on ? col.hover : h ? "rgba(255,255,255,.05)" : "transparent", transition: EASE }}>
            <Icon n={icon} size={16} />{!compact && label}
        </button>
    );
}

function Body({ b, compact, close }: { b: Bound; compact: boolean; close: () => void; }) {
    const t = currentTrack(b.sync.state);
    const v = S.view, se = S.search;
    const list = v === "fila" ? <Queue b={b} compact={compact} />
        : v === "busca" ? (se.busy ? <Empty>Buscando...</Empty> : se.error ? <Empty>{se.error}</Empty> : <Results b={b} items={se.items} empty="Digite o nome de uma musica ou cole um link la em cima." bulk={/^https?:/i.test(se.query)} />)
            : v === "pc" ? <LocalFiles b={b} />
            : v === "historico" ? <Results b={b} items={S.history} empty="As musicas que tocarem aparecem aqui." />
                : v === "curtidas" ? <Results b={b} items={S.liked} empty="Clique no coracao de uma musica para guardar aqui." bulk />
                    : <Playlists b={b} />;
    const tabs = TABS.map(([tv, icon, label]) => <Tab key={tv} v={tv} icon={icon} label={label} compact={compact} />);
    // a troca de aba entra com um fade
    const shown = <div key={v + (se.busy ? "b" : "")} className="pdl-view">{list}</div>;

    if (compact) {
        return (
            <>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 8px 6px 12px" }}>
                    <span style={{ fontWeight: 600, color: col.strong, fontSize: 13, flex: 1 }}>Musica</span>
                    <Avatars />
                    <IconBtn size={24} title="Fechar a janela (a musica continua)" onClick={close}><Icon n="x" size={14} /></IconBtn>
                </div>
                <div style={{ background: col.card, borderRadius: 8, padding: 10, margin: "0 10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Cover img={t?.img ?? ""} size={40} busy={loading(b)} />
                        <NowLine b={b} />
                        <Controls b={b} small />
                    </div>
                    <div style={{ marginTop: 4 }}><SeekBar b={b} /></div>
                </div>
                <div style={{ padding: "8px 10px 4px", display: "flex" }}><SearchBox b={b} compact /></div>
                <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "0 10px 4px" }}>{tabs}<div style={{ flex: 1 }} /><Volume width={70} /></div>
                <div style={{ ...scroll, padding: "0 6px 6px" }}>{shown}</div>
            </>
        );
    }
    return (
        <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 10px 10px 12px" }}>
                <SearchBox b={b} />
                <Avatars />
                <IconBtn size={26} title="Fechar a janela (a musica continua)" onClick={close}><Icon n="x" size={15} /></IconBtn>
            </div>
            <div style={{ display: "flex", gap: 10, padding: "0 12px", flex: 1, minHeight: 0 }}>
                <div style={{ width: 124, flex: "none", background: col.card, borderRadius: 8, padding: 6, display: "flex", flexDirection: "column", gap: 2 }}>{tabs}</div>
                <div style={{ flex: 1, minWidth: 0, background: col.card, borderRadius: 8, padding: 6, display: "flex", flexDirection: "column" }}>
                    <div style={scroll}>{shown}</div>
                </div>
            </div>
            <div style={{ margin: 12, marginTop: 10, background: col.card, borderRadius: 8, padding: "10px 12px", display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.5fr) minmax(0,1fr)", gap: 12, alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}><Cover img={t?.img ?? ""} size={40} busy={loading(b)} /><NowLine b={b} />{t && <Heart f={t} size={28} />}</div>
                <div><Controls b={b} /><SeekBar b={b} /></div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}><Volume width={90} /></div>
            </div>
        </>
    );
}

interface Rect { left: number; top: number; width: number; height: number; }

/** Onde a janela fica: presa na area da chamada, acima da barra de botoes. */
function dockRect(btn: HTMLElement): Rect {
    const win = btn.ownerDocument.defaultView ?? window;
    const b = btn.getBoundingClientRect();
    // a area da chamada e o primeiro "pai" do botao que e grande de verdade
    let area: Rect = { left: 0, top: 0, width: win.innerWidth, height: win.innerHeight };
    for (let el = btn.parentElement; el; el = el.parentElement) {
        const r = el.getBoundingClientRect();
        if (r.height >= 240 && r.width >= 400) { area = r; break; }
    }
    const width = Math.round(Math.min(area.width - 24, 940));
    const roomTop = area.top + 44, roomBottom = b.top - 14;
    const height = Math.round(Math.max(280, Math.min(roomBottom - roomTop, 620)));
    return { left: Math.round(area.left + (area.width - width) / 2), top: Math.round(Math.max(4, roomBottom - height)), width, height };
}

function Window({ anchor, target, closing, close }: { anchor: HTMLElement; target: HTMLElement; closing: boolean; close: () => void; }) {
    useMusic();
    const [r, setR] = useState<Rect>(() => dockRect(anchor));
    useEffect(() => {
        const win = anchor.ownerDocument.defaultView ?? window;
        const f = () => { if (!anchor.isConnected) return; const n = dockRect(anchor); setR(o => (o.left === n.left && o.top === n.top && o.width === n.width && o.height === n.height ? o : n)); };
        const t = setInterval(f, 400);
        win.addEventListener("resize", f);
        return () => { clearInterval(t); win.removeEventListener("resize", f); };
    }, [anchor]);
    const compact = r.width < 560;
    return ReactDOM.createPortal(
        <div
            className={"pdl-win" + (closing ? " pdl-closing" : "")}
            onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()}
            style={{
                position: "fixed", left: r.left, top: r.top, width: r.width, height: r.height, zIndex: 1050, display: "flex", flexDirection: "column", transformOrigin: "50% 100%",
                background: col.bg, color: col.text, borderRadius: 12, boxShadow: "0 10px 40px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.06)", overflow: "hidden",
                fontFamily: "var(--font-primary, 'Segoe UI', sans-serif)", fontSize: 13, lineHeight: 1.35, WebkitAppRegion: "no-drag"
            } as any}
        >
            {S.bound ? <Body b={S.bound} compact={compact} close={close} /> : <Empty>Entre numa chamada para ouvir musica com a galera.</Empty>}
        </div>,
        target
    );
}

/** Botao de fone na barra da chamada, ao lado do clipe. */
export function MusicButton() {
    useMusic();
    const btn = useRef<HTMLButtonElement>(null);
    const [, tick] = useState(0);
    const [closing, setClosing] = useState(false);
    const [h, setH] = useState(false);
    useEffect(() => {
        const doc = btn.current?.ownerDocument;
        if (!doc) return;
        ensureCss(doc);
        const f = () => tick(n => n + 1);
        doc.addEventListener("fullscreenchange", f);
        tick(n => n + 1);
        return () => doc.removeEventListener("fullscreenchange", f);
    }, []);
    const doc = btn.current?.ownerDocument;
    const fs = doc?.fullscreenElement as HTMLElement | null | undefined;
    const target: HTMLElement | null = doc ? (fs && btn.current && fs.contains(btn.current) ? fs : doc.body) : null;
    const playing = !!S.bound?.sync.state.playing;
    const setOpen = (v: boolean) => {
        if (v) { setClosing(false); S.open = true; emit(); return; }
        // fecha com uma saida curta em vez de sumir de uma vez
        setClosing(true);
        setTimeout(() => { S.open = false; setClosing(false); emit(); }, 140);
    };
    const on = S.open && !closing;
    return (
        <div style={{ display: "flex", alignItems: "center", marginRight: 8 }}>
            <div style={{ position: "relative", display: "flex", alignItems: "center", padding: 4, borderRadius: 12, background: "var(--background-base-lowest, rgba(30,31,34,.9))" }}>
                <button
                    ref={btn} className="pdl-b"
                    title="Musica na chamada (pdLink)" aria-label="Musica na chamada"
                    onClick={e => { e.stopPropagation(); setOpen(!on); }}
                    onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
                    style={{ all: "unset", cursor: "pointer", width: 40, height: 40, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: on || h ? "#fff" : "var(--interactive-normal, #b5bac1)", background: on ? col.brand : h ? "rgba(255,255,255,.08)" : "transparent", transition: EASE }}
                ><Icon n="fone" size={22} /></button>
                {playing && !S.open && <span className="pdl-pop" style={{ position: "absolute", top: 2, right: 2, width: 10, height: 10, borderRadius: 5, background: col.green, border: "2px solid #1e1f22" }} />}
            </div>
            {S.open && target && btn.current && <Window anchor={btn.current} target={target} closing={closing} close={() => setOpen(false)} />}
        </div>
    );
}
