// Video por hardware: o canvas e comprimido uma unica vez na placa de video (WebCodecs, H.264) e os
// pacotes seguem direto para cada espectador por um canal de dados do WebRTC. Nao ha codificador
// em software no caminho. Sem dependencias do Vencord: serve ao plugin e a pagina de assistir.

export interface VideoConfig {
    codec: string;
    w: number;
    h: number;
    fps: number;
}

const SLICE = 60000; // abaixo do limite de mensagem do SCTP
const MAGIC = 0xA5;
const HEADER = 14; // magic(1) flags(1) timestamp f64(8) total u32(4)

/** Nivel do H.264 pela taxa de macroblocos por segundo (High profile). */
export function h264CodecFor(w: number, h: number, fps: number) {
    const mbs = Math.ceil(w / 16) * Math.ceil(h / 16) * fps;
    const level = mbs <= 245760 ? "28" : mbs <= 522240 ? "2a" : mbs <= 983040 ? "33" : "34";
    return "avc1.6400" + level;
}

// ------------------------------------------------------------------ transmissao em pedacos

export function sendFrame(dc: RTCDataChannel, key: boolean, timestampUs: number, data: Uint8Array) {
    const first = Math.min(data.length, SLICE - HEADER);
    const head = new Uint8Array(HEADER + first);
    const dv = new DataView(head.buffer);
    dv.setUint8(0, MAGIC);
    dv.setUint8(1, key ? 1 : 0);
    dv.setFloat64(2, timestampUs);
    dv.setUint32(10, data.length);
    head.set(data.subarray(0, first), HEADER);
    dc.send(head);
    for (let off = first; off < data.length; off += SLICE) dc.send(data.subarray(off, Math.min(data.length, off + SLICE)) as any);
}

/** Remonta quadros a partir das mensagens (canal ordenado e confiavel). */
export class FrameReceiver {
    private buf: Uint8Array | null = null;
    private have = 0;
    private key = false;
    private ts = 0;
    bytes = 0;
    onFrame: (key: boolean, ts: number, data: Uint8Array) => void = () => { };

    push(msg: ArrayBuffer) {
        const u8 = new Uint8Array(msg);
        this.bytes += u8.length;
        if (!this.buf) {
            if (u8.length < HEADER || u8[0] !== MAGIC) return;
            const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
            this.key = dv.getUint8(1) === 1;
            this.ts = dv.getFloat64(2);
            const total = dv.getUint32(10);
            this.buf = new Uint8Array(total);
            this.have = 0;
            this.append(u8.subarray(HEADER));
        } else {
            this.append(u8);
        }
    }

    private append(part: Uint8Array) {
        const room = this.buf!.length - this.have;
        this.buf!.set(part.length > room ? part.subarray(0, room) : part, this.have);
        this.have += Math.min(part.length, room);
        if (this.have >= this.buf!.length) {
            const done = this.buf!;
            this.buf = null;
            this.onFrame(this.key, this.ts, done);
        }
    }
}

// ------------------------------------------------------------------ codificador (placa de video)

export class HwEncoder {
    private enc: VideoEncoder | null = null;
    private w = 0;
    private h = 0;
    private fps = 0;
    private bitrate = 0;
    private configuring = false;
    private lastKeyAt = -1e12;
    forceKey = true;
    config: VideoConfig | null = null;
    hardware = false;
    error = "";
    encoded = 0;
    dropped = 0;
    onChunk: (key: boolean, ts: number, data: Uint8Array) => void = () => { };
    onConfig: (cfg: VideoConfig) => void = () => { };

    static available() {
        return typeof (globalThis as any).VideoEncoder === "function" && typeof (globalThis as any).VideoFrame === "function";
    }

    requestKey() {
        this.forceKey = true;
    }

    private async configure(w: number, h: number, fps: number, bitrate: number) {
        this.configuring = true;
        try {
            this.closeEncoder();
            const codec = h264CodecFor(w, h, fps);
            const base: VideoEncoderConfig = {
                codec, width: w, height: h, bitrate, framerate: fps, latencyMode: "realtime",
                avc: { format: "annexb" }, bitrateMode: "constant", hardwareAcceleration: "prefer-hardware"
            } as any;
            let cfg: VideoEncoderConfig = base;
            let sup = await VideoEncoder.isConfigSupported(cfg);
            this.hardware = !!sup.supported;
            if (!sup.supported) {
                cfg = { ...base, hardwareAcceleration: "prefer-software" } as any;
                sup = await VideoEncoder.isConfigSupported(cfg);
            }
            if (!sup.supported) throw new Error("codificador H.264 indisponivel");
            const enc = new VideoEncoder({
                output: chunk => {
                    const data = new Uint8Array(chunk.byteLength);
                    chunk.copyTo(data);
                    this.encoded++;
                    this.onChunk(chunk.type === "key", chunk.timestamp, data);
                },
                error: e => { this.error = String(e); this.enc = null; }
            });
            enc.configure(cfg);
            this.enc = enc;
            this.w = w;
            this.h = h;
            this.fps = fps;
            this.bitrate = bitrate;
            this.config = { codec, w, h, fps };
            this.forceKey = true;
            this.onConfig(this.config);
        } catch (e) {
            this.error = String(e);
        } finally {
            this.configuring = false;
        }
    }

