import { findByProps, findStore } from "@webpack";
import { ChannelStore, FluxDispatcher, SelectedChannelStore, UserStore, useEffect, useRef } from "@webpack/common";

import { getLive } from "./live";

// Faz o Discord "enxergar" as lives (a nossa e as dos amigos que usam o plugin) como transmissoes
// dele, so localmente: as lojas devolvem a transmissao e o Discord desenha sozinho o quadro na grade,
// o selo AO VIVO, o painel e o botao. O video dos quadros vem do nosso canvas ou da conexao P2P.

export const LOCAL_VIDEO_ID = "golive-p2p-video";
const REMOTE_PREFIX = "golive-p2p-remote-";

export interface LiveEntry {
    userId: string;
    label: string;
    local: boolean;
    watching: boolean; // espectador ja conectado (tem video)
    stream?: MediaStream;
    viewers: string[];
}

const liveUsers = new Map<string, LiveEntry>();
let installed = false;
let stateEnum: any = null;
const originals = new Map<string, Function>();
const log: string[] = [];
let stores: Record<string, any> = {};
let interceptor: ((a: any) => boolean) | null = null;

export const callbacks = {
    watch: (_userId: string) => { },
    unwatch: (_userId: string) => { }
};

function note(msg: string) {
    log.push(msg);
    if (log.length > 60) log.shift();
}

function me() {
    return UserStore.getCurrentUser()?.id as string | undefined;
}

function voiceChannel() {
    return SelectedChannelStore.getVoiceChannelId() as string | null;
}

function appStreamOf(entry: LiveEntry | undefined) {
    if (!entry) return null;
    const channelId = voiceChannel();
    if (!channelId) return null;
    const guildId = ChannelStore.getChannel(channelId)?.guild_id ?? null;
    return { streamType: guildId ? "guild" : "call", guildId, channelId, ownerId: entry.userId, discoverable: true };
}

function keyOf(s: { streamType: string; guildId: string | null; channelId: string; ownerId: string; }) {
    return s.streamType === "guild" ? ["guild", s.guildId, s.channelId, s.ownerId].join(":") : ["call", s.channelId, s.ownerId].join(":");
}

function entryForKey(key: string): LiveEntry | undefined {
    for (const e of liveUsers.values()) {
        const s = appStreamOf(e);
        if (s && keyOf(s) === key) return e;
    }
}

function localEntry() {
    const id = me();
    return id ? liveUsers.get(id) : undefined;
}

function activeVersion(s: any) {
    return { ...s, state: stateEnum?.ACTIVE ?? "ACTIVE" };
}

function allStreams(onlyWatching: boolean) {
    const out: any[] = [];
    for (const e of liveUsers.values()) {
        if (onlyWatching && !e.watching) continue;
        const s = appStreamOf(e);
        if (s) out.push(onlyWatching ? activeVersion(s) : s);
    }
    return out;
}

function wrap(store: any, name: string, make: (orig: Function) => Function) {
    if (!store || typeof store[name] !== "function") {
        note(`sem metodo ${name}`);
        return;
    }
    const id = (store.getName?.() ?? "store") + "." + name;
    if (originals.has(id)) return;
    const orig = store[name];
    originals.set(id, orig);
    store[name] = make(orig);
}

function overlayVoiceState(vs: any) {
    if (!vs || vs.selfStream || !liveUsers.has(vs.userId)) return vs;
    return Object.assign(Object.create(Object.getPrototypeOf(vs)), vs, { selfStream: true });
}

function overlayMap(m: any) {
    if (!m || liveUsers.size === 0) return m;
    let out = m;
    for (const id of liveUsers.keys()) {
        if (m[id]) out = { ...out, [id]: overlayVoiceState(m[id]) };
    }
    return out;
}

interface VolumeStore {
    getLocalVolume(userId: string, ctx: string): number;
    isLocalMute(userId: string, ctx: string): boolean;
}

/** Aplica ao <video> o volume e o "silenciar" que o usuario escolheu nos controles nativos da transmissao. */
export function applyLocalAudio(v: { volume: number; muted: boolean; }, media: VolumeStore, userId: string) {
    // sem ajuste feito, o Discord devolve o volume padrao dele para transmissoes (bem baixo); aqui conta como 100%
    const def = media.getLocalVolume("0", "stream");
    const cur = media.getLocalVolume(userId, "stream");
    const pct = cur === def ? 100 : cur;
    v.volume = Math.max(0, Math.min(1, pct / 100));
    v.muted = !!media.isLocalMute(userId, "stream");
}

