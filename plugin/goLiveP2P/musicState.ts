/*
 * pdLink - musica na chamada: estado e acoes (sem interface). A janela fica em music.tsx.
 */

import * as DataStore from "@api/DataStore";
import { PluginNative } from "@utils/types";

import { plog } from "./logger";
import { currentTrack, MusicSync, Track } from "./musicCore";
import { MusicClient, MusicServer } from "./musicLink";
import type { Found, Lyrics } from "./musicNative";
import { MusicPlayer } from "./musicPlayer";
import { type Hub, ICE } from "./p2p";

const Native = VencordNative.pluginHelpers.pdLink as PluginNative<typeof import("./native")>;
const hasNative = () => typeof (Native as any)?.musicFetch === "function";

export interface Listener { id: string; name: string; }
export interface Playlist { name: string; items: Found[]; }
export type View = "fila" | "busca" | "pc" | "historico" | "curtidas" | "playlists";
export interface SearchState { busy: boolean; error: string; items: Found[]; query: string; }
export interface Bound { sync: MusicSync; player: MusicPlayer; myId: string; nameOf: (id: string) => string; hub: Hub; }
/** Musica do meu PC: o arquivo so existe aqui, enquanto o Discord estiver aberto. */
export interface LocalFile { key: string; file: File; url: string; found: Found; }

/** Tudo que a janela mostra. Fica fora dos componentes para nao sumir quando a janela fecha e abre. */
export const S = {
    bound: null as Bound | null,
    listeners: [] as Listener[],
    open: false,
    volume: 0.6,
    muted: false,
    history: [] as Found[],
    liked: [] as Found[],
    playlists: [] as Playlist[],
    locals: [] as LocalFile[],
    localError: "",
    view: "fila" as View,
    search: { busy: false, error: "", items: [], query: "" } as SearchState,
    openList: -1,
    /** tela de letra aberta (so para mim) */
    lyrics: false
};

export const toggleLyrics = () => { S.lyrics = !S.lyrics; emit(); };

// ------------------------------------------------------------------ letra: cada um busca a sua; o tempo e o mesmo da musica

export type LyricsState = { busy: true; } | ({ busy: false; } & Lyrics);
const lyricsCache = new Map<string, LyricsState>();
const lyricsKey = (t: { title: string; artist: string; dur: number; }) => t.title + "|" + t.artist + "|" + Math.round(t.dur);

export function lyricsFor(t: { title: string; artist: string; dur: number; src: string; }): LyricsState {
    const key = lyricsKey(t);
    const have = lyricsCache.get(key);
    if (have) return have;
    if (typeof (Native as any)?.musicLyrics !== "function") return { busy: false, ok: false, error: "feche e abra o Discord para ativar a letra" };
    lyricsCache.set(key, { busy: true });
    // musica do PC: o nome do arquivo e o titulo; o artista do Suno nao ajuda na busca
    const artist = t.src === "local" || t.src === "suno" ? "" : t.artist;
    Native.musicLyrics(t.title, artist, t.dur)
        .then(r => lyricsCache.set(key, { busy: false, ...r }))
        .catch(() => lyricsCache.set(key, { busy: false, ok: false, error: "nao consegui buscar a letra agora" }))
        .finally(() => { if (lyricsCache.size > 100) lyricsCache.delete(lyricsCache.keys().next().value!); emit(); });
    return { busy: true };
}

let clockOffset = 0;
let clockAt = 0;
let lastCur = "";
export const subs = new Set<() => void>();
export const emit = () => subs.forEach(f => f());

