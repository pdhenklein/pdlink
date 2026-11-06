import { PluginNative } from "@utils/types";
import { React, ReactDOM, useEffect, useRef, useState } from "@webpack/common";

import type { FileOffer, ServeStatus, Sink } from "./fileXfer";
import type * as NativeTypes from "./native";
import type { Hub } from "./p2p";

// Envio de arquivos na chamada: botao na barra de controles do Discord, painel para enviar/receber e aviso.
// Os dados nao passam por servidor: quem baixa abre uma conexao direta com quem enviou (ver fileXfer.ts).

const Native = VencordNative.pluginHelpers.pdLink as PluginNative<typeof NativeTypes>;

export interface Peer { id: string; name: string; }

export interface Received {
    key: string;
    offer: FileOffer;
    fromId: string;
    fromName: string;
    at: number;
    seen: boolean;
    state: "new" | "connecting" | "downloading" | "done" | "error" | "cancelled";
    bytes: number;
    total: number;
    speed: number;
    path?: string;
    error?: string;
    cancel?: () => void;
}

export interface SentTo { name: string; state: ServeStatus["state"] | "waiting"; bytes: number; error?: string; }
export interface Sent { id: string; name: string; size: number; at: number; to: Record<string, SentTo>; }

export interface Binding {
    hub: Hub;
    myId: string;
    nameOf(userId: string): string;
}

let binding: Binding | null = null;
let peers: Peer[] = [];
let received: Received[] = [];
let sent: Sent[] = [];
let staged: File[] = [];
const deselected = new Set<string>();
let panelOpen = false;
let toast: { title: string; text: string; until: number; } | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach(f => f());

function nativeCall(name: string, ...args: any[]) {
    try { (Native as any)[name]?.(...args)?.catch?.(() => { }); } catch { }
}

export function fmtSize(n: number) {
    if (n < 1024) return n + " B";
    const u = ["KB", "MB", "GB", "TB"];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + " " + u[i];
}

// ------------------------------------------------------------------ estado

export function bindFiles(b: Binding | null) {
    if (binding && binding !== b) {
        for (const r of received) r.cancel?.();
        binding.hub.files.onServe = () => { };
    }
    binding = b;
    received = [];
    sent = [];
    staged = [];
    peers = [];
    deselected.clear();
    toast = null;
    if (b) {
        b.hub.files.onServe = (fileId, userId, st) => {
            const s = sent.find(x => x.id === fileId);
            const to = s?.to[userId];
            if (!s || !to) return;
            to.state = st.state;
            to.bytes = st.bytes;
            to.error = st.error;
            emit();
        };
    } else panelOpen = false;
    emit();
}

export function setPeers(list: Peer[]) {
    const same = list.length === peers.length && list.every((p, i) => p.id === peers[i].id && p.name === peers[i].name);
    if (same) return;
    peers = list;
    emit();
}

/** Alguem da chamada ofereceu um arquivo para mim. */
export function handleOffer(fromId: string, fromName: string, offer: FileOffer) {
    const key = fromId + ":" + offer.id;
    if (received.some(r => r.key === key)) return;
    received.unshift({ key, offer, fromId, fromName, at: Date.now(), seen: panelOpen, state: "new", bytes: 0, total: offer.size, speed: 0 });
    const title = `${fromName || "Alguem"} enviou um arquivo`;
    const text = `${offer.name} (${fmtSize(offer.size)})`;
    toast = { title, text, until: Date.now() + 7000 };
    // por cima do jogo: o aviso some sozinho e o arquivo fica no menu de arquivos do Discord
    nativeCall("overlayToast", title, text, 7000);
    emit();
}

function recipients() {
    return peers.filter(p => !deselected.has(p.id));
}

async function sendStaged() {
    const b = binding;
    const rec = recipients();
    if (!b || !staged.length || !rec.length) return;
    const files = staged;
    staged = [];
    emit();
    for (const f of files) {
        const offer = b.hub.files.offer(f, rec.map(r => r.id));
        if (!offer) continue;
        const to: Record<string, SentTo> = {};
        for (const r of rec) to[r.id] = { name: r.name, state: "waiting", bytes: 0 };
        sent.unshift({ id: offer.id, name: f.name, size: f.size, at: Date.now(), to });
        emit();
        await b.hub.sendFileOffer(rec.map(r => r.id), offer);
    }
}

