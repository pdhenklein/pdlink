import type { PluginNative } from "@utils/types";
import { FluxDispatcher } from "@webpack/common";

import { HwDecoder, h264CodecFor, VideoConfig } from "./hwvideo";
import type * as NativeTypes from "./native";

const Native = VencordNative.pluginHelpers.GoLiveP2P as PluginNative<typeof NativeTypes>;

export type Preset = "games" | "screen" | "custom";
export type CursorMode = "follow" | "always" | "never";

export interface Prefs {
    preset: Preset;
    maxH: number; // 0 = tamanho original
    fps: number;
    muteAudio: boolean;
    cursor: CursorMode;
}

export const PRESETS: Record<Exclude<Preset, "custom">, { maxH: number; fps: number; }> = {
    games: { maxH: 1440, fps: 60 },
    screen: { maxH: 0, fps: 15 }
};

export interface LiveSource {
    kind: "window" | "monitor" | "camera";
    hwnd?: number;
    pid?: number;
    monitor?: number;
    deviceId?: string;
    label: string;
}

type Listener = () => void;

// Controlador unico da live. O canvas e a faixa de video dele nunca sao recriados:
// trocar janela, resolucao ou FPS so muda o que alimenta o canvas.
class LiveController {
    readonly canvas = document.createElement("canvas");
    private ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true })!;
    private listeners = new Set<Listener>();
    private abort: AbortController | null = null;
    private track: (MediaStreamTrack & { requestFrame?: () => void; }) | null = null;
    private stream: MediaStream | null = null;
    private camStream: MediaStream | null = null;
    private camVideo: HTMLVideoElement | null = null;
    private camLoop = 0;

    running = false;
    source: LiveSource | null = null;
    prefs: Prefs = { preset: "custom", maxH: 1080, fps: 60, muteAudio: false, cursor: "follow" };
    private selfDispatching = false;
    frameCount = 0;
    realFps = 0;
    error = "";
    private fpsCount = 0;
    private lastDraw = 0;
    private frameSinks = new Set<(canvas: HTMLCanvasElement) => void>();
    private encodedSinks = new Set<(key: boolean, ts: number, data: Uint8Array) => void>();
    private configSinks = new Set<(cfg: VideoConfig) => void>();
    /** "h264": o auxiliar comprime na placa de video; "jpeg": caminho antigo. */
    videoMode: "h264" | "jpeg" | "" = "";
    videoConfig: VideoConfig | null = null;
    encoderName = "";
    private previewDecoder: HwDecoder | null = null;

    /** Recebe os quadros H.264 prontos (vindos da placa de video). */
    addEncodedSink(fn: (key: boolean, ts: number, data: Uint8Array) => void) {
        this.encodedSinks.add(fn);
        return () => { this.encodedSinks.delete(fn); };
    }

    addConfigSink(fn: (cfg: VideoConfig) => void) {
        this.configSinks.add(fn);
        return () => { this.configSinks.delete(fn); };
    }

    requestKeyFrame() {
        Native.keyFrame().catch(() => { });
    }

    private onH264Config(json: string) {
        let raw: any;
        try { raw = JSON.parse(json); } catch { return; }
        const cfg: VideoConfig = { codec: h264CodecFor(raw.w, raw.h, raw.fps), w: raw.w, h: raw.h, fps: raw.fps };
        this.videoMode = "h264";
        this.videoConfig = cfg;
        this.encoderName = raw.encoder ?? "";
        // previa local: decodifica pela placa de video so para desenhar o seu quadro no Discord
        this.previewDecoder?.close();
        const dec = new HwDecoder();
        dec.onFrame = f => { this.paintFrame(f); f.close(); };
        dec.onNeedKey = () => this.requestKeyFrame();
        this.previewDecoder = dec;
        dec.configure(cfg).then(() => this.requestKeyFrame()).catch(e => { this.error = "decodificador: " + String(e); });
        for (const fn of this.configSinks) fn(cfg);
    }

    private onH264Frame(body: Uint8Array) {
        const key = body[0] === 1;
        const ts = new DataView(body.buffer, body.byteOffset + 1, 8).getFloat64(0, true);
        const data = body.subarray(9);
        this.rxVideo++;
        for (const fn of this.encodedSinks) fn(key, ts, data);
        this.previewDecoder?.push(key, ts, data);
    }

    private paintFrame(f: VideoFrame) {
        if (this.canvas.width !== f.displayWidth || this.canvas.height !== f.displayHeight) {
            this.canvas.width = f.displayWidth;
            this.canvas.height = f.displayHeight;
        }
        this.ctx.drawImage(f, 0, 0);
        this.track?.requestFrame?.();
        this.frameCount++;
        this.fpsCount++;
        this.lastDraw = performance.now();
    }

    /** Recebe o canvas a cada quadro novo (usado pelo codificador por hardware). */
    addFrameSink(fn: (canvas: HTMLCanvasElement) => void) {
        this.frameSinks.add(fn);
        return () => { this.frameSinks.delete(fn); };
    }

    // desempenho do caminho helper -> canvas (para diagnostico)
    private rxVideo = 0;
    private decodeMsSum = 0;
    private decodeCount = 0;
    private longTasks = 0;
    perf = { rxPerSec: 0, drawnPerSec: 0, decodeMs: 0, longTasksPerSec: 0, inFlightMax: 0 };

    constructor() {
        setInterval(() => {
            const now = performance.now();
            this.realFps = this.running ? this.fpsCount : 0;
            this.perf = {
                rxPerSec: this.rxVideo, drawnPerSec: this.fpsCount,
                decodeMs: this.decodeCount ? Math.round(this.decodeMsSum / this.decodeCount * 10) / 10 : 0,
                longTasksPerSec: this.longTasks, inFlightMax: this.perf.inFlightMax
            };
            this.rxVideo = 0;
            this.decodeMsSum = 0;
            this.decodeCount = 0;
            this.longTasks = 0;
            this.fpsCount = 0;
            // janela parada: reenvia o ultimo quadro para a faixa de video nao "congelar" no WebRTC
            if (this.running && now - this.lastDraw > 400) this.track?.requestFrame?.();
            this.emit();
        }, 1000);
        try {
            new PerformanceObserver(list => { this.longTasks += list.getEntries().length; }).observe({ entryTypes: ["longtask"] });
        } catch { }
        this.canvas.width = 1280;
        this.canvas.height = 720;
        this.ctx.fillStyle = "#000";
        this.ctx.fillRect(0, 0, 1280, 720);
    }

    subscribe(fn: Listener) {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    }

    private emit() { this.listeners.forEach(l => l()); }

    /** Faixa de video para WebRTC (Fase 4). Sempre a mesma enquanto o Discord estiver aberto. */
    getVideoTrack() {
        if (!this.stream) {
            this.stream = this.canvas.captureStream(0);
            this.track = this.stream.getVideoTracks()[0] as any;
        }
        return this.track!;
    }

    setPrefs(p: Partial<Prefs>) {
        this.prefs = { ...this.prefs, ...p };
        this.pushNativeSettings();
        if (this.running && this.source) this.start(this.source);
        else this.emit();
    }

    /** Mantem as opcoes do menu nativo do Discord (Qualidade da transmissao) iguais as nossas. */
    pushNativeSettings() {
        const p = this.prefs;
        this.selfDispatching = true;
        try {
            FluxDispatcher.dispatch({
                type: "STREAM_UPDATE_SETTINGS",
                preset: p.preset === "games" ? 1 : p.preset === "screen" ? 2 : 3,
                resolution: p.maxH,
                frameRate: p.fps,
                soundshareEnabled: !p.muteAudio
            } as any);
        } catch { }
        this.selfDispatching = false;
    }

    /** Escolha feita no menu nativo do Discord (botao verde / painel): vale para a nossa live. */
    applyNativeSettings(a: { preset?: number; resolution?: number; frameRate?: number; soundshareEnabled?: boolean; }) {
        if (this.selfDispatching) return;
        const next: Partial<Prefs> = {};
        if (a.preset != null) next.preset = a.preset === 1 ? "games" : a.preset === 2 ? "screen" : "custom";
        if (a.resolution != null) next.maxH = a.resolution;
        if (a.frameRate != null) next.fps = a.frameRate;
        if (a.soundshareEnabled != null) next.muteAudio = !a.soundshareEnabled;
        this.prefs = { ...this.prefs, ...next };
        if (this.running && this.source) this.start(this.source);
        else this.emit();
    }

    private stopCamera() {
        cancelAnimationFrame(this.camLoop);
        this.camStream?.getTracks().forEach(t => t.stop());
        this.camStream = null;
        this.camVideo = null;
    }

    private stopHelperLink() {
        this.abort?.abort();
        this.abort = null;
    }

    /** Inicia a live ou troca a fonte/qualidade ao vivo (a faixa de video continua a mesma). */
    async start(src: LiveSource) {
        if (!this.running) this.pushNativeSettings();
        this.source = src;
        this.error = "";
        const p = this.prefs;
        try {
            if (src.kind === "camera") {
                this.stopHelperLink();
                try { await Native.stopStream(); } catch { }
                await this.startCamera(src);
            } else {
                this.stopCamera();
                const { port, token } = await Native.startStream({
                    hwnd: src.kind === "window" ? src.hwnd : undefined,
                    monitor: src.kind === "monitor" ? src.monitor : undefined,
                    pid: src.kind === "window" ? src.pid : undefined,
                    audio: !p.muteAudio,
                    bitrate: hwBitrate(p.maxH, p.fps),
                    fps: p.fps, maxH: p.maxH, quality: 80, cursor: p.cursor
                });
                if (!this.abort) this.connect(port, token);
            }
            this.running = true;
            try { (this.getVideoTrack() as any).contentHint = p.fps >= 30 ? "motion" : "detail"; } catch { }
        } catch (e) {
            this.error = String(e);
            this.running = false;
        }
        this.emit();
    }

    private async startCamera(src: LiveSource) {
        this.stopCamera();
        const p = this.prefs;
        const h = p.maxH || 1080;
        this.camStream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: src.deviceId }, height: { ideal: h }, frameRate: { ideal: p.fps } },
            audio: false
        });
        const v = document.createElement("video");
        v.muted = true;
        v.srcObject = this.camStream;
        await v.play();
        this.camVideo = v;
        const tick = () => {
            if (!this.camVideo) return;
            if (v.videoWidth && (this.canvas.width !== v.videoWidth || this.canvas.height !== v.videoHeight)) {
                this.canvas.width = v.videoWidth;
                this.canvas.height = v.videoHeight;
            }
            this.ctx.drawImage(v, 0, 0);
            this.track?.requestFrame?.();
            this.fpsCount++;
            this.frameCount++;
            this.lastDraw = performance.now();
            for (const sink of this.frameSinks) sink(this.canvas);
            this.camLoop = requestAnimationFrame(tick);
        };
        tick();
    }

    async stop() {
        this.previewDecoder?.close();
        this.previewDecoder = null;
        this.videoMode = "";
        this.videoConfig = null;
        this.stopHelperLink();
        this.stopCamera();
        this.running = false;
        this.source = null;
        this.realFps = 0;
        try { await Native.stopStream(); } catch { }
        this.emit();
    }

    private audioCtx: AudioContext | null = null;
    private audioDest: MediaStreamAudioDestinationNode | null = null;
    private audioQueue: Float32Array[] = [];
    private audioQueued = 0;
    private audioRate = 48000;

    /** Faixa de audio estavel (som so da janela). Sempre a mesma enquanto o Discord estiver aberto. */
    getAudioTrack(): MediaStreamTrack {
        if (!this.audioDest) this.setupAudio(this.audioRate);
        return this.audioDest!.stream.getAudioTracks()[0];
    }

    audioState() {
        return { state: this.audioCtx?.state, rate: this.audioCtx?.sampleRate, queued: this.audioQueued };
    }

    private setupAudio(rate: number) {
        if (this.audioCtx && this.audioCtx.sampleRate === rate) return;
        try { this.audioCtx?.close(); } catch { }
        const ctx = new AudioContext({ sampleRate: rate, latencyHint: "interactive" });
        const dest = ctx.createMediaStreamDestination();
        const node = ctx.createScriptProcessor(2048, 0, 2);
        node.onaudioprocess = ev => {
            const l = ev.outputBuffer.getChannelData(0);
            const r = ev.outputBuffer.getChannelData(1);
            let i = 0;
            while (i < l.length && this.audioQueue.length) {
                const chunk = this.audioQueue[0];
                const frames = chunk.length >> 1;
                const take = Math.min(frames, l.length - i);
                for (let k = 0; k < take; k++) { l[i + k] = chunk[k * 2]; r[i + k] = chunk[k * 2 + 1]; }
                i += take;
                if (take === frames) this.audioQueue.shift();
                else this.audioQueue[0] = chunk.subarray(take * 2);
                this.audioQueued -= take;
            }
            for (; i < l.length; i++) { l[i] = 0; r[i] = 0; }
        };
        node.connect(dest);
        ctx.resume().catch(() => { });
        this.audioCtx = ctx;
        this.audioDest = dest;
    }

    private pushAudio(pcm: Uint8Array) {
        if (!this.audioDest) this.setupAudio(this.audioRate);
        const n = pcm.byteLength >> 1;
        const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const f = new Float32Array(n);
        for (let i = 0; i < n; i++) f[i] = view.getInt16(i * 2, true) / 32768;
        this.audioQueue.push(f);
        this.audioQueued += n >> 1;
        // limita o atraso: acima de ~300 ms descarta o mais antigo
        while (this.audioQueued > this.audioRate * 0.3 && this.audioQueue.length > 1) {
            this.audioQueued -= this.audioQueue.shift()!.length >> 1;
        }
    }

    private async connect(port: number, token: string) {
        const ac = new AbortController();
        this.abort = ac;
        this.audioQueue = [];
        this.audioQueued = 0;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/stream/${token}`, { signal: ac.signal });
            const reader = res.body!.getReader();
            let pending = new Uint8Array(0);
            for (; ;) {
                const { value, done } = await reader.read();
                if (done) break;
                const joined = new Uint8Array(pending.length + value.length);
                joined.set(pending);
                joined.set(value, pending.length);
                pending = joined;
                let off = 0;
                let latest: Uint8Array | null = null;
                while (pending.length - off >= 5) {
                    const type = pending[off];
                    const len = new DataView(pending.buffer, pending.byteOffset + off + 1, 4).getUint32(0, true);
                    if (pending.length - off < 5 + len) break;
                    const body = pending.subarray(off + 5, off + 5 + len);
                    off += 5 + len;
                    if (type === 0) { latest = body; this.rxVideo++; this.videoMode = "jpeg"; }
                    else if (type === 3) this.onH264Frame(body.slice());
                    else if (type === 4) this.onH264Config(new TextDecoder().decode(body));
                    else if (type === 1) this.pushAudio(body);
                    else if (type === 2) {
                        this.audioRate = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true);
                        this.setupAudio(this.audioRate);
                    }
                }
                pending = pending.slice(off);
                // so o quadro mais novo importa: se chegaram varios de uma vez, descarta os velhos
                if (latest) this.queueDraw(latest.slice());
            }
        } catch (e) {
            if (!ac.signal.aborted) {
                this.error = "Conexao com o auxiliar caiu: " + String(e);
                this.running = false;
                this.emit();
            }
        }
    }

    // Ate 3 quadros sendo descompactados ao mesmo tempo; so o mais novo e desenhado (nunca volta no tempo)
    private seq = 0;
    private lastDrawnSeq = 0;
    private inFlight = 0;
    private nextJpg: Uint8Array | null = null;
    private static readonly MAX_DECODES = 3;

    private queueDraw(jpg: Uint8Array) {
        if (this.inFlight >= LiveController.MAX_DECODES) { this.nextJpg = jpg; return; }
        this.startDecode(jpg);
    }

    private startDecode(jpg: Uint8Array) {
        const mySeq = ++this.seq;
        this.inFlight++;
        this.perf.inFlightMax = Math.max(this.perf.inFlightMax, this.inFlight);
        const t0 = performance.now();
        createImageBitmap(new Blob([jpg], { type: "image/jpeg" }))
            .then(bmp => {
                this.decodeMsSum += performance.now() - t0;
                this.decodeCount++;
                if (mySeq > this.lastDrawnSeq) {
                    this.lastDrawnSeq = mySeq;
                    this.paint(bmp);
                }
                bmp.close();
            })
            .catch(() => { })
            .finally(() => {
                this.inFlight--;
                const n = this.nextJpg;
                if (n && this.inFlight < LiveController.MAX_DECODES) {
                    this.nextJpg = null;
                    this.startDecode(n);
                }
            });
    }

    private paint(bmp: ImageBitmap) {
        if (this.canvas.width !== bmp.width || this.canvas.height !== bmp.height) {
            this.canvas.width = bmp.width;
            this.canvas.height = bmp.height;
        }
        this.ctx.drawImage(bmp, 0, 0);
        this.track?.requestFrame?.();
        this.frameCount++;
        this.fpsCount++;
        this.lastDraw = performance.now();
        for (const sink of this.frameSinks) sink(this.canvas);
    }
}

/** Taxa de bits do H.264 por hardware (o NVENC sustenta isso sem pesar). */
export function hwBitrate(maxH: number, fps: number) {
    const h = maxH || 1440;
    const base = h >= 1440 ? 18e6 : h >= 1080 ? 12e6 : h >= 720 ? 7e6 : 4e6;
    return Math.round(base * (fps >= 60 ? 1 : fps >= 30 ? 0.65 : 0.4));
}

let instance: LiveController | null = null;
export function getLive() {
    return (instance ??= new LiveController());
}

export const sourcesApi = {
    get: (q?: NativeTypes.SourcesQuery) => Native.getSources(q)
};

export async function listCameras(): Promise<{ deviceId: string; label: string; }[]> {
    try {
        const all = await navigator.mediaDevices.enumerateDevices();
        return all.filter(d => d.kind === "videoinput").map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Câmera ${i + 1}` }));
    } catch {
        return [];
    }
}

export const saveProbe = (name: string, data: string) => Native.saveProbe(name, data);

export const takeFlag = (name: string) => Native.takeFlag(name);

export const watchBase = () => Native.watchBase();
export const getLocalToken = () => Native.localToken();
