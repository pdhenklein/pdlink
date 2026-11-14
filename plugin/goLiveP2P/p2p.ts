import { FrameReceiver, HwDecoder, HwEncoder, LatestFramePainter, sendFrame } from "./hwvideo";
import { FileEngine, FileOffer, sanitizeOffer } from "./fileXfer";
import { Mark, sanitizeMark } from "./marksCore";
import { plog, since } from "./logger";
import { MqttClient } from "./mqtt";

// Brokers MQTT publicos, usados so para sinalizacao (textos de conexao e "quem esta ao vivo").
const BROKERS = ["wss://broker.emqx.io:8084/mqtt", "wss://broker.hivemq.com:8884/mqtt"];

export const ICE: RTCConfiguration = {
    iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }]
};

const MAX_VIEWERS = 4;

export interface LiveInfo {
    label: string;
    fps: number;
    maxH: number;
}

export interface Presence extends LiveInfo {
    inbox: string;
}

async function sha(text: string, len: number) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}

export const channelHash = (channelId: string) => sha(`golive-p2p:v1:channel:${channelId}`, 24);
export const userHash = (channelId: string, userId: string) => sha(`golive-p2p:v1:user:${channelId}:${userId}`, 24);


function rand() {
    return [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");
}

function bitrateFor(info: LiveInfo) {
    const h = info.maxH || 1080;
    const base = h >= 1440 ? 12e6 : h >= 1080 ? 8e6 : 4e6;
    return Math.round(base * (info.fps >= 60 ? 1 : info.fps >= 30 ? 0.7 : 0.5));
}


/** Faz o codificador comecar ja numa taxa alta (sem isso o WebRTC comeca baixo e demora a subir). */
function boostSdp(sdp: string, info: LiveInfo) {
    const max = Math.round(bitrateFor(info) / 1000);
    const start = Math.round(max * 0.8);
    const min = Math.round(max * 0.4);
    const params = `x-google-min-bitrate=${min};x-google-start-bitrate=${start};x-google-max-bitrate=${max}`;
    const lines = sdp.split("\r\n");
    const out: string[] = [];
    let inVideo = false;
    const pts: string[] = [];
    const hasFmtp = new Set<string>();
    for (const l of lines) {
        if (l.startsWith("m=")) inVideo = l.startsWith("m=video");
        if (inVideo) {
            const m = /^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\//.exec(l);
            if (m) pts.push(m[1]);
            const f = /^a=fmtp:(\d+) /.exec(l);
            if (f) hasFmtp.add(f[1]);
        }
    }
    inVideo = false;
    for (const l of lines) {
        if (l.startsWith("m=")) inVideo = l.startsWith("m=video");
        if (inVideo) {
            const f = /^a=fmtp:(\d+) /.exec(l);
            if (f && pts.includes(f[1])) { out.push(l + ";" + params); continue; }
        }
        out.push(l);
        if (inVideo) {
            const m = /^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\//.exec(l);
            if (m && !hasFmtp.has(m[1])) out.push(`a=fmtp:${m[1]} ${params}`);
        }
    }
    return out.join("\r\n");
}

function preferCodecs(tr: RTCRtpTransceiver): string {
    try {
        const caps = RTCRtpSender.getCapabilities("video")?.codecs;
        if (!caps) return "sem capacidades";
        const rank = (c: RTCRtpCodec) => {
            const m = c.mimeType.toLowerCase();
            if (m.includes("vp9")) return 0;
            if (m.includes("av1")) return 1;
            if (m.includes("h264")) return 2;
            if (m.includes("vp8")) return 3;
            return 9;
        };
        tr.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b)));
        return "ok";
    } catch (e) {
        return "erro: " + String(e);
    }
}

/** Poe o VP9 (multi-thread, o unico fluido em software a 1080p neste Discord) na frente da lista de codecs da oferta. */
function reorderVideoCodecs(sdp: string) {
    const lines = sdp.split("\r\n");
    const mIdx = lines.findIndex(l => l.startsWith("m=video"));
    if (mIdx < 0) return sdp;
    const names = new Map<string, string>();
    for (const l of lines) {
        const m = /^a=rtpmap:(\d+) ([A-Za-z0-9]+)\//.exec(l);
        if (m) names.set(m[1], m[2].toUpperCase());
    }
    const head = lines[mIdx].split(" ");
    const pts = head.slice(3);
    const rank = (pt: string) => {
        const n = names.get(pt) ?? "";
        return n === "VP9" ? 0 : n === "AV1" ? 1 : n === "H264" ? 2 : n === "VP8" ? 3 : 9;
    };
    const sorted = [...pts].sort((a, b) => rank(a) - rank(b));
    lines[mIdx] = [...head.slice(0, 3), ...sorted].join(" ");
    return lines.join("\r\n");
}

/** Fonte de H.264 pronto (o auxiliar comprimindo na placa de video). */
export interface EncodedSource {
    active(): boolean;
    config(): any;
    onChunk(cb: (key: boolean, ts: number, data: Uint8Array) => void): () => void;
    onConfig(cb: (cfg: any) => void): () => void;
    requestKey(): void;
}