function P2PVideo(props: any) {
    const { className, onResize, onReady, streamId } = props;
    const ref = useRef<HTMLVideoElement>(null);
    useEffect(() => {
        const v = ref.current;
        const media = stores.MediaEngineStore;
        if (!v || !media || streamId === LOCAL_VIDEO_ID) return;
        const uid = String(streamId).slice(REMOTE_PREFIX.length);
        const apply = () => { try { applyLocalAudio(v, media, uid); } catch { } };
        apply();
        media.addChangeListener(apply);
        return () => media.removeChangeListener(apply);
    }, [streamId]);
    useEffect(() => {
        const v = ref.current;
        if (!v) return;
        if (streamId === LOCAL_VIDEO_ID) v.srcObject = new MediaStream([getLive().getVideoTrack()]);
        else v.srcObject = liveUsers.get(String(streamId).slice(REMOTE_PREFIX.length))?.stream ?? null;
        v.play().catch(() => { });
        const size = () => { if (v.videoWidth) onResize?.({ width: v.videoWidth, height: v.videoHeight }); };
        const ready = () => { size(); onReady?.(); };
        v.addEventListener("loadedmetadata", size);
        v.addEventListener("resize", size);
        v.addEventListener("playing", ready);
        return () => {
            v.removeEventListener("loadedmetadata", size);
            v.removeEventListener("resize", size);
            v.removeEventListener("playing", ready);
            v.srcObject = null;
        };
    }, [streamId]);
    return <video ref={ref} className={className} muted={streamId === LOCAL_VIDEO_ID} playsInline autoPlay />;
}

const wrappedVideo = new WeakMap<object, any>();
function wrapVideoComponent(Orig: any) {
    if (!Orig) return Orig;
    let W = wrappedVideo.get(Orig);
    if (!W) {
        W = function GoLiveVideo(props: any) {
            const id = props?.streamId;
            if (id === LOCAL_VIDEO_ID || (typeof id === "string" && id.startsWith(REMOTE_PREFIX))) return <P2PVideo {...props} />;
            return <Orig {...props} />;
        };
        wrappedVideo.set(Orig, W);
    }
    return W;
}

