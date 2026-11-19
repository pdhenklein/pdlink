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
/**
 * Tratamento da imagem de quem assiste, feito na placa de video a cada quadro:
 * clean = limpeza (suaviza so diferencas pequenas, como restos de compressao; bordas ficam), 0 a 1;
 * sharp = nitidez (CAS, Contrast Adaptive Sharpening da AMD FidelityFX), 0 a 1. Os dois em 0 = imagem original.
 */
export const viewFilter = { clean: 0.5, sharp: 0.5 };

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

// limpeza: media dos 3x3 vizinhos, pesando so os que tem cor parecida com o centro (filtro bilateral)
const FS_CLEAN = `#version 300 es
precision highp float;
uniform sampler2D t; uniform float k; in vec2 uv; out vec4 o;
void main() {
    ivec2 lim = textureSize(t, 0) - 1, at = ivec2(gl_FragCoord.xy);
    vec3 c = texelFetch(t, at, 0).rgb;
    vec3 sum = c; float ws = 1.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        if (x == 0 && y == 0) continue;
        vec3 n = texelFetch(t, clamp(at + ivec2(x, y), ivec2(0), lim), 0).rgb;
        vec3 d = n - c;
        float w = exp(-dot(d, d) * k) * ((x == 0 || y == 0) ? 1.0 : 0.6);
        sum += n * w; ws += w;
    }
    o = vec4(sum / ws, 1.0);
}`;

// nitidez: CAS. Mede o contraste local (minimo e maximo da vizinhanca) e afia mais onde ha pouco contraste
const FS_SHARP = `#version 300 es
precision highp float;
uniform sampler2D t; uniform float s; in vec2 uv; out vec4 o;
// a linha 0 da textura e o topo da imagem, mas na tela a linha 0 e embaixo: aqui a imagem e desvirada
vec3 at(int x, int y) {
    ivec2 lim = textureSize(t, 0) - 1;
    ivec2 base = ivec2(int(gl_FragCoord.x), lim.y - int(gl_FragCoord.y));
    return texelFetch(t, clamp(base + ivec2(x, y), ivec2(0), lim), 0).rgb;
}
void main() {
    vec3 a = at(-1, -1), b = at(0, -1), c = at(1, -1);
    vec3 d = at(-1, 0), e = at(0, 0), f = at(1, 0);
    vec3 g = at(-1, 1), h = at(0, 1), i = at(1, 1);
    if (s <= 0.0) { o = vec4(e, 1.0); return; }
    vec3 mn = min(min(min(d, e), min(f, b)), h);
    mn += min(mn, min(min(a, c), min(g, i)));
    vec3 mx = max(max(max(d, e), max(f, b)), h);
    mx += max(mx, max(max(a, c), max(g, i)));
    vec3 amp = sqrt(clamp(min(mn, 2.0 - mx) / max(mx, vec3(1e-5)), 0.0, 1.0));
    vec3 w = amp * (-1.0 / mix(8.0, 5.0, s));
    o = vec4(clamp(((b + d + f + h) * w + e) / (1.0 + 4.0 * w), 0.0, 1.0), 1.0);
}`;

class FilterGl {
    private gl: WebGL2RenderingContext;
    private src: WebGLTexture;
    private mid: WebGLTexture;
    private fb: WebGLFramebuffer;
    private clean: WebGLProgram;
    private sharp: WebGLProgram;
    private w = 0;
    private h = 0;

    constructor(gl: WebGL2RenderingContext) {
        this.gl = gl;
        const prog = (fs: string) => {
            const p = gl.createProgram()!;
            for (const [type, code] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]] as const) {
                const sh = gl.createShader(type)!;
                gl.shaderSource(sh, code);
                gl.compileShader(sh);
                if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
                gl.attachShader(p, sh);
            }
            gl.bindAttribLocation(p, 0, "p");
            gl.linkProgram(p);
            if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "programa");
            return p;
        };
        this.clean = prog(FS_CLEAN);
        this.sharp = prog(FS_SHARP);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        const tex = () => {
            const t = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, t);
            for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
            for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
            return t;
        };
        this.src = tex();
        this.mid = tex();
        this.fb = gl.createFramebuffer()!;
    }

    draw(f: VideoFrame, w: number, h: number) {
        const { gl } = this;
        if (w !== this.w || h !== this.h) {
            this.w = w; this.h = h;
            gl.bindTexture(gl.TEXTURE_2D, this.mid);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.mid, 0);
        }
        gl.viewport(0, 0, w, h);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.src);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f as any);
        const clean = Math.max(0, Math.min(1, viewFilter.clean));
        let input = this.src;
        if (clean > 0) {
            // k alto = so diferencas bem pequenas sao suavizadas; clean 1 chega a ~0,06 de diferenca por canal
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
            gl.useProgram(this.clean);
            gl.uniform1f(gl.getUniformLocation(this.clean, "k"), 1 / (2 * (0.035 * clean) ** 2));
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            input = this.mid;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, input);
        gl.useProgram(this.sharp);
        gl.uniform1f(gl.getUniformLocation(this.sharp, "s"), Math.max(0, Math.min(1, viewFilter.sharp)));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
}

export class LatestFramePainter {
    private latest: VideoFrame | null = null;
    private raf = 0;
    private stopped = false;
    painted = 0;
    filtered = false;
    onPaint: (w: number, h: number) => void = () => { };

    constructor(private canvas: HTMLCanvasElement) {
        // com WebGL o quadro passa pelo filtro de limpeza e nitidez; sem WebGL, desenho simples
        try {
            const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, desynchronized: true, preserveDrawingBuffer: true });
            if (gl) { this.gl = new FilterGl(gl); this.filtered = true; }
        } catch { }
        if (!this.gl) this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true })!;
        this.loop = this.loop.bind(this);
        this.raf = requestAnimationFrame(this.loop);
    }

    private ctx: CanvasRenderingContext2D | null = null;
    private gl: FilterGl | null = null;

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
            if (this.gl) this.gl.draw(f, f.displayWidth, f.displayHeight);
            else this.ctx!.drawImage(f, 0, 0);
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