function makeSink(fd: number): Sink {
    // junta pedacos pequenos antes de gravar (menos chamadas ao lado nativo)
    let buf: Uint8Array[] = [];
    let size = 0;
    const flush = async () => {
        if (!size) return;
        const all = new Uint8Array(size);
        let o = 0;
        for (const c of buf) { all.set(c, o); o += c.length; }
        buf = []; size = 0;
        await (Native as any).fileWrite(fd, all);
    };
    return {
        async write(c) {
            buf.push(c); size += c.length;
            if (size >= 1 << 20) await flush();
        },
        async close(ok) {
            if (ok) { try { await flush(); } catch { ok = false; } }
            await (Native as any).fileClose(fd, ok);
        }
    };
}

async function download(key: string) {
    const r = received.find(x => x.key === key);
    const b = binding;
    if (!r || !b || r.state === "connecting" || r.state === "downloading") return;
    if (typeof (Native as any).fileSaveDialog !== "function") {
        r.state = "error";
        r.error = "Feche e abra o Discord de novo para liberar o recebimento de arquivos.";
        emit();
        return;
    }
    const path: string | null = await (Native as any).fileSaveDialog(r.offer.name);
    if (!path) return; // cancelou a janela de salvar
    let fd: number;
    try { fd = await (Native as any).fileOpen(path); } catch (e) {
        r.state = "error"; r.error = "Nao consegui criar o arquivo: " + String(e); emit();
        return;
    }
    r.state = "connecting"; r.path = path; r.bytes = 0; r.speed = 0; r.error = undefined;
    emit();
    const h = b.hub.files.fetch(r.offer, b.myId, makeSink(fd), p => {
        r.state = p.state === "connecting" ? "connecting" : p.state === "downloading" ? "downloading" : p.state;
        r.bytes = p.bytes; r.total = p.total; r.speed = p.speed; r.error = p.error;
        emit();
    });
    r.cancel = h.cancel;
    h.done.catch(() => { });
}

function cancel(key: string) { received.find(x => x.key === key)?.cancel?.(); }
function dismiss(key: string) {
    const r = received.find(x => x.key === key);
    r?.cancel?.();
    received = received.filter(x => x.key !== key);
    emit();
}
function withdraw(id: string) {
    binding?.hub.files.withdraw(id);
    sent = sent.filter(x => x.id !== id);
    emit();
}
function reveal(path?: string) { if (path) nativeCall("fileReveal", path); }

function setOpen(v: boolean) {
    panelOpen = v;
    if (v) { for (const r of received) r.seen = true; toast = null; }
    emit();
}

function useFiles() {
    const [, force] = useState(0);
    useEffect(() => {
        const f = () => force(n => n + 1);
        subs.add(f);
        return () => { subs.delete(f); };
    }, []);
}

// ------------------------------------------------------------------ interface

const I = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "currentColor" } as const;
const ClipIcon = () => <svg {...I}><path d="M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5Z" /></svg>;
const FileIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 2h8l6 6v14H6V2Zm7 1.5V9h5.5L13 3.5Z" /></svg>;
const XIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z" /></svg>;

const col = {
    bg: "var(--background-base-lowest, #1e1f22)",
    card: "var(--background-base-lower, #2b2d31)",
    text: "var(--text-default, #dbdee1)",
    strong: "var(--text-strong, #ffffff)",
    muted: "var(--text-muted, #949ba4)",
    brand: "var(--brand-500, #5865f2)",
    green: "#23a55a",
    red: "#f23f43"
};

function SmallBtn({ children, onClick, kind = "primary", disabled, title }: { children: React.ReactNode; onClick: () => void; kind?: "primary" | "ghost" | "danger"; disabled?: boolean; title?: string; }) {
    const bg = kind === "primary" ? col.brand : kind === "danger" ? col.red : "transparent";
    return (
        <button
            title={title} disabled={disabled}
            onClick={e => { e.stopPropagation(); onClick(); }}
            style={{
                all: "unset", cursor: disabled ? "not-allowed" : "pointer", padding: "5px 12px", borderRadius: 6, fontSize: 13, fontWeight: 600,
                color: kind === "ghost" ? col.text : "#fff", background: bg, opacity: disabled ? 0.45 : 1,
                border: kind === "ghost" ? "1px solid rgba(255,255,255,.2)" : "none", whiteSpace: "nowrap"
            }}
        >{children}</button>
    );
}

