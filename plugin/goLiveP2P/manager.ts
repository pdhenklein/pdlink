import { ChannelStore, GuildMemberStore, RelationshipStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";

import { createMarkSession, dropMarkSession, notifyMarkSessions, registerMarkSession } from "./marks";
import { type Mark } from "./marksCore";
import { bindFiles, handleOffer, type Peer, setPeers } from "./files";
import { setListeners, startMusic, stopMusic } from "./music";
import { pickFullName, pickName } from "./names";
import { PluginNative } from "@utils/types";

import { getLive, getLocalToken, saveProbe, takeFlag, watchBase } from "./live";
import { callbacks, getLiveEntry, nativeUiDiagnostics, setLiveEntry, uninstallNativeUi } from "./nativeUi";
import { plog } from "./logger";
import { channelHash, Hub, selfTest, userHash, WatchHandle } from "./p2p";

let channelId: string | null = null;
let hub: Hub | null = null;
let resolveTimer: any = null;
const handles = new Map<string, WatchHandle>();
let unsubLive: (() => void) | null = null;
let channelListener: (() => void) | null = null;
let lastRunning = false;
let lastLabel = "";
let started = false;
let localToken = "";
let hubError = "";
let encoderCaps: any = null;
let statsTimer: any = null;
let watchUrl = "";
const Native = VencordNative.pluginHelpers.pdLink as PluginNative<typeof import("./native")>;
// funcoes novas do lado nativo so existem depois de reiniciar o Discord; ate la, ignorar sem quebrar nada
function nativeCall(name: string, ...args: any[]) {
    try { (Native as any)[name]?.(...args)?.catch?.(() => { }); } catch { }
}
let overlayKey = "";
let lastMarksAllowed: boolean | null = null;

// nome completo da pessoa naquela chamada (para listas)
function fullName(userId: string) {
    try {
        const u: any = UserStore.getUser(userId);
        const ch: any = channelId ? ChannelStore.getChannel(channelId) : null;
        const guildId: string | undefined = ch?.guild_id;
        return pickFullName({
            guildNick: guildId ? GuildMemberStore.getNick(guildId, userId) : null,
            groupNick: ch?.nicks?.[userId],
            friendNick: RelationshipStore.getNickname(userId),
            globalName: u?.globalName, username: u?.username
        }, !!guildId);
    } catch {
        return "";
    }
}

// quem na chamada esta com o mod aberto (pode receber arquivo)
const hashCache = new Map<string, string>();
async function hashOf(userId: string) {
    let h = hashCache.get(userId);
    if (!h && channelId) { h = await userHash(channelId, userId); hashCache.set(userId, h); }
    return h ?? "";
}
async function refreshPeers() {
    const h = hub;
    if (!h || !channelId) return;
    const list: Peer[] = [];
    for (const id of others()) {
        const at = h.mods.get(await hashOf(id));
        if (at && Date.now() - at < 70000) list.push({ id, name: fullName(id) });
    }
    if (hub === h) {
        setPeers(list);
        const self = me();
        setListeners(self ? [{ id: self, name: fullName(self) }, ...list] : list);
    }
}

// nome da pessoa NAQUELA chamada (apelido do servidor, do grupo ou de amigo), so a primeira palavra
function displayName(userId: string) {
    try {
        const u: any = UserStore.getUser(userId);
        const ch: any = channelId ? ChannelStore.getChannel(channelId) : null;
        const guildId: string | undefined = ch?.guild_id;
        return pickName({
            guildNick: guildId ? GuildMemberStore.getNick(guildId, userId) : null,
            groupNick: ch?.nicks?.[userId],
            friendNick: RelationshipStore.getNickname(userId),
            globalName: u?.globalName, username: u?.username
        }, !!guildId);
    } catch {
        return "";
    }
}

// Janela transparente com as marcacoes dos espectadores, por cima da janela/tela transmitida
function syncOverlay() {
    const live = getLive();
    const src = live.source;
    const wanted = live.running && live.prefs.allowMarks && !!src && src.kind !== "camera";
    // tela inteira: a janela das marcacoes sai da captura (senao entra na imagem da live); janela: aparece normal em prints e gravacoes
    const exclude = wanted && src!.kind === "monitor" && !live.prefs.marksInCapture;
    const key = wanted ? `${src!.kind}:${src!.kind === "window" ? src!.hwnd : src!.monitor}:${exclude ? "x" : "i"}` : "";
    if (key !== overlayKey) {
        overlayKey = key;
        if (!key) nativeCall("overlayStop");
        else nativeCall("overlayStart", src!.kind === "window" ? { hwnd: src!.hwnd } : { monitor: src!.monitor }, exclude);
    }
    if (hub && lastMarksAllowed !== wanted) {
        lastMarksAllowed = wanted;
        hub.setMarksAllowed(wanted);
    }
}

export function getWatchUrl() {
    return watchUrl;
}

async function buildWatchUrl() {
    const self = me();
    if (!channelId || !self) return "";
    const base = await watchBase();
    return `${base}#c=${await channelHash(channelId)}&u=${await userHash(channelId, self)}`;
}

function videoCodecs() {
    try {
        return [...new Set((RTCRtpSender.getCapabilities("video")?.codecs ?? []).map(c => c.mimeType + (c.sdpFmtpLine ? " [" + c.sdpFmtpLine.slice(0, 60) + "]" : "")))];
    } catch (e) {
        return ["erro: " + String(e)];
    }
}

async function encoderCapabilities() {
    const out: any = {};
    try {
        const mc: any = (navigator as any).mediaCapabilities;
        for (const ct of ["video/H264", "video/VP9", "video/AV1", "video/VP8"]) {
            try {
                const r = await mc.encodingInfo({ type: "webrtc", video: { contentType: ct, width: 1920, height: 1080, bitrate: 8e6, framerate: 30 } });
                out["webrtc " + ct] = { supported: r.supported, smooth: r.smooth, hardware: r.powerEfficient };
            } catch (e) { out["webrtc " + ct] = "erro: " + String(e); }
        }
    } catch (e) { out.mediaCapabilities = "erro: " + String(e); }
    try {
        const VE: any = (window as any).VideoEncoder;
        if (!VE) out.webcodecs = "sem VideoEncoder";
        else {
            for (const [name, codec] of [["h264", "avc1.640029"], ["vp9", "vp09.00.40.08"], ["av1", "av01.0.08M.08"]]) {
                for (const hw of ["prefer-hardware", "prefer-software"]) {
                    try {
                        const r = await VE.isConfigSupported({ codec, width: 1920, height: 1080, bitrate: 8e6, framerate: 60, hardwareAcceleration: hw, latencyMode: "realtime" });
                        out[`webcodecs ${name} ${hw}`] = !!r.supported;
                    } catch (e) { out[`webcodecs ${name} ${hw}`] = "erro: " + String(e); }
                }
            }
        }
    } catch (e) { out.webcodecs = "erro: " + String(e); }
    return out;
}

function me() {
    return UserStore.getCurrentUser()?.id as string | undefined;
}

function others(): string[] {
    if (!channelId) return [];
    const self = me();
    return Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {}).filter(id => id !== self);
}