export interface WatchHandle {
    /** O transmissor aceita marcacoes (ping e desenho) dos espectadores? */
    caps: { marks: boolean; };
    onCaps?: () => void;
    /** Marcacao de outro espectador (repassada pelo transmissor), ja com `from` e `n`. */
    onMark?: (m: Mark) => void;
    sendMark(m: Mark): void;
    stream: MediaStream;
    mode?: string;
    stats?: () => any;
    info: LiveInfo;
    onClosed?: () => void;
    close(): void;
}

interface BroadcastConn {
    pc: RTCPeerConnection;
    from: string;
    userId?: string;
    cands: RTCIceCandidateInit[]; // meus candidatos, repetidos junto com a resposta (o ponto de encontro perde mensagens)
    answer?: any; // resposta ja enviada: se o espectador pedir de novo, vai a mesma
    t0: number;
}

/** Ponto de encontro de um canal de voz: presenca ("quem esta ao vivo") + caixa de mensagens privada. */
export class Hub {
    private mqtt: MqttClient | null = null;
    private ch = "";
    private inboxTopic = "";
    private presenceTopic = "";
    private refreshTimer: any = null;
    private stopped = false;
    private announced: Presence | null = null;
    private reconnectTimer: any = null;
    brokerUsed = "";

    private conns = new Map<string, BroadcastConn>();
    private negotiations = new Map<string, any>();
    private encoder: HwEncoder | null = null;
    private dcs = new Set<RTCDataChannel>();
    private markChans = new Map<RTCDataChannel, string>();
    private waitKey = new WeakSet<RTCDataChannel>();
    private attachSource: ((cb: (c: HTMLCanvasElement) => void) => () => void) | null = null;
    private sinkOff: (() => void) | null = null;
    private encoded: EncodedSource | null = null;
    private encodedOff: (() => void) | null = null;
    hwStats = { skipped: 0, sent: 0 };
    private viewing = new Map<string, { pc: RTCPeerConnection; resolve?: (m: any) => void; }>();
    private getTrack: (() => MediaStreamTrack) | null = null;
    private getAudio: (() => MediaStreamTrack | null) | null = null;
    private getInfo: (() => LiveInfo) | null = null;

    presence = new Map<string, Presence>();
    onPresence: (userHash: string, info: Presence | null) => void = () => { };
    onViewers: (userIds: string[]) => void = () => { };
    /** Decide quem pode assistir (por padrao, ninguem). */
    isAllowedViewer: (offer: any) => boolean = () => false;
    deniedCount = 0;
    error = "";
    /** Marcacao recebida de um espectador (para desenhar na tela de quem transmite). */
    onMark: (userId: string, m: Mark) => void = () => { };
    /** Nome para exibir junto da marcacao. */
    nameOf: (userId: string) => string = () => "";
    private marksAllowed = true;
    /** Arquivos: o motor usa a mesma caixa de mensagens (MQTT) para combinar a conexao direta. */
    readonly files = new FileEngine(() => (this.mqtt ? { send: (inbox: string, msg: any) => this.send(inbox, msg), inbox: this.inboxTopic } : null), ICE);
    /** Alguem da chamada ofereceu um arquivo para mim. */
    onFileOffer: (fromId: string, offer: FileOffer) => void = () => { };
    /** Quem na chamada tem o mod (hash do usuario -> ultima vez visto). */
    mods = new Map<string, number>();
    onMods: () => void = () => { };
    private modTopic = "";
    private filesTopic = "";
    private modTimer: any = null;
    private musicTopic = "";
    /** Musica: estado da fila que chegou da chamada. */
    onMusic: (text: string) => void = () => { };

    constructor(private channelId: string, private myUserId: string) { }

    async connect() {
        this.ch = await channelHash(this.channelId);
        const mine = await userHash(this.channelId, this.myUserId);
        this.presenceTopic = `glp/v1/${this.ch}/live/${mine}`;
        this.inboxTopic = `glp/v1/${this.ch}/in/${rand()}`;
        this.modTopic = `glp/v1/${this.ch}/mod/${mine}`;
        this.filesTopic = `glp/v1/${this.ch}/fx/${mine}`;
        this.musicTopic = `glp/v1/${this.ch}/mu2`;
        await this.open();
    }