function Bar({ value }: { value: number; }) {
    return (
        <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,.12)", overflow: "hidden", marginTop: 6 }}>
            <div style={{ height: "100%", width: Math.max(0, Math.min(100, value * 100)) + "%", background: col.brand, transition: "width .15s" }} />
        </div>
    );
}

function stateText(r: Received) {
    if (r.state === "connecting") return "Conectando...";
    if (r.state === "downloading") return `${fmtSize(r.bytes)} de ${fmtSize(r.total)}  ·  ${fmtSize(r.speed)}/s`;
    if (r.state === "done") return "Salvo";
    if (r.state === "cancelled") return "Cancelado";
    if (r.state === "error") return r.error || "Erro";
    return "";
}

function sentText(t: SentTo, size: number) {
    switch (t.state) {
        case "waiting": return "esperando baixar";
        case "connecting": return "conectando";
        case "sending": return `baixando ${Math.round((t.bytes / Math.max(1, size)) * 100)}%`;
        case "done": return "concluido";
        case "cancelled": return "cancelou";
        default: return t.error || "falhou";
    }
}

function Panel({ anchor, target }: { anchor: React.RefObject<HTMLElement | null>; target: HTMLElement; }) {
    useFiles();
    const input = useRef<HTMLInputElement>(null);
    const box = useRef<HTMLDivElement>(null);
    const [drag, setDrag] = useState(false);
    const r = anchor.current?.getBoundingClientRect();
    const doc = anchor.current?.ownerDocument;

    useEffect(() => {
        if (!doc) return;
        const down = (e: MouseEvent) => {
            const t = e.target as Node;
            if (box.current?.contains(t) || anchor.current?.contains(t)) return;
            setOpen(false);
        };
        const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        doc.addEventListener("mousedown", down, true);
        doc.addEventListener("keydown", key);
        return () => { doc.removeEventListener("mousedown", down, true); doc.removeEventListener("keydown", key); };
    }, []);

    if (!r) return null;
    const add = (list: FileList | File[] | null) => {
        if (!list) return;
        for (const f of Array.from(list)) if (f.size >= 0 && f.name) staged.push(f);
        emit();
    };
    const rec = recipients();
    const swallow = (e: React.SyntheticEvent) => e.stopPropagation();

    return ReactDOM.createPortal(
        <div
            ref={box} onClick={swallow} onMouseDown={swallow} onPointerDown={swallow} onContextMenu={swallow} onKeyDown={swallow}
            onDragOver={e => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); e.stopPropagation(); setDrag(false); add(e.dataTransfer.files); }}
            style={{
                position: "fixed", left: Math.max(8, Math.min(r.left, (doc!.defaultView?.innerWidth ?? 1200) - 388)), bottom: (doc!.defaultView?.innerHeight ?? 800) - r.top + 14,
                width: 380, maxHeight: "min(70vh, 640px)", overflowY: "auto", zIndex: 1100, background: col.bg, color: col.text, borderRadius: 12,
                boxShadow: "0 8px 30px rgba(0,0,0,.55)", padding: 14, fontFamily: "var(--font-primary, 'gg sans', 'Segoe UI', sans-serif)", fontSize: 14,
                outline: drag ? `2px dashed ${col.brand}` : "none"
            }}
        >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 16, color: col.strong }}>Arquivos</div>
                <span onClick={() => setOpen(false)} style={{ cursor: "pointer", color: col.muted, display: "flex" }}><XIcon /></span>
            </div>

            <div
                onClick={() => input.current?.click()}
                style={{
                    border: `2px dashed ${drag ? col.brand : "rgba(255,255,255,.25)"}`, borderRadius: 10, padding: "18px 10px", textAlign: "center",
                    cursor: "pointer", color: col.muted, background: drag ? "rgba(88,101,242,.12)" : "transparent"
                }}
            >
                <div style={{ color: col.strong, fontWeight: 600 }}>Clique ou arraste o arquivo</div>
                <div style={{ fontSize: 12, marginTop: 2 }}>Sem limite de tamanho. Vai direto de um PC para o outro.</div>
                <input ref={input} type="file" multiple style={{ display: "none" }} onChange={e => { add(e.target.files); e.target.value = ""; }} />
            </div>

            {staged.length > 0 && (
                <div style={{ marginTop: 10 }}>
                    {staged.map((f, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                            <FileIcon />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: col.strong }}>{f.name}</div>
                                <div style={{ fontSize: 12, color: col.muted }}>{fmtSize(f.size)}</div>
                            </div>
                            <span title="Tirar" onClick={() => { staged.splice(i, 1); emit(); }} style={{ cursor: "pointer", color: col.muted, display: "flex" }}><XIcon /></span>
                        </div>
                    ))}
                    <div style={{ marginTop: 8, fontWeight: 600, color: col.strong }}>Enviar para</div>
                    {peers.length === 0 && <div style={{ color: col.muted, fontSize: 13, padding: "4px 0" }}>Ninguem mais na chamada esta com o pdLink aberto.</div>}
                    {peers.map(p => (
                        <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: "pointer" }}>
                            <input
                                type="checkbox" checked={!deselected.has(p.id)}
                                onChange={() => { if (deselected.has(p.id)) deselected.delete(p.id); else deselected.add(p.id); emit(); }}
                            />
                            <span>{p.name}</span>
                        </label>
                    ))}
                    <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                        <SmallBtn kind="ghost" onClick={() => { staged = []; emit(); }}>Limpar</SmallBtn>
                        <SmallBtn disabled={!rec.length} onClick={() => { sendStaged(); }}>Enviar{rec.length ? ` para ${rec.length}` : ""}</SmallBtn>
                    </div>
                </div>
            )}

            {received.length > 0 && (
                <div style={{ marginTop: 14 }}>
                    <div style={{ fontWeight: 700, color: col.strong, marginBottom: 4 }}>Recebidos</div>
                    {received.map(x => (
                        <div key={x.key} style={{ background: col.card, borderRadius: 8, padding: 10, marginBottom: 6 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <FileIcon />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: col.strong, fontWeight: 600 }} title={x.offer.name}>{x.offer.name}</div>
                                    <div style={{ fontSize: 12, color: col.muted }}>de {x.fromName || "alguem"}  ·  {fmtSize(x.offer.size)}</div>
                                </div>
                                {(x.state === "new" || x.state === "error" || x.state === "cancelled") && <SmallBtn onClick={() => { download(x.key); }}>{x.state === "new" ? "Baixar" : "Tentar de novo"}</SmallBtn>}
                                {(x.state === "connecting" || x.state === "downloading") && <SmallBtn kind="ghost" onClick={() => cancel(x.key)}>Cancelar</SmallBtn>}
                                {x.state === "done" && <SmallBtn kind="ghost" onClick={() => reveal(x.path)}>Abrir pasta</SmallBtn>}
                                {(x.state === "new" || x.state === "done" || x.state === "error" || x.state === "cancelled") && (
                                    <span title="Remover da lista" onClick={() => dismiss(x.key)} style={{ cursor: "pointer", color: col.muted, display: "flex" }}><XIcon /></span>
                                )}
                            </div>
                            {x.state !== "new" && (
                                <div style={{ fontSize: 12, marginTop: 6, color: x.state === "error" ? col.red : x.state === "done" ? col.green : col.muted }}>{stateText(x)}</div>
                            )}
                            {x.state === "downloading" && <Bar value={x.total ? x.bytes / x.total : 0} />}
                        </div>
                    ))}
                </div>
            )}

            {sent.length > 0 && (
                <div style={{ marginTop: 14 }}>
                    <div style={{ fontWeight: 700, color: col.strong, marginBottom: 4 }}>Enviados</div>
                    {sent.map(s => (
                        <div key={s.id} style={{ background: col.card, borderRadius: 8, padding: 10, marginBottom: 6 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <FileIcon />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: col.strong, fontWeight: 600 }} title={s.name}>{s.name}</div>
                                    <div style={{ fontSize: 12, color: col.muted }}>{fmtSize(s.size)}</div>
                                </div>
                                <SmallBtn kind="ghost" title="Quem ainda nao baixou nao consegue mais" onClick={() => withdraw(s.id)}>Retirar</SmallBtn>
                            </div>
                            {Object.entries(s.to).map(([id, t]) => (
                                <div key={id} style={{ fontSize: 12, color: t.state === "done" ? col.green : t.state === "error" ? col.red : col.muted, marginTop: 4 }}>
                                    {t.name}: {sentText(t, s.size)}
                                </div>
                            ))}
                            <div style={{ fontSize: 11, color: col.muted, marginTop: 6 }}>Fique na chamada ate todo mundo baixar.</div>
                        </div>
                    ))}
                </div>
            )}

            {!received.length && !sent.length && !staged.length && (
                <div style={{ marginTop: 12, fontSize: 12, color: col.muted }}>
                    Quem receber vê um aviso, abre este menu e clica em Baixar para escolher onde salvar.
                </div>
            )}
        </div>,
        target
    );
}