async function resolveUser(hash: string): Promise<string | null> {
    if (!channelId) return null;
    for (const id of others()) {
        if (await userHash(channelId, id) === hash) return id;
    }
    return null;
}

// Traduz "quem esta ao vivo" (hashes) em pessoas da chamada e registra no HUD nativo
async function applyPresence() {
    const h = hub;
    if (!h) return;
    const seen = new Set<string>();
    for (const [hash, info] of h.presence) {
        const id = await resolveUser(hash);
        if (!id) continue;
        seen.add(id);
        const cur = getLiveEntry(id);
        if (!cur || cur.label !== info.label) setLiveEntry(id, { label: info.label, local: false });
    }
    for (const id of others()) {
        if (seen.has(id)) continue;
        const cur = getLiveEntry(id);
        if (!cur) continue;
        if (handles.has(id)) unwatch(id);
        setLiveEntry(id, null);
    }
}

async function watch(userId: string) {
    const self = me();
    if (!hub || !channelId || !self || handles.has(userId)) return;
    try {
        plog(`assistir: clicou para assistir ${displayName(userId)}`);
        const hash = await userHash(channelId, userId);
        const h = await hub.watch(hash, self);
        handles.set(userId, h);
        h.onClosed = () => unwatch(userId);
        const session = createMarkSession(() => h.caps.marks, m => h.sendMark(m));
        // o nome vem do apelido que ESTE Discord mostra para a pessoa na chamada
        h.onMark = m => { session.board.apply({ ...m, n: m.from ? displayName(m.from) : m.n }, performance.now()); session.wake(); };
        h.onCaps = () => notifyMarkSessions();
        registerMarkSession(userId, session);
        setLiveEntry(userId, { watching: true, stream: h.stream, label: h.info.label, local: false });
    } catch (e) {
        console.warn("[pdLink] nao consegui assistir", e);
        plog(`assistir: nao consegui assistir ${displayName(userId)} - ${String(e)}`);
        hubError = String(e);
    }
}