    /** Comprime o conteudo atual do canvas. Quadros que chegam com o codificador ocupado sao descartados. */
    encode(canvas: HTMLCanvasElement, tsUs: number, bitrate: number, fps: number) {
        const w = canvas.width & ~1;
        const h = canvas.height & ~1;
        if (!this.enc || w !== this.w || h !== this.h || fps !== this.fps || bitrate !== this.bitrate) {
            if (!this.configuring) this.configure(w, h, fps, bitrate);
            this.dropped++;
            return;
        }
        if (this.enc.encodeQueueSize > 4) { this.dropped++; return; }
        const frame = new VideoFrame(canvas, { timestamp: tsUs });
        const key = this.forceKey || tsUs - this.lastKeyAt > 2e6;
        if (key) { this.lastKeyAt = tsUs; this.forceKey = false; }
        try {
            this.enc.encode(frame, { keyFrame: key });
        } catch (e) {
            this.error = String(e);
        }
        frame.close();
    }

    private closeEncoder() {
        try { this.enc?.close(); } catch { }
        this.enc = null;
    }

    close() {
        this.closeEncoder();
        this.config = null;
    }
}

// ------------------------------------------------------------------ decodificador (placa de video)

export class HwDecoder {
    private dec: VideoDecoder | null = null;
    private needKey = true;
    decoded = 0;
    error = "";
    hardware = false;
    onFrame: (frame: VideoFrame) => void = f => f.close();
    onNeedKey: () => void = () => { };

    async configure(cfg: VideoConfig) {
        try { this.dec?.close(); } catch { }
        const base: VideoDecoderConfig = { codec: cfg.codec, codedWidth: cfg.w, codedHeight: cfg.h, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" } as any;
        let use = base;
        let sup = await VideoDecoder.isConfigSupported(base);
        this.hardware = !!sup.supported;
        if (!sup.supported) {
            use = { ...base, hardwareAcceleration: "prefer-software" } as any;
            sup = await VideoDecoder.isConfigSupported(use);
        }
        if (!sup.supported) throw new Error("decodificador H.264 indisponivel neste navegador");
        const d = new VideoDecoder({
            output: f => { this.decoded++; this.onFrame(f); },
            error: e => { this.error = String(e); this.needKey = true; this.onNeedKey(); }
        });
        d.configure(use);
        this.dec = d;
        this.needKey = true;
    }

    push(key: boolean, tsUs: number, data: Uint8Array) {
        if (!this.dec || this.dec.state !== "configured") return;
        if (this.needKey) {
            if (!key) { this.onNeedKey(); return; }
            this.needKey = false;
        }
        // atrasado (ex.: aba em segundo plano): descartar um quadro estragaria a imagem ate o proximo quadro-chave.
        // Em vez disso, para tudo e pede um quadro-chave ja, que reinicia a imagem limpa.
        if (this.dec.decodeQueueSize > 8 && !key) {
            this.needKey = true;
            this.onNeedKey();
            return;
        }
        try {
            this.dec.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: tsUs, data }));
        } catch (e) {
            this.error = String(e);
            this.needKey = true;
            this.onNeedKey();
        }
    }

    close() {
        try { this.dec?.close(); } catch { }
        this.dec = null;
    }
}

/** Desenha so o quadro mais novo a cada vez que o navegador pinta (descarta os atrasados). */
export class LatestFramePainter {
    private latest: VideoFrame | null = null;
    private raf = 0;
    private stopped = false;
    painted = 0;
    onPaint: (w: number, h: number) => void = () => { };

    constructor(private canvas: HTMLCanvasElement) {
        this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true })!;
        this.loop = this.loop.bind(this);
        this.raf = requestAnimationFrame(this.loop);
    }

    private ctx: CanvasRenderingContext2D;

    push(frame: VideoFrame) {
        this.latest?.close();
        this.latest = frame;
    }

    private loop() {
        if (this.stopped) return;
        const f = this.latest;
        if (f) {
            this.latest = null;
            if (this.canvas.width !== f.displayWidth || this.canvas.height !== f.displayHeight) {
                this.canvas.width = f.displayWidth;
                this.canvas.height = f.displayHeight;
            }
            this.ctx.drawImage(f, 0, 0);
            this.painted++;
            this.onPaint(f.displayWidth, f.displayHeight);
            f.close();
        }
        this.raf = requestAnimationFrame(this.loop);
    }

    stop() {
        this.stopped = true;
        cancelAnimationFrame(this.raf);
        this.latest?.close();
        this.latest = null;
    }
}