const HISTORY_KEY = "pdLink_musicHistory";
const PREFS_KEY = "pdLink_musicPrefs";
const LIKED_KEY = "pdLink_musicLiked";
const LISTS_KEY = "pdLink_musicLists";
DataStore.get(HISTORY_KEY).then(v => { if (Array.isArray(v)) { S.history = v.slice(0, 200); emit(); } }).catch(() => { });
DataStore.get(LIKED_KEY).then(v => { if (Array.isArray(v)) { S.liked = v; emit(); } }).catch(() => { });
DataStore.get(LISTS_KEY).then(v => { if (Array.isArray(v)) { S.playlists = v; emit(); } }).catch(() => { });
DataStore.get(PREFS_KEY).then(v => { if (v && typeof v.volume === "number") { S.volume = v.volume; S.muted = !!v.muted; applyVolume(); emit(); } }).catch(() => { });

function applyVolume() {
    // curva mais suave: o ouvido nao percebe volume em linha reta
    S.bound?.player.setVolume(S.volume * S.volume);
    S.bound?.player.setMuted(S.muted);
}
export function setVolume(v: number, m = S.muted) {
    S.volume = Math.max(0, Math.min(1, v)); S.muted = m;
    applyVolume(); emit();
    DataStore.set(PREFS_KEY, { volume: S.volume, muted: S.muted }).catch(() => { });
}
export const setView = (v: View) => { S.view = v; if (v !== "playlists") S.openList = -1; emit(); };
export const plain = (f: Found): Found => ({ src: f.src, ref: f.ref, title: f.title, artist: f.artist, dur: f.dur, img: f.img });
/** musica do PC de alguem: so vale nesta chamada, nao entra em historico, curtidas ou playlists */
export const isLocal = (f: { src: string; }) => f.src === "local";
export const isLiked = (ref: string) => S.liked.some(l => l.ref === ref);
export function toggleLike(f: Found) {
    if (isLocal(f)) return;
    S.liked = isLiked(f.ref) ? S.liked.filter(l => l.ref !== f.ref) : [plain(f), ...S.liked].slice(0, 1000);
    DataStore.set(LIKED_KEY, S.liked).catch(() => { });
    emit();
}
export function saveLists() { DataStore.set(LISTS_KEY, S.playlists).catch(() => { }); emit(); }

const rid = () => Math.random().toString(36).slice(2, 12);

// ------------------------------------------------------------------ musica do PC

const LOCAL_REF = /^local:([a-z0-9]{8,16}):(glp\/v1\/([0-9a-f]{24})\/in\/[0-9a-f]{16})$/;
const parseLocal = (ref: string) => { const m = ref.match(LOCAL_REF); return m ? { key: m[1], inbox: m[2], ch: m[3] } : null; };
const myInbox = () => S.bound?.hub.musicSignal()?.inbox ?? "";
const channelOf = (inbox: string) => inbox.split("/")[2] ?? "";
/** a mesma musica do PC, nao importa em que fila ou chamada (para marcar "Na fila") */
export const sameLocal = (t: { ref: string; }, key: string) => parseLocal(t.ref)?.key === key;

export const toTrack = (f: Found, by: string): Track => {
    // musica do PC: o endereco diz onde pedir o som (a minha caixa de mensagens nesta chamada), nunca o caminho do arquivo
    const ref = isLocal(f) ? `local:${f.ref.slice(3)}:${myInbox()}` : f.ref;
    return { id: rid(), src: f.src, ref, title: f.title, artist: f.artist, dur: f.dur, by, img: f.img };
};

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|webm|weba|mp4)$/i;

function durationOf(url: string) {
    return new Promise<number>(res => {
        const a = new Audio();
        const done = (v: number) => { clearTimeout(t); a.removeAttribute("src"); res(v); };
        const t = setTimeout(() => done(-1), 8000);
        a.preload = "metadata";
        a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0);
        a.onerror = () => done(-1);
        a.src = url;
    });
}