function unwatch(userId: string) {
    dropMarkSession(userId);
    const h = handles.get(userId);
    h?.close();
    handles.delete(userId);
    if (getLiveEntry(userId)) setLiveEntry(userId, { watching: false, stream: undefined });
}

function teardownChannel() {
    bindFiles(null);
    stopMusic();
    hashCache.clear();
    overlayKey = "";
    lastMarksAllowed = null;
    nativeCall("overlayStop");
    clearInterval(resolveTimer);
    resolveTimer = null;
    for (const id of [...handles.keys()]) unwatch(id);
    hub?.stop();
    hub = null;
    for (const id of others()) if (getLiveEntry(id)) setLiveEntry(id, null);
    const self = me();
    if (self && getLiveEntry(self)) setLiveEntry(self, null);
}

async function syncChannel() {
    const now = (SelectedChannelStore.getVoiceChannelId() as string | null) ?? null;
    if (now === channelId) return;
    // saiu da call ou trocou de call: a live acaba aqui (como no Go Live do Discord). Sem isso, a captura continuava
    // ligada e passava a transmitir para a proxima call em que a pessoa entrasse.
    // (sem await: stop() ja marca a live como parada na hora; esperar aqui deixaria duas trocas de canal se atropelarem)
    if (getLive().running) getLive().stop().catch(() => { });
    teardownChannel();
    plog(now ? "call: entrou numa call" : "call: saiu da call");
    channelId = now;
    lastRunning = false;
    if (!channelId) return;
    const self = me();
    if (!self) return;
    const h = new Hub(channelId, self);
    hub = h;
    h.onPresence = () => { applyPresence(); };
    h.onViewers = ids => setLiveEntry(self, { viewers: ids });
    h.nameOf = displayName;
    // arquivos: so aceito oferta de quem esta na chamada agora
    bindFiles({ hub: h, myId: self, nameOf: fullName });
    startMusic(h, self, displayName, id => others().includes(id)).then(() => { if (hub === h) refreshPeers(); else stopMusic(); }).catch(() => { });
    h.onFileOffer = (from, offer) => { if (others().includes(from)) handleOffer(from, fullName(from), offer); };
    h.onMods = () => { refreshPeers(); };
    h.onMark = (_uid, m: Mark) => nativeCall("overlayMark", JSON.stringify(m));
    // so assiste quem o Discord mostra na mesma chamada agora (ou a pagina de teste aberta neste PC)
    h.isAllowedViewer = m => {
        if (m?.userId && m.userId !== self && others().includes(m.userId)) return true;
        return !!m?.localToken && !!localToken && m.localToken === localToken;
    };
    resolveTimer = setInterval(() => { applyPresence(); refreshPeers(); }, 5000);
    try {
        await h.connect();
        hubError = "";
        syncLive();
    } catch (e) {
        hubError = String(e);
        console.warn("[pdLink] ponto de encontro indisponivel", e);
        plog("ponto de encontro: nenhum respondeu - " + String(e));
    }
}