export function installNativeUi() {
    if (installed) return;
    try {
        stateEnum = findByProps("CONNECTING", "RECONNECTING", "ACTIVE", "ENDED", "FAILED", "PAUSED");
    } catch { }
    const app: any = findStore("ApplicationStreamingStore");
    const voice: any = findStore("VoiceStateStore");
    const video: any = findStore("VideoStreamStore");
    const media: any = findStore("MediaEngineStore");
    const preview: any = findStore("ApplicationStreamPreviewStore");
    stores = {
        ApplicationStreamingStore: app, VoiceStateStore: voice, VideoStreamStore: video,
        MediaEngineStore: media, ApplicationStreamPreviewStore: preview
    };
    for (const [n, s] of Object.entries(stores)) note(`${n}: ${s ? "ok" : "NAO ACHADA"}`);

    const sameGuild = (s: any, g: any) => (g ?? null) === (s.guildId ?? null);

    // ---- ApplicationStreamingStore
    wrap(app, "getStreamForUser", o => function (this: any, userId: string, guildId: string | null) {
        const s = appStreamOf(liveUsers.get(userId));
        if (s && sameGuild(s, guildId)) return s;
        return o.call(this, userId, guildId);
    });
    wrap(app, "getActiveStreamForUser", o => function (this: any, userId: string, guildId: string | null) {
        const e = liveUsers.get(userId);
        const s = appStreamOf(e);
        if (s && e!.watching && sameGuild(s, guildId)) return activeVersion(s);
        return o.call(this, userId, guildId);
    });
    wrap(app, "getActiveStreamForStreamKey", o => function (this: any, key: string) {
        const e = entryForKey(key);
        return e?.watching ? activeVersion(appStreamOf(e)) : o.call(this, key);
    });
    wrap(app, "getActiveStreamForApplicationStream", o => function (this: any, st: any) {
        const e = st ? liveUsers.get(st.ownerId) : undefined;
        const s = appStreamOf(e);
        if (s && e!.watching && s.channelId === st.channelId) return activeVersion(s);
        return o.call(this, st);
    });
    wrap(app, "getCurrentUserActiveStream", o => function (this: any) {
        const r = o.call(this);
        if (r) return r;
        const s = appStreamOf(localEntry());
        return s ? activeVersion(s) : null;
    });
    wrap(app, "getLastActiveStream", o => function (this: any) {
        const s = appStreamOf(localEntry());
        return s ? activeVersion(s) : o.call(this);
    });
    const merge = (o: Function, watchingOnly: boolean, byChannel: boolean) => function (this: any, arg?: any) {
        const r = o.call(this, arg) as any[];
        const extra = allStreams(watchingOnly).filter(s => (!byChannel || s.channelId === arg)
            && !r.some(x => x.ownerId === s.ownerId && x.channelId === s.channelId));
        return extra.length ? [...r, ...extra] : r;
    };
    wrap(app, "getAllActiveStreams", o => merge(o, true, false));
    wrap(app, "getAllActiveStreamsForChannel", o => merge(o, true, true));
    wrap(app, "getAllApplicationStreams", o => merge(o, false, false));
    wrap(app, "getAllApplicationStreamsForChannel", o => merge(o, false, true));
    wrap(app, "getAnyStreamForUser", o => function (this: any, userId: string) {
        return appStreamOf(liveUsers.get(userId)) ?? o.call(this, userId);
    });
    wrap(app, "getRTCStream", o => function (this: any, key: string) {
        const e = entryForKey(key);
        return e ? { streamKey: key, region: "p2p", viewerIds: e.viewers } : o.call(this, key);
    });
    wrap(app, "getViewerIds", o => function (this: any, x: any) {
        const key = typeof x === "string" ? x : x && x.channelId ? keyOf(x) : null;
        const e = key ? entryForKey(key) : undefined;
        return e ? e.viewers : o.call(this, x);
    });
    const meta = (e: LiveEntry) => ({ id: undefined, pid: undefined, sourceName: e.label, sourceId: "golive-p2p", previewDisabled: true });
    wrap(app, "getStreamerActiveStreamMetadata", o => function (this: any) {
        const e = localEntry();
        return e && appStreamOf(e) ? meta(e) : o.call(this);
    });
    wrap(app, "getStreamerActiveStreamMetadataForStream", o => function (this: any, key: string) {
        const e = entryForKey(key);
        return e?.local ? meta(e) : o.call(this, key);
    });
    wrap(app, "getIsActiveStreamPreviewDisabled", o => function (this: any, key: string) {
        return entryForKey(key) ? true : o.call(this, key);
    });

    // ---- ApplicationStreamPreviewStore: nunca buscar preview das nossas transmissoes nos servidores
    wrap(preview, "shouldFetchPreview", o => function (this: any, guildId: any, channelId: any, ownerId: any) {
        if (liveUsers.has(ownerId)) return false;
        return o.call(this, guildId, channelId, ownerId);
    });

    // ---- VoiceStateStore: selfStream = true (selo AO VIVO)
    for (const name of ["getVoiceStateForChannel", "getVoiceStateForUser", "getVoiceState", "getVoiceStateForSession"]) {
        wrap(voice, name, o => function (this: any, ...a: any[]) { return overlayVoiceState(o.apply(this, a)); });
    }
    for (const name of ["getVoiceStatesForChannel", "getVoiceStates"]) {
        wrap(voice, name, o => function (this: any, ...a: any[]) { return overlayMap(o.apply(this, a)); });
    }
    wrap(voice, "getAllVoiceStates", o => function (this: any, ...a: any[]) {
        const r = o.apply(this, a);
        if (!r || liveUsers.size === 0) return r;
        const out: any = {};
        for (const k of Object.keys(r)) out[k] = overlayMap(r[k]);
        return out;
    });

    // ---- VideoStreamStore: id do fluxo de video (usado pelos quadros da grade)
    const videoIdFor = (userId: string, ctx?: string) => {
        if (!String(ctx ?? "").toLowerCase().includes("stream")) return null;
        const e = liveUsers.get(userId);
        if (!e) return null;
        if (e.local) return LOCAL_VIDEO_ID;
        return e.watching ? REMOTE_PREFIX + userId : null;
    };
    wrap(video, "getStreamId", o => function (this: any, userId: string, guildId: any, ctx?: string) {
        return videoIdFor(userId, ctx) ?? o.call(this, userId, guildId, ctx);
    });
    wrap(video, "getUserStreamData", o => function (this: any, userId: string, guildId: any, ctx?: string) {
        const id = videoIdFor(userId, ctx);
        return id ? { streamId: id } : o.call(this, userId, guildId, ctx);
    });

    // ---- MediaEngineStore: componente de video e estado "compartilhando tela"
    wrap(media, "getVideoComponent", o => function (this: any) { return wrapVideoComponent(o.call(this)); });
    wrap(media, "isScreenSharing", o => function (this: any, ctx?: string) {
        if (localEntry() && String(ctx ?? "stream").toLowerCase().includes("stream")) return true;
        return o.call(this, ctx);
    });

    // ---- Interceptador: Assistir e Parar pelo HUD nativo viram acoes nossas (nada vai aos servidores)
    interceptor = (a: any) => {
        // escolha de resolucao / FPS / som no menu nativo do Discord: aplica na nossa live
        // o menu nativo tambem pede para o motor do Discord trocar a fonte; sem fonte nativa isso nao deve ir adiante
        if (a?.type === "MEDIA_ENGINE_SET_GO_LIVE_SOURCE" && localEntry() && a.settings && !a.settings.desktopSettings && !a.settings.cameraSettings) return true;
        if (a?.type === "STREAM_UPDATE_SETTINGS") {
            if (localEntry()) queueMicrotask(() => getLive().applyNativeSettings(a));
            return false;
        }
        if (!a?.streamKey || liveUsers.size === 0) return false;
        const e = entryForKey(a.streamKey);
        if (!e) return false;
        if (a.type === "STREAM_WATCH") {
            if (!e.local) queueMicrotask(() => callbacks.watch(e.userId));
            return true;
        }
        if (a.type === "STREAM_STOP" || a.type === "STREAM_CLOSE" || a.type === "STREAM_DELETE") {
            queueMicrotask(() => (e.local ? getLive().stop() : callbacks.unwatch(e.userId)));
            return true;
        }
        return false;
    };
    (FluxDispatcher as any).addInterceptor(interceptor);
    installed = true;
    note("instalado");
}