    private async open() {
        let lastErr: any;
        for (const url of BROKERS) {
            const m = new MqttClient();
            try {
                await m.connect(url, "glp" + rand(), { topic: this.presenceTopic, payload: "", retain: true });
                this.mqtt = m;
                this.brokerUsed = url;
                plog(`ponto de encontro: conectado (${url.replace(/^wss?:\/\//, "").split("/")[0]})`);
                m.onClose = () => { if (this.mqtt === m && !this.stopped) { plog("ponto de encontro: conexao caiu, reconectando"); this.scheduleReconnect(); } };
                m.subscribe(`glp/v1/${this.ch}/live/+`, (t, p) => this.onPresenceMsg(t, p));
                m.subscribe(this.inboxTopic, (_t, p) => this.onInbox(p));
                m.subscribe(`glp/v1/${this.ch}/mod/+`, (t, p) => this.onModMsg(t, p));
                m.subscribe(this.filesTopic, (_t, p) => this.onFilesTopic(p));
                m.subscribe(this.musicTopic, (_t, p) => { if (p) this.onMusic(p); });
                this.announceMod();
                if (!this.modTimer) this.modTimer = setInterval(() => this.announceMod(), 20000);
                if (this.announced) this.announce(this.announced);
                return;
            } catch (e) {
                lastErr = e;
                plog(`ponto de encontro: ${url.replace(/^wss?:\/\//, "").split("/")[0]} nao respondeu (${String(e).slice(0, 120)})`);
                m.close();
            }
        }
        throw lastErr ?? new Error("nenhum broker respondeu");
    }