/** Botao colocado na barra de controles da chamada, ao lado dos botoes do Discord. */
export function FilesButton() {
    useFiles();
    const btn = useRef<HTMLButtonElement>(null);
    const [, tick] = useState(0);

    useEffect(() => {
        const doc = btn.current?.ownerDocument;
        if (!doc) return;
        const f = () => tick(n => n + 1);
        doc.addEventListener("fullscreenchange", f);
        return () => doc.removeEventListener("fullscreenchange", f);
    }, []);

    useEffect(() => {
        if (!toast) return;
        const t = setTimeout(() => { if (toast && Date.now() >= toast.until) { toast = null; emit(); } }, Math.max(0, toast.until - Date.now()) + 50);
        return () => clearTimeout(t);
    }, [toast]);

    const doc = btn.current?.ownerDocument;
    const fs = doc?.fullscreenElement as HTMLElement | null | undefined;
    const target: HTMLElement | null = doc ? (fs && btn.current && fs.contains(btn.current) ? fs : doc.body) : null;
    const unseen = received.filter(r => !r.seen).length;
    const active = received.filter(r => r.state === "downloading" || r.state === "connecting").length;
    const r = btn.current?.getBoundingClientRect();

    return (
        <div style={{ display: "flex", alignItems: "center", marginRight: 8 }}>
            <div style={{ position: "relative", display: "flex", alignItems: "center", padding: 4, borderRadius: 12, background: "var(--background-base-lowest, rgba(30,31,34,.9))" }}>
                <button
                    ref={btn}
                    title={binding ? "Enviar e receber arquivos (pdLink)" : "Arquivos (pdLink): conectando a chamada..."}
                    onClick={e => { e.stopPropagation(); setOpen(!panelOpen); }}
                    style={{
                        all: "unset", cursor: "pointer", width: 40, height: 40, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
                        color: panelOpen ? "#fff" : "var(--interactive-normal, #b5bac1)", background: panelOpen ? col.brand : "transparent"
                    }}
                >
                    <ClipIcon />
                </button>
                {(unseen > 0 || active > 0) && (
                    <span style={{
                        position: "absolute", top: -2, right: -2, minWidth: 18, height: 18, borderRadius: 9, padding: "0 4px", boxSizing: "border-box",
                        background: unseen > 0 ? col.red : col.brand, color: "#fff", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center"
                    }}>{unseen > 0 ? unseen : "↓"}</span>
                )}
            </div>
            {panelOpen && target && <Panel anchor={btn} target={target} />}
            {toast && !panelOpen && target && r && ReactDOM.createPortal(
                <div
                    onClick={e => { e.stopPropagation(); setOpen(true); }}
                    style={{
                        position: "fixed", left: Math.max(8, r.left), bottom: (doc?.defaultView?.innerHeight ?? 800) - r.top + 14, maxWidth: 360, zIndex: 1100,
                        background: col.bg, color: col.text, padding: "10px 14px", borderRadius: 10, boxShadow: "0 6px 22px rgba(0,0,0,.5)", cursor: "pointer",
                        borderLeft: `4px solid ${col.brand}`, fontFamily: "var(--font-primary, 'Segoe UI', sans-serif)"
                    }}
                >
                    <div style={{ fontSize: 12, color: col.muted, fontWeight: 600 }}>{toast.title}</div>
                    <div style={{ fontWeight: 600, color: col.strong, wordBreak: "break-word" }}>{toast.text}</div>
                    <div style={{ fontSize: 12, color: col.muted, marginTop: 2 }}>Clique para abrir e baixar</div>
                </div>,
                target
            )}
        </div>
    );
}