export function uninstallNativeUi() {
    if (!installed) return;
    const users = [...liveUsers.keys()];
    liveUsers.clear();
    refresh(users);
    for (const [id, orig] of originals) {
        const [storeName, method] = id.split(".");
        const s = Object.values(stores).find(x => x?.getName?.() === storeName);
        if (s) {
            try { delete s[method]; } catch { }
            if (s[method] !== orig) s[method] = orig;
        }
    }
    originals.clear();
    const list = (FluxDispatcher as any)._interceptors as any[];
    const i = list?.indexOf(interceptor);
    if (i != null && i >= 0) list.splice(i, 1);
    installed = false;
}

function refresh(userIds: string[]) {
    for (const s of Object.values(stores)) {
        try { s?.emitChange?.(); } catch { }
    }
    const ch = voiceChannel();
    if (!ch) return;
    const self = me();
    for (const id of userIds) {
        try {
            if (id === self) FluxDispatcher.dispatch({ type: "STREAM_UPDATE_SELF_HIDDEN", channelId: ch, selfStreamHidden: false } as any);
            else FluxDispatcher.dispatch({ type: "RTC_CONNECTION_PLATFORM", channelId: ch, userId: id } as any);
        } catch (e) { note("refresh: " + String(e)); }
    }
}

export function setLiveEntry(userId: string, patch: Partial<LiveEntry> | null) {
    if (patch) installNativeUi();
    if (!installed) return;
    if (patch === null) liveUsers.delete(userId);
    else {
        const cur = liveUsers.get(userId) ?? { userId, label: "", local: false, watching: false, viewers: [] };
        liveUsers.set(userId, { ...cur, ...patch, userId });
    }
    refresh([userId]);
}

export function getLiveEntry(userId: string) {
    return liveUsers.get(userId);
}

export function nativeUiDiagnostics() {
    const ch = voiceChannel();
    const out: any = { installed, entries: [...liveUsers.values()].map(e => ({ ...e, stream: !!e.stream })), log, voiceChannel: ch };
    try {
        const rtc: any = findStore("ChannelRTCStore");
        out.participants = ch ? (rtc.getParticipants(ch) as any[]).map(p => ({ type: p.type, id: p.id, streamId: p.streamId, user: p.user?.username })) : [];
        out.currentUserStream = JSON.stringify(stores.ApplicationStreamingStore?.getCurrentUserActiveStream?.());
    } catch (e) {
        out.error = String(e);
    }
    return out;
}