function syncLive() {
    const live = getLive();
    const self = me();
    if (!self || !channelId || !hub) return;
    syncOverlay();
    const label = live.source?.label ?? "";
    if (live.running === lastRunning && label === lastLabel) {
        if (live.running) hub.updateBroadcast();
        return;
    }
    const startedNow = live.running && !lastRunning;
    lastRunning = live.running;
    lastLabel = label;
    if (live.running) {
        buildWatchUrl().then(u => { watchUrl = u; saveProbe("watch-url.txt", u); }).catch(() => { });
        setLiveEntry(self, { local: true, watching: true, label });
        plog(`live: comecou ("${label}", ${live.prefs.maxH}p ${live.prefs.fps} fps)`);
        hub.startBroadcast(
            () => ({ label: live.source?.label ?? "Live", fps: live.prefs.fps, maxH: live.prefs.maxH }),
            () => live.getVideoTrack(),
            () => (live.prefs.muteAudio ? null : live.getAudioTrack()),
            cb => live.addFrameSink(cb),
            {
                active: () => live.videoMode === "h264",
                config: () => live.videoConfig,
                onChunk: cb => live.addEncodedSink(cb),
                onConfig: cb => live.addConfigSink(cb),
                requestKey: () => live.requestKeyFrame()
            }
        );
    } else {
        plog("live: terminou");
        hub.stopBroadcast();
        watchUrl = "";
        if (getLiveEntry(self)) setLiveEntry(self, null);
    }
    if (live.running && !encoderCaps) encoderCapabilities().then(c => { encoderCaps = c; });
    if (live.running && !statsTimer) {
        statsTimer = setInterval(async () => {
            if (!hub || !getLive().running) return;
            try {
                const rows = await hub.stats();
                const helperStatus = await (Native as any).status?.().catch?.(() => null);
                if (rows.length) await saveProbe("webrtc-stats.json", JSON.stringify({ at: new Date().toISOString(), rows, audio: getLive().audioState(), perf: getLive().perf, video: { modo: getLive().videoMode, config: getLive().videoConfig, codificador: getLive().encoderName }, codecs: videoCodecs(), encoderCaps, helper: helperStatus }, null, 1));
            } catch { }
        }, 5000);
    } else if (!live.running && statsTimer) {
        clearInterval(statsTimer);
        statsTimer = null;
    }
    if (startedNow) {
        for (const ms of [2500, 9000]) {
            setTimeout(() => {
                try {
                    saveProbe("status-" + ms + ".json", JSON.stringify({ ...nativeUiDiagnostics(), broker: hub?.brokerUsed, hubError, hubPresence: hub ? [...hub.presence.keys()] : [] }, null, 1));
                } catch { }
            }, ms);
        }
    }
}

export function startManager() {
    if (started) return;
    started = true;
    // uma captura que sobrou de antes (ex.: a tela do Discord recarregou no meio de uma live) e encerrada ao iniciar
    getLive().stop().catch(() => { });
    getLocalToken().then(t => { localToken = t; }).catch(() => { });
    callbacks.watch = userId => { watch(userId); };
    callbacks.unwatch = userId => unwatch(userId);
    unsubLive = getLive().subscribe(syncLive);
    channelListener = () => { syncChannel().catch(e => console.error("[pdLink]", e)); };
    (SelectedChannelStore as any).addChangeListener(channelListener);
    // o plugin pode iniciar com o usuario ja numa chamada
    setTimeout(channelListener, 3000);

    // autoteste de ponta a ponta, so quando pedido por arquivo-bandeira
    setTimeout(async () => {
        try {
            if (await takeFlag("selftest")) {
                const r = await selfTest();
                await saveProbe("selftest.json", JSON.stringify(r, null, 1));
            }
        } catch (e) {
            await saveProbe("selftest.json", JSON.stringify({ ok: false, error: String(e) }));
        }
    }, 6000);
}

export function stopManager() {
    if (!started) return;
    started = false;
    unsubLive?.();
    if (getLive().running) getLive().stop().catch(() => { });
    (SelectedChannelStore as any).removeChangeListener(channelListener);
    teardownChannel();
    channelId = null;
    uninstallNativeUi();
}