/** Coloca arquivos do PC na lista "Do PC" (nada sai do PC aqui). Devolve quantos deram certo. */
export async function addLocalFiles(files: File[]) {
    let ok = 0;
    const bad: string[] = [];
    for (const file of files.slice(0, 50)) {
        if (!AUDIO_EXT.test(file.name) && !file.type.startsWith("audio/")) { bad.push(file.name); continue; }
        const url = URL.createObjectURL(file);
        const dur = await durationOf(url);
        if (dur < 0) { URL.revokeObjectURL(url); bad.push(file.name); continue; }
        const key = Math.random().toString(36).slice(2, 12).padEnd(10, "0");
        const title = file.name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim().slice(0, 200) || "Musica sem nome";
        S.locals.unshift({ key, file, url, found: { src: "local", ref: "pc:" + key, title, artist: "", dur, img: "" } });
        ok++;
    }
    S.localError = bad.length ? `Nao consegui tocar: ${bad.slice(0, 3).join(", ")}${bad.length > 3 ? ` e mais ${bad.length - 3}` : ""}. Use mp3, m4a, wav, flac, ogg ou opus.` : "";
    emit();
    return ok;
}

export function removeLocal(key: string) {
    const l = S.locals.find(x => x.key === key);
    if (!l) return;
    S.locals = S.locals.filter(x => x !== l);
    // tira da fila tambem: sem o arquivo, ninguem consegue ouvir
    const b = S.bound;
    if (b) for (const t of b.sync.state.queue) if (sameLocal(t, key) && parseLocal(t.ref)?.inbox === myInbox()) b.sync.do({ t: "remove", id: t.id });
    setTimeout(() => URL.revokeObjectURL(l.url), 1000);
    emit();
}

/** a musica e do meu PC, nesta chamada, e o arquivo ainda esta aberto aqui */
function mine(t: Track) {
    const p = parseLocal(t.ref);
    return !!p && p.inbox === myInbox() && S.locals.some(l => l.key === p.key);
}

let server: MusicServer | null = null;
const clients = new Map<string, MusicClient>();

function ensureServer(b: Bound) {
    if (server) return server;
    const ctx = new AudioContext({ latencyHint: "playback" });
    const dest = ctx.createMediaStreamDestination();
    b.player.sendTo(ctx, dest);
    server = new MusicServer(() => b.hub.musicSignal(), ICE, dest.stream.getAudioTracks()[0], dest.stream, id => id !== b.myId && allowed(id) && b.sync.state.queue.some(mine));
    return server;
}
let allowed: (userId: string) => boolean = () => false;

function onSignal(b: Bound, m: any) {
    if (m?.type === "MOFFER") {
        // so transmito se tem musica do MEU PC na fila agora
        if (!b.sync.state.queue.some(mine)) return;
        ensureServer(b).onOffer(m);
    } else if (m?.type === "MANSWER") clients.get(String(m.from))?.onAnswer(m);
}

function remoteFor(b: Bound, t: Track) {
    if (!isLocal(t)) return null;
    const p = parseLocal(t.ref);
    if (!p) return { stream: null, status: "erro: musica do PC invalida" };
    const me = myInbox();
    if (p.inbox === me) return null;
    if (!me || p.ch !== channelOf(me)) return { stream: null, status: "erro: essa musica e de outra chamada" };
    let c = clients.get(p.inbox);
    if (!c) { c = new MusicClient(() => b.hub.musicSignal(), ICE, p.inbox, b.myId, emit); clients.set(p.inbox, c); }
    return c.state;
}

/** fecha a conexao de som com quem nao tem mais musica na fila */
function pruneClients(b: Bound) {
    const owners = new Set(b.sync.state.queue.map(t => parseLocal(t.ref)?.inbox).filter(Boolean));
    for (const [inbox, c] of clients) if (!owners.has(inbox)) { c.close(); clients.delete(inbox); }
}

// ------------------------------------------------------------------ ligar e desligar

const now = () => Date.now() + clockOffset;

async function measureClock() {
    if (!hasNative() || Date.now() - clockAt < 30 * 60 * 1000) return;
    try {
        const r = await Native.musicClock();
        if (r?.ok) { clockOffset = r.offset; clockAt = Date.now(); }
    } catch { }
}