    private scheduleReconnect() {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            if (this.stopped) return;
            this.open().catch(() => this.scheduleReconnect());
        }, 3000);
    }

    private onPresenceMsg(topic: string, payload: string) {
        const hash = topic.split("/").pop()!;
        if (!payload) {
            if (this.presence.delete(hash)) this.onPresence(hash, null);
            return;
        }
        try {
            const info = JSON.parse(payload) as Presence & { at?: number; };
            if (info.at && Date.now() - info.at > 90000) {
                if (this.presence.delete(hash)) this.onPresence(hash, null);
                return;
            }
            this.presence.set(hash, info);
            this.onPresence(hash, info);
        } catch { }
    }

    // ---------------------------------------------------------- quem tem o mod na chamada + ofertas de arquivo

    /** Avisa a chamada que eu tenho o mod (renovado a cada 20 s; some sozinho se o Discord fechar). */
    private announceMod() {
        this.mqtt?.publish(this.modTopic, JSON.stringify({ at: Date.now() }), true);
    }

    private onModMsg(topic: string, payload: string) {
        const hash = topic.split("/").pop()!;
        if (!payload) { if (this.mods.delete(hash)) this.onMods(); return; }
        try {
            const at = Number(JSON.parse(payload).at) || 0;
            if (Date.now() - at > 70000) { if (this.mods.delete(hash)) this.onMods(); return; }
            const had = this.mods.has(hash);
            this.mods.set(hash, at);
            if (!had) this.onMods();
        } catch { }
    }

    /** Musica do PC: pedidos e respostas da conexao de som ao vivo. */
    onMusicSignal: (m: any) => void = () => { };
    musicSignal() {
        return this.mqtt ? { send: (inbox: string, msg: any) => this.send(inbox, msg), inbox: this.inboxTopic } : null;
    }

    /** Musica: publica o estado da fila para a chamada (`keep` = fica guardado para quem entrar depois). */
    publishMusic(text: string, keep: boolean) {
        this.mqtt?.publish(this.musicTopic, text, keep);
    }

    /** Oferece um arquivo (ja registrado em `files`) a esses usuarios; so eles recebem o aviso. */
    async sendFileOffer(toUserIds: string[], offer: FileOffer) {
        for (const id of toUserIds) {
            const h = await userHash(this.channelId, id);
            this.mqtt?.publish(`glp/v1/${this.ch}/fx/${h}`, JSON.stringify({ t: "foffer", ...offer, fromId: this.myUserId }));
        }
    }

    private onFilesTopic(payload: string) {
        let m: any;
        try { m = JSON.parse(payload); } catch { return; }
        if (m?.t !== "foffer" || typeof m.fromId !== "string" || !/^\d{5,25}$/.test(m.fromId)) return;
        const offer = sanitizeOffer(m);
        if (offer) this.onFileOffer(m.fromId, offer);
    }

    // ---------------------------------------------------------- transmissor

    announce(info: Presence) {
        this.announced = info;
        const text = JSON.stringify({ ...info, at: Date.now() });
        this.mqtt?.publish(this.presenceTopic, text, true);
        // renova a presenca: se o Discord fechar sem avisar, quem assiste percebe pela idade da mensagem
        if (!this.refreshTimer) this.refreshTimer = setInterval(() => { if (this.announced) this.announce(this.announced); }, 20000);
    }

    unannounce() {
        this.announced = null;
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
        this.mqtt?.publish(this.presenceTopic, "", true);
    }

    startBroadcast(
        getInfo: () => LiveInfo,
        getTrack: () => MediaStreamTrack,
        getAudio?: () => MediaStreamTrack | null,
        attachSource?: (cb: (c: HTMLCanvasElement) => void) => () => void,
        encoded?: EncodedSource
    ) {
        this.attachSource = attachSource ?? null;
        this.encoded = encoded ?? null;
        this.getInfo = getInfo;
        this.getTrack = getTrack;
        this.getAudio = getAudio ?? null;
        this.announce({ ...getInfo(), inbox: this.inboxTopic });
    }

    updateBroadcast() {
        if (!this.getInfo) return;
        this.announce({ ...this.getInfo(), inbox: this.inboxTopic });
        this.applyQuality();
    }

    stopBroadcast() {
        this.closeEncoder();
        this.getInfo = null;
        this.getTrack = null;
        this.unannounce();
        for (const id of [...this.conns.keys()]) this.dropViewer(id);
    }

    viewers() {
        return [...this.conns.values()].map(c => c.userId).filter(Boolean) as string[];
    }

    private send(inbox: string, msg: any) {
        this.mqtt?.publish(inbox, JSON.stringify({ ...msg, from: this.inboxTopic }));
    }

    private onInbox(payload: string) {
        let m: any;
        try { m = JSON.parse(payload); } catch { return; }
        const id = m.connectionId as string;
        if (m.type === "FOFFER" || m.type === "FANSWER" || m.type === "FCAND") { this.files.onSignal(m); return; }
        if (m.type === "MOFFER" || m.type === "MANSWER") { this.onMusicSignal(m); return; }
        if (m.type === "OFFER") this.acceptOffer(m).catch(e => { this.error = String(e); });
        else if (m.type === "CANDIDATE") {
            const c = this.conns.get(id)?.pc ?? this.viewing.get(id)?.pc;
            if (c && m.candidate) c.addIceCandidate(m.candidate).catch(() => { });
        } else if (m.type === "ANSWER") this.viewing.get(id)?.resolve?.(m);
        else if (m.type === "LEAVE") this.dropViewer(id);
    }

    // ---------------------------------------------------------- video por hardware (canal de dados)

    /** Caminho preferido: o auxiliar ja entrega H.264 da placa de video; aqui so repassamos os bytes. */
    private usingHelperH264() {
        return !!this.encoded && this.encoded.active();
    }

    private ensureEncodedRelay() {
        if (this.encodedOff || !this.encoded) return;
        const offData = this.encoded.onChunk((key, ts, data) => this.fanOut(key, ts, data));
        const offCfg = this.encoded.onConfig(cfg => { this.broadcastText({ t: "cfg", ...cfg }); this.encoded?.requestKey(); });
        this.encodedOff = () => { offData(); offCfg(); };
    }

    private requestKey() {
        if (this.usingHelperH264()) this.encoded!.requestKey();
        else this.encoder?.requestKey();
    }

    private ensureEncoder() {
        if (this.encoder) return this.encoder;
        const e = new HwEncoder();
        e.onConfig = cfg => this.broadcastText({ t: "cfg", ...cfg });
        e.onChunk = (key, ts, data) => this.fanOut(key, ts, data);
        this.encoder = e;
        this.sinkOff = this.attachSource?.(canvas => this.onCanvas(canvas)) ?? null;
        return e;
    }

    private closeEncoder() {
        this.encodedOff?.();
        this.encodedOff = null;
        this.sinkOff?.();
        this.sinkOff = null;
        this.encoder?.close();
        this.encoder = null;
    }

    private onCanvas(canvas: HTMLCanvasElement) {
        if (!this.encoder || this.dcs.size === 0 || !this.getInfo) return;
        const info = this.getInfo();
        this.encoder.encode(canvas, Math.round(performance.now() * 1000), bitrateFor(info), Math.max(30, info.fps));
    }

    private broadcastText(msg: any) {
        const text = JSON.stringify(msg);
        for (const dc of this.dcs) if (dc.readyState === "open") { try { dc.send(text); } catch { } }
    }

    private fanOut(key: boolean, ts: number, data: Uint8Array) {
        for (const dc of this.dcs) {
            if (dc.readyState !== "open") continue;
            if (dc.bufferedAmount > 3_000_000 && !key) {
                // espectador atrasado: pula quadros ate o proximo quadro-chave (nada corrompido na tela dele)
                this.waitKey.add(dc);
                this.hwStats.skipped++;
                this.requestKey();
                continue;
            }
            if (this.waitKey.has(dc)) {
                if (!key) continue;
                this.waitKey.delete(dc);
            }
            try { sendFrame(dc, key, ts, data); this.hwStats.sent++; } catch { }
        }
    }

    private onDataChannel(dc: RTCDataChannel) {
        dc.binaryType = "arraybuffer";
        dc.onopen = () => {
            this.dcs.add(dc);
            if (this.usingHelperH264()) {
                this.ensureEncodedRelay();
                const cfg = this.encoded!.config();
                if (cfg) { try { dc.send(JSON.stringify({ t: "cfg", ...cfg })); } catch { } }
                this.encoded!.requestKey();
                return;
            }
            const e = this.ensureEncoder();
            if (e.config) { try { dc.send(JSON.stringify({ t: "cfg", ...e.config })); } catch { } }
            e.requestKey();
        };
        dc.onmessage = ev => {
            if (typeof ev.data !== "string") return;
            try { if (JSON.parse(ev.data).t === "key") this.requestKey(); } catch { }
        };
        dc.onclose = () => {
            this.dcs.delete(dc);
            if (this.dcs.size === 0) this.closeEncoder();
        };
    }

    // ---------------------------------------------------------- marcacoes (ping e desenho)

    setMarksAllowed(on: boolean) {
        this.marksAllowed = on;
        const text = JSON.stringify({ t: "caps", marks: on });
        for (const dc of this.markChans.keys()) if (dc.readyState === "open") { try { dc.send(text); } catch { } }
    }

    private onMarkChannel(dc: RTCDataChannel, userId?: string) {
        let windowStart = 0, inWindow = 0;
        dc.onopen = () => {
            this.markChans.set(dc, userId ?? "");
            try { dc.send(JSON.stringify({ t: "caps", marks: this.marksAllowed })); } catch { }
        };
        dc.onmessage = ev => {
            if (!this.marksAllowed || !userId || typeof ev.data !== "string" || ev.data.length > 8192) return;
            // no maximo ~150 mensagens por segundo por espectador
            const now = performance.now();
            if (now - windowStart > 1000) { windowStart = now; inWindow = 0; }
            if (++inWindow > 150) return;
            let raw: any;
            try { raw = JSON.parse(ev.data); } catch { return; }
            const clean = sanitizeMark(raw);
            if (!clean) return;
            const stamped: Mark = { ...clean, from: userId, n: this.nameOf(userId).slice(0, 32) };
            this.onMark(userId, stamped);
            const text = JSON.stringify(stamped);
            for (const [other] of this.markChans) {
                if (other !== dc && other.readyState === "open") { try { other.send(text); } catch { } }
            }
        };
        dc.onclose = () => {
            if (!this.markChans.delete(dc) || !userId) return;
            // quem saiu leva o desenho embora
            const bye: Mark = { t: "clear", from: userId };
            this.onMark(userId, bye);
            const text = JSON.stringify(bye);
            for (const other of this.markChans.keys()) if (other.readyState === "open") { try { other.send(text); } catch { } }
        };
    }

    private async acceptOffer(m: any) {
        const again = this.conns.get(m.connectionId);
        if (again) {
            // pedido repetido (a resposta ou candidatos podem ter se perdido): reaproveita a conexao, nada e renegociado
            if (again.pc.remoteDescription) for (const c of Array.isArray(m.cands) ? m.cands : []) again.pc.addIceCandidate(c).catch(() => { });
            if (again.answer) this.send(again.from, { ...again.answer, cands: again.cands });
            return;
        }
        if (!this.getTrack || !this.getInfo || this.conns.size >= MAX_VIEWERS) return;
        if (!this.isAllowedViewer(m)) {
            plog(`live: pedido recusado (${m.userId ? this.nameOf(m.userId) || "alguem" : "sem usuario"} nao esta na chamada)`);
            // quem nao esta na sua chamada nao recebe nada alem da recusa
            this.deniedCount++;
            this.send(m.from, { type: "ANSWER", connectionId: m.connectionId, denied: true });
            return;
        }
        const id: string = m.connectionId;
        const pc = new RTCPeerConnection(ICE);
        const who = m.userId ? this.nameOf(m.userId) || "espectador" : "pagina local";
        const conn: BroadcastConn = { pc, from: m.from, userId: m.userId, cands: [], t0: performance.now() };
        this.conns.set(id, conn);
        plog(`live: ${who} pediu para assistir (${id})`);
        pc.onicecandidate = ev => {
            if (!ev.candidate) return;
            const c = ev.candidate.toJSON();
            conn.cands.push(c);
            this.send(m.from, { type: "CANDIDATE", connectionId: id, candidate: c });
        };
        pc.onconnectionstatechange = () => {
            plog(`live: conexao com ${who} -> ${pc.connectionState} (${since(conn.t0)})`);
            if (["failed", "closed", "disconnected"].includes(pc.connectionState)) this.dropViewer(id);
            else this.onViewers(this.viewers());
        };
        const useHw = !!m.hw && HwEncoder.available();
        pc.ondatachannel = ev => {
            if (ev.channel.label === "m") this.onMarkChannel(ev.channel, m.userId);
            else if (useHw) this.onDataChannel(ev.channel);
        };
        await pc.setRemoteDescription({ type: "offer", sdp: useHw ? m.sdp : boostSdp(reorderVideoCodecs(m.sdp), this.getInfo()) });
        for (const c of Array.isArray(m.cands) ? m.cands : []) pc.addIceCandidate(c).catch(() => { });
        const track = this.getTrack();
        const neg: any = { offer: (m.sdp.split("\r\n").find((l: string) => l.startsWith("m=video")) ?? "").slice(0, 120) };
        const tr = pc.getTransceivers().find(t => t.receiver.track.kind === "video");
        if (useHw) {
            // video vai pelo canal de dados (comprimido pela placa de video); o WebRTC nao codifica nada
            if (tr) tr.direction = "inactive";
            neg.mode = "hardware";
        } else if (tr) {
            tr.direction = "sendonly";
            neg.pref = preferCodecs(tr);
            await tr.sender.replaceTrack(track);
            neg.mode = "rtp";
        } else pc.addTrack(track);
        const atr = pc.getTransceivers().find(t => t.receiver.track.kind === "audio");
        const audio = this.getAudio?.();
        if (atr && audio) {
            atr.direction = "sendonly";
            await atr.sender.replaceTrack(audio);
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        neg.answer = (answer.sdp ?? "").split("\r\n").find(l => l.startsWith("m=video"))?.slice(0, 120);
        neg.answerFirstCodec = (() => {
            const first = /^m=video \d+ \S+ (\d+)/.exec(neg.answer ?? "")?.[1];
            return (answer.sdp ?? "").split("\r\n").find(l => l.startsWith(`a=rtpmap:${first} `));
        })();
        this.negotiations.set(id, neg);
        await this.applyQuality(pc);
        // a live pode ter acabado durante a negociacao: ninguem recebe resposta de uma live encerrada
        if (!this.getTrack || !this.getInfo || this.conns.get(id)?.pc !== pc) {
            try { pc.close(); } catch { }
            this.conns.delete(id);
            return;
        }
        conn.answer = { type: "ANSWER", connectionId: id, sdp: answer.sdp, info: { ...this.getInfo(), mode: useHw ? "dc" : "rtp" } };
        this.send(m.from, { ...conn.answer, cands: conn.cands });
        // a resposta vai duas vezes (a segunda ja leva os candidatos que surgiram nesse meio tempo)
        setTimeout(() => { if (this.conns.get(id) === conn) this.send(m.from, { ...conn.answer, cands: conn.cands }); }, 500);
        plog(`live: resposta enviada para ${who} (modo ${useHw ? "placa de video" : "rtp"}, ${since(conn.t0)})`);
    }

    async applyQuality(only?: RTCPeerConnection) {
        const info = this.getInfo?.();
        if (!info) return;
        const list = only ? [only] : [...this.conns.values()].map(c => c.pc);
        for (const pc of list) {
            for (const s of pc.getSenders()) {
                if (s.track?.kind !== "video") continue;
                try {
                    const params = s.getParameters();
                    if (!params.encodings?.length) params.encodings = [{}];
                    params.encodings[0].maxBitrate = bitrateFor(info);
                    params.encodings[0].maxFramerate = info.fps;
                    (params as any).degradationPreference = info.fps >= 30 ? "maintain-framerate" : "maintain-resolution";
                    await s.setParameters(params);
                } catch { }
            }
        }
    }

    /** Estatisticas reais do envio (codec, fps, limite de qualidade) para diagnostico. */
    async stats() {
        const out: any[] = [];
        for (const [id, c] of this.conns) {
            const row: any = { id, state: c.pc.connectionState, neg: this.negotiations.get(id) };
            try {
                const r = await c.pc.getStats();
                const codecs = new Map<string, string>();
                r.forEach((x: any) => { if (x.type === "codec") codecs.set(x.id, x.mimeType); });
                r.forEach((x: any) => {
                    if (x.type === "outbound-rtp" && x.kind === "video") {
                        Object.assign(row, {
                            codec: codecs.get(x.codecId), encoder: x.encoderImplementation, fps: x.framesPerSecond,
                            size: `${x.frameWidth}x${x.frameHeight}`, limit: x.qualityLimitationReason,
                            sentKB: Math.round(x.bytesSent / 1024), framesEncoded: x.framesEncoded, powerEfficient: x.powerEfficientEncoder
                        });
                    }
                    if (x.type === "outbound-rtp" && x.kind === "audio") row.audioSentKB = Math.round(x.bytesSent / 1024);
                    if (x.type === "candidate-pair" && x.state === "succeeded" && x.nominated) row.bwe = Math.round((x.availableOutgoingBitrate ?? 0) / 1000) + " kbps";
                });
            } catch (e) { row.error = String(e); }
            out.push(row);
        }
        out.push({
            recusados: this.deniedCount,
            caminho: this.usingHelperH264() ? "H.264 da placa de video (auxiliar)" : this.encoder ? "WebCodecs no Discord" : "WebRTC",
            hw: {
                canais: this.dcs.size, codificadas: this.encoder?.encoded ?? 0, descartadasNoCodificador: this.encoder?.dropped ?? 0,
                hardware: this.encoder?.hardware, config: this.encoder?.config, erro: this.encoder?.error,
                enviadas: this.hwStats.sent, puladasPorAtraso: this.hwStats.skipped
            }
        });
        return out;
    }

    private dropViewer(id: string) {
        const c = this.conns.get(id);
        if (!c) return;
        plog(`live: espectador ${c.userId ? this.nameOf(c.userId) || "?" : "local"} saiu (${id})`);
        try { c.pc.close(); } catch { }
        this.conns.delete(id);
        this.onViewers(this.viewers());
    }

    // ---------------------------------------------------------- espectador

    async watch(userHashOfTarget: string, myDiscordId: string, timeoutMs = 20000): Promise<WatchHandle> {
        const target = this.presence.get(userHashOfTarget);
        if (!target) throw new Error("a pessoa nao esta ao vivo");
        const id = "w" + rand();
        const pc = new RTCPeerConnection(ICE);
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });
        const stream = new MediaStream();
        // canal proprio das marcacoes: pacotes pequenos, sem esperar atras do video
        const mdc = pc.createDataChannel("m", { ordered: true });
        let mode = "rtp";

        // caminho por hardware: video chega pelo canal de dados e e decodificado pela placa de video
        const hwOk = typeof (globalThis as any).VideoDecoder === "function";
        const dc = hwOk ? pc.createDataChannel("v", { ordered: true }) : null;
        const vcanvas = document.createElement("canvas");
        vcanvas.width = 1280;
        vcanvas.height = 720;
        const dec = new HwDecoder();
        const recv = new FrameReceiver();
        const painter = new LatestFramePainter(vcanvas);
        let vtrack: (MediaStreamTrack & { requestFrame?: () => void; }) | null = null;
        if (dc) {
            dc.binaryType = "arraybuffer";
            painter.onPaint = () => vtrack?.requestFrame?.();
            dec.onFrame = f => painter.push(f);
            dec.onNeedKey = () => { try { dc.send(JSON.stringify({ t: "key" })); } catch { } };
            recv.onFrame = (key, ts, data) => dec.push(key, ts, data);
            dc.onmessage = ev => {
                if (typeof ev.data === "string") {
                    try {
                        const o = JSON.parse(ev.data);
                        if (o.t === "cfg") dec.configure(o).then(() => dec.onNeedKey()).catch(() => { });
                    } catch { }
                } else recv.push(ev.data);
            };
        }
        pc.ontrack = ev => {
            if (ev.track.kind === "video" && mode === "dc") return;
            stream.addTrack(ev.track);
        };
        const t0 = performance.now();
        const cands: RTCIceCandidateInit[] = [];
        pc.onicecandidate = ev => {
            if (!ev.candidate) return;
            const c = ev.candidate.toJSON();
            cands.push(c);
            this.send(target.inbox, { type: "CANDIDATE", connectionId: id, candidate: c });
        };
        pc.oniceconnectionstatechange = () => plog(`assistir: rede -> ${pc.iceConnectionState} (${since(t0)})`);
        const entry: { pc: RTCPeerConnection; resolve?: (m: any) => void; } = { pc };
        this.viewing.set(id, entry);
        plog(`assistir: pedindo para assistir "${target.label ?? "live"}" (${id})`);

        // O ponto de encontro (servidor MQTT publico) as vezes perde mensagens. Entao o pedido e repetido a cada 1 s,
        // levando junto todos os meus candidatos, ate a conexao abrir; o transmissor responde de novo com os dele.
        let offerMsg: any = null;
        let tries = 0;
        const resend = setInterval(() => {
            if (!offerMsg || pc.connectionState === "connected" || pc.signalingState === "closed") return;
            tries++;
            this.send(target.inbox, { ...offerMsg, cands });
        }, 1000);
        const stopResend = () => clearInterval(resend);
        pc.addEventListener("connectionstatechange", () => {
            if (pc.connectionState === "connected") { stopResend(); plog(`assistir: conectado (${since(t0)}, pedido repetido ${tries}x)`); }
            if (pc.connectionState === "failed" || pc.connectionState === "closed") stopResend();
        });

        let answered = false;
        const info = await new Promise<LiveInfo>((resolve, reject) => {
            const fail = (why: string) => { stopResend(); this.viewing.delete(id); try { pc.close(); } catch { } plog(`assistir: falhou - ${why} (${since(t0)}, pedido repetido ${tries}x)`); reject(new Error(why)); };
            const timer = setTimeout(() => fail("a live nao respondeu"), timeoutMs);
            entry.resolve = async (m: any) => {
                if (answered) {
                    // resposta repetida: so traz candidatos que podem ter se perdido
                    for (const c of Array.isArray(m.cands) ? m.cands : []) pc.addIceCandidate(c).catch(() => { });
                    return;
                }
                answered = true;
                clearTimeout(timer);
                if (m.denied) { fail("so quem esta na mesma chamada pode assistir"); return; }
                mode = m.info?.mode ?? "rtp";
                if (mode === "dc" && dc) {
                    vtrack = vcanvas.captureStream(0).getVideoTracks()[0] as any;
                    stream.addTrack(vtrack!);
                } else mode = "rtp";
                plog(`assistir: resposta recebida (modo ${mode}, ${since(t0)}, pedido repetido ${tries}x)`);
                await pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
                for (const c of Array.isArray(m.cands) ? m.cands : []) pc.addIceCandidate(c).catch(() => { });
                // se a conexao nao abrir em 15 s depois da resposta, para de insistir e deixa registrado
                setTimeout(() => { if (pc.connectionState !== "connected" && pc.signalingState !== "closed") { plog(`assistir: conexao nao abriu (${pc.connectionState}, ${since(t0)})`); stopResend(); } }, 15000);
                resolve(m.info as LiveInfo);
            };
            pc.createOffer().then(async offer => {
                await pc.setLocalDescription(offer);
                offerMsg = { type: "OFFER", connectionId: id, sdp: offer.sdp, userId: myDiscordId, hw: hwOk };
                this.send(target.inbox, { ...offerMsg, cands });
            }).catch(e => { clearTimeout(timer); fail(String(e)); });
        });

        const handle: WatchHandle = {
            caps: { marks: false },
            sendMark: m => { if (mdc.readyState === "open") { try { mdc.send(JSON.stringify(m)); } catch { } } },
            stream, info, mode,
            stats: () => ({ mode, decoded: dec.decoded, painted: painter.painted, hardwareDecode: dec.hardware, erro: dec.error, bytes: recv.bytes }),
            close: () => {
                stopResend();
                plog(`assistir: saiu da live (${id})`);
                this.send(target.inbox, { type: "LEAVE", connectionId: id });
                this.viewing.delete(id);
                painter.stop();
                dec.close();
                try { pc.close(); } catch { }
            }
        };
        mdc.onmessage = ev => {
            if (typeof ev.data !== "string" || ev.data.length > 8192) return;
            let raw: any;
            try { raw = JSON.parse(ev.data); } catch { return; }
            if (raw?.t === "caps") {
                handle.caps.marks = !!raw.marks;
                handle.onCaps?.();
                return;
            }
            const clean = sanitizeMark(raw);
            if (!clean || typeof raw.from !== "string") return;
            handle.onMark?.({ ...clean, from: raw.from.slice(0, 32), n: typeof raw.n === "string" ? raw.n.slice(0, 32) : "" });
        };
        pc.onconnectionstatechange = () => {
            if (["failed", "closed", "disconnected"].includes(pc.connectionState)) handle.onClosed?.();
        };
        return handle;
    }

    stop() {
        this.stopped = true;
        clearInterval(this.refreshTimer);
        clearInterval(this.modTimer);
        this.modTimer = null;
        clearTimeout(this.reconnectTimer);
        this.mqtt?.publish(this.modTopic, "", true);
        this.files.close();
        this.stopBroadcast();
        for (const v of this.viewing.values()) { try { v.pc.close(); } catch { } }
        this.viewing.clear();
        this.mqtt?.close();
        this.mqtt = null;
    }
}