async function loadTrack(t: Track) {
    if (isLocal(t)) {
        const p = parseLocal(t.ref);
        const l = p && p.inbox === myInbox() ? S.locals.find(x => x.key === p.key) : null;
        if (!l) throw new Error("esse arquivo nao esta mais aberto neste PC; coloque de novo pela aba Do PC");
        return l.url;
    }
    if (!hasNative()) throw new Error("feche e abra o Discord para ativar a musica");
    const r = await Native.musicFetch(t.ref);
    if (!r.ok) throw new Error(r.error);
    return URL.createObjectURL(new Blob([r.data as any], { type: r.mime }));
}

function remember(t: Track) {
    if (isLocal(t)) return;
    S.history = [plain(t), ...S.history.filter(h => h.ref !== t.ref)].slice(0, 200);
    DataStore.set(HISTORY_KEY, S.history).catch(() => { });
}

/** Liga a musica a chamada atual. `inCall` diz se uma pessoa esta nesta chamada agora. */
export async function startMusic(hub: Hub, myId: string, nameOf: (id: string) => string, inCall: (id: string) => boolean) {
    stopMusic();
    await measureClock();
    allowed = inCall;
    const sync = new MusicSync(myId, now, { publish: (text, keep) => hub.publishMusic(text, keep) });
    let b!: Bound;
    const player = new MusicPlayer(sync, now, loadTrack, {
        remote: t => remoteFor(b, t),
        sending: t => mine(t),
        latency: () => server?.latency() ?? 0
    });
    b = { sync, player, myId, nameOf, hub };
    hub.onMusic = text => sync.receive(text);
    hub.onMusicSignal = m => onSignal(b, m);
    sync.onChange = s => {
        if (s.cur !== lastCur) {
            lastCur = s.cur;
            const t = currentTrack(s);
            if (t) { remember(t); plog(`musica: tocando "${t.title}"${isLocal(t) ? " (do PC)" : ""}`); }
        }
        pruneClients(b);
        // a musica do meu PC saiu da fila: para de mandar som na hora
        if (server && !s.queue.some(mine)) server.check();
        emit();
    };
    player.onStatus = () => { if (player.status) plog("musica: " + player.status); emit(); };
    S.bound = b;
    applyVolume();
    emit();
    // relogio: confere de novo de vez em quando (o do PC anda um pouco)
    setTimeout(() => { clockAt = 0; if (S.bound?.sync === sync) measureClock(); }, 30 * 60 * 1000);
}

export function stopMusic() {
    const b = S.bound;
    if (!b) return;
    // sai da chamada: para de transmitir na hora e esquece as conexoes de som
    server?.stop();
    server = null;
    for (const c of clients.values()) c.close();
    clients.clear();
    b.hub.onMusicSignal = () => { };
    b.player.stop();
    b.sync.stop();
    S.bound = null;
    allowed = () => false;
    lastCur = "";
    S.listeners = [];
    emit();
}

/** Quem esta na chamada com o mod (ouve a musica junto). */
export function setListeners(list: Listener[]) { S.listeners = list; emit(); }

export async function runSearch(b: Bound, query: string) {
    query = query.trim();
    if (!query || S.search.busy) return;
    const set = (s: SearchState) => { S.search = s; emit(); };
    S.view = "busca";
    if (!hasNative()) { set({ busy: false, error: "Feche e abra o Discord para ativar a musica.", items: [], query }); return; }
    set({ busy: true, error: "", items: [], query });
    const r = await Native.musicSearch(query);
    if (!r.ok) { set({ busy: false, error: r.error, items: [], query }); return; }
    if (/^https?:\/\//i.test(query) && r.items.length === 1 && !r.list) {
        // link de uma musica so: ja entra na fila
        b.sync.do({ t: "add", tracks: [toTrack(r.items[0], b.myId)] });
        S.view = "fila"; set({ busy: false, error: "", items: [], query: "" });
        return;
    }
    set({ busy: false, error: r.items.length ? "" : "Nao achei nada.", items: r.items, query });
}