// ------------------------------------------------------------------ autoteste de ponta a ponta

/** Transmissor e espectador no mesmo Discord, passando pelo broker publico de verdade. */
export async function selfTest(): Promise<any> {
    const out: any = { steps: [] as string[] };
    const t0 = performance.now();
    const step = (s: string) => out.steps.push(`${Math.round(performance.now() - t0)}ms ${s}`);
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d")!;
    let n = 0;
    const timer = setInterval(() => {
        n++;
        ctx.fillStyle = "#123";
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = "#fa0";
        ctx.fillRect((n * 7) % 600, 150, 40, 40);
    }, 33);
    const track = canvas.captureStream(30).getVideoTracks()[0];
    const channel = "selftest-" + rand();
    const a = new Hub(channel, "tester");
    const b = new Hub(channel, "viewer");
    try {
        await a.connect();
        step("transmissor conectado ao broker " + a.brokerUsed);
        await b.connect();
        step("espectador conectado ao broker " + b.brokerUsed);
        a.startBroadcast(() => ({ label: "teste", fps: 30, maxH: 360 }), () => track);
        const target = await userHash(channel, "tester");
        const seen = await new Promise<boolean>(resolve => {
            const t = setTimeout(() => resolve(false), 8000);
            const check = () => { if (b.presence.has(target)) { clearTimeout(t); resolve(true); } };
            b.onPresence = check;
            check();
        });
        step(seen ? "espectador viu a presenca do transmissor" : "espectador NAO viu a presenca");
        if (!seen) throw new Error("presenca nao chegou");
        const w = await b.watch(target, "viewer");
        step("conexao WebRTC estabelecida, trilhas: " + w.stream.getTracks().length);
        const v = document.createElement("video");
        v.muted = true;
        v.srcObject = w.stream;
        await v.play().catch(() => { });
        let frames = 0;
        await new Promise<void>(resolve => {
            const end = performance.now() + 3000;
            const tick = () => {
                frames++;
                if (performance.now() < end) (v as any).requestVideoFrameCallback(tick);
                else resolve();
            };
            (v as any).requestVideoFrameCallback(tick);
            setTimeout(resolve, 6000);
        });
        out.frames = frames;
        out.size = `${v.videoWidth}x${v.videoHeight}`;
        step(`recebi ${frames} quadros em 3 s (${out.size})`);
        w.close();
        out.ok = frames > 15;
    } catch (e) {
        out.ok = false;
        out.error = String(e);
        step("falhou: " + String(e));
    } finally {
        clearInterval(timer);
        a.stop();
        b.stop();
    }
    return out;
}
