// Video por hardware: o canvas e comprimido uma unica vez na placa de video (WebCodecs, H.264) e os
// pacotes seguem direto para cada espectador por um canal de dados do WebRTC. Nao ha codificador
// em software no caminho. Sem dependencias do Vencord: serve ao plugin e a pagina de assistir.

export interface VideoConfig {
    codec: string;
    w: number;
    h: number;
    fps: number;
    /** so informativo (diagnostico de quem assiste): codificador e placa de video de quem transmite */
    encoder?: string;
    gpu?: string;
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
 * amount = multiplica o efeito do CAS (o CAS sozinho e sutil demais); o resultado fica preso entre o pixel mais escuro e o
 * mais claro da vizinhanca, entao mesmo forte nao cria halo (contorno claro em volta das bordas).
 */
export const viewFilter = { clean: 0.5, sharp: 1, amount: 2.5 };

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
uniform sampler2D t; uniform float s; uniform float amt; in vec2 uv; out vec4 o;
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
    vec3 cas = ((b + d + f + h) * w + e) / (1.0 + 4.0 * w);
    // reforca o que o CAS mudou e prende na faixa da vizinhanca 3x3 (sem halo)
    vec3 lo = min(min(min(a, b), min(c, d)), min(min(f, g), min(h, i)));
    vec3 hi = max(max(max(a, b), max(c, d)), max(max(f, g), max(h, i)));
    lo = min(lo, e); hi = max(hi, e);
    o = vec4(clamp(e + (cas - e) * amt, lo, hi), 1.0);
}`;

// ------------------------------------------------------------------ geracao de quadros (quem assiste)
/**
 * Geracao de quadros: entre dois quadros reais da live, cria (mult - 1) quadros no meio (2x, 3x ou 4x).
 * 1) mede o movimento entre os dois quadros (fluxo optico por busca de blocos, do mais grosso ao mais fino);
 * 2) para cada quadro do meio, desloca os dois quadros reais ate aquele instante e mistura.
 * A imagem fica 1 quadro real atrasada (precisa do proximo quadro para criar os do meio).
 */
export const viewFg = { mult: 1 };

// todas as passagens fora da tela usam a linha 0 = topo da imagem (igual a textura do quadro)
const FS_FLOW = `#version 300 es
precision highp float;
uniform sampler2D A; uniform sampler2D B; uniform sampler2D P;
uniform float lod; uniform vec2 px; uniform vec2 size; uniform int R; uniform int K; uniform bool hasP;
out vec4 o;
float L(sampler2D t, vec2 q) { return dot(textureLod(t, q, lod).rgb, vec3(0.299, 0.587, 0.114)); }
float cost(vec2 uv, vec2 v) {
    float c = 0.0;
    for (int y = -K; y <= K; y++) for (int x = -K; x <= K; x++) {
        vec2 q = uv + vec2(x, y) * px;
        c += abs(L(A, q - 0.5 * v) - L(B, q + 0.5 * v));
    }
    return c / float((2 * K + 1) * (2 * K + 1)) * 25.0;
}
void main() {
    vec2 uv = gl_FragCoord.xy / size;
    // movimento simetrico: o ponto do meio do caminho fica neste pixel (A volta meio vetor, B avanca meio)
    vec2 base = hasP ? texture(P, uv).xy : vec2(0.0);
    vec2 best = base; float bc = 1e9;
    for (int y = -R; y <= R; y++) for (int x = -R; x <= R; x++) {
        vec2 v = base + vec2(x, y) * px;
        float c = cost(uv, v) + 0.03 * length(vec2(x, y));
        if (c < bc) { bc = c; best = v; }
    }
    // parado sempre e candidato (HUD, arma e mira nao andam com a camera), com uma leve preferencia
    float c0 = cost(uv, vec2(0.0)) * 0.97;
    if (c0 <= bc) { bc = c0; best = vec2(0.0); }
    o = vec4(best, bc, 1.0);
}`;

// limpa vetores errados: testa os vetores dos 8 vizinhos neste pixel e fica com o que encaixa melhor
const FS_PICK = `#version 300 es
precision highp float;
uniform sampler2D A; uniform sampler2D B; uniform sampler2D F;
uniform float lod; uniform vec2 px; uniform vec2 size;
out vec4 o;
float L(sampler2D t, vec2 q) { return dot(textureLod(t, q, lod).rgb, vec3(0.299, 0.587, 0.114)); }
void main() {
    vec2 uv = gl_FragCoord.xy / size;
    ivec2 at = ivec2(gl_FragCoord.xy), lim = textureSize(F, 0) - 1;
    vec2 best = vec2(0.0); float bc = 1e9;
    for (int j = -1; j <= 2; j++) for (int i = -1; i <= 1; i++) {
        // j == 2 so uma vez: o candidato "parado"
        if (j == 2 && i != 0) continue;
        vec2 v = j == 2 ? vec2(0.0) : texelFetch(F, clamp(at + ivec2(i, j), ivec2(0), lim), 0).xy;
        float c = 0.0;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            vec2 q = uv + vec2(x, y) * px;
            c += abs(L(A, q - 0.5 * v) - L(B, q + 0.5 * v));
        }
        c *= 25.0 / 9.0;
        if (j == 2) c *= 0.97; else if (i != 0 || j != 0) c += 0.05;
        if (c < bc) { bc = c; best = v; }
    }
    o = vec4(best, bc, 1.0);
}`;

const FS_INTERP = `#version 300 es
precision highp float;
uniform sampler2D A; uniform sampler2D B; uniform sampler2D F; uniform float a; uniform vec2 size;
out vec4 o;
void main() {
    vec2 uv = gl_FragCoord.xy / size;
    vec2 v = texture(F, uv).xy;
    vec2 pa = uv - a * v, pb = uv + (1.0 - a) * v;
    vec3 ca = textureLod(A, pa, 0.0).rgb, cb = textureLod(B, pb, 0.0).rgb;
    vec3 sa = textureLod(A, uv, 0.0).rgb, sb = textureLod(B, uv, 0.0).rgb;
    // quanto cada hipotese concorda entre os dois quadros, pixel a pixel (letras do HUD sao finas)
    float ew = length(ca - cb), es = length(sa - sb);
    // pixel parado (HUD, arma, mira) concorda melhor sem mover: usa a versao parada
    float ws = smoothstep(-0.02, 0.02, ew - es);
    vec3 col = mix(mix(ca, cb, a), mix(sa, sb, a), ws);
    // nenhuma concorda (algo surgiu ou sumiu): so o lado mais perto no tempo, sem fantasma duplo
    vec3 near = mix(a < 0.5 ? ca : cb, a < 0.5 ? sa : sb, ws);
    float bad = smoothstep(0.12, 0.25, min(ew, es));
    o = vec4(mix(col, near, bad), 1.0);
}`;

// [nivel (1/2^n do tamanho), raio da busca, raio do bloco comparado]; o ultimo nivel e o do resultado
const FG_LEVELS: [number, number, number][] = [[5, 4, 2], [4, 2, 2], [3, 1, 2], [2, 1, 1], [1, 1, 1]];
const FG_OUT = 1;

class FilterGl {
    private gl: WebGL2RenderingContext;
    private src: WebGLTexture;
    private mid: WebGLTexture;
    private fb: WebGLFramebuffer;
    private clean: WebGLProgram;
    private sharp: WebGLProgram;
    private w = 0;
    private h = 0;
    // geracao de quadros
    fgOk = false;
    private fgFb: WebGLFramebuffer | null = null;
    private frames: WebGLTexture[] = [];
    private cur = 0;
    private hasPrev = false;
    private flowOk = false;
    private flow = new Map<number, WebGLTexture>();
    private flowFinal: WebGLTexture | null = null;
    private out: WebGLTexture | null = null;
    private pFlow: WebGLProgram | null = null;
    private pPick: WebGLProgram | null = null;
    private pInterp: WebGLProgram | null = null;
    private fgW = 0;
    private fgH = 0;
    // confianca do par: media do erro de encaixe, lida da placa sem travar (fence + buffer)
    private pbo: WebGLBuffer | null = null;
    private fence: WebGLSync | null = null;
    private conf: "?" | "ok" | "ruim" = "?";
    lastCost = -1;
    /** erro medio acima disso = movimento que a busca nao acompanha (flick, troca de cena): mostra so quadros reais */
    maxCost = 0.02;
    skipped = 0;

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
        this.src = this.tex(gl.NEAREST, gl.NEAREST);
        this.mid = this.tex(gl.NEAREST, gl.NEAREST);
        this.fb = gl.createFramebuffer()!;
        // o movimento fica em textura de ponto flutuante: precisa poder desenhar nela
        try {
            if (gl.getExtension("EXT_color_buffer_float")) {
                this.pFlow = prog(FS_FLOW);
                this.pPick = prog(FS_PICK);
                this.pInterp = prog(FS_INTERP);
                this.fgFb = gl.createFramebuffer();
                this.frames = [0, 1].map(() => this.tex(gl.LINEAR_MIPMAP_NEAREST, gl.LINEAR));
                this.fgOk = true;
            }
        } catch { this.fgOk = false; }
    }

    private tex(min: number, mag: number) {
        const { gl } = this;
        const t = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
        for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
        return t;
    }

    private size(w: number, h: number) {
        if (w === this.w && h === this.h) return false;
        const { gl } = this;
        this.w = w; this.h = h;
        gl.bindTexture(gl.TEXTURE_2D, this.mid);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.mid, 0);
        return true;
    }

    draw(f: VideoFrame, w: number, h: number) {
        const { gl } = this;
        this.size(w, h);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.src);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f as any);
        this.process(this.src);
    }

    /** limpeza + nitidez de uma textura (linha 0 = topo) direto para a tela */
    private process(input: WebGLTexture) {
        const { gl, w, h } = this;
        gl.viewport(0, 0, w, h);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, input);
        const clean = Math.max(0, Math.min(1, viewFilter.clean));
        if (clean > 0) {
            // k alto = so diferencas bem pequenas sao suavizadas; clean 1 chega a ~0,06 de diferenca por canal
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
            gl.useProgram(this.clean);
            gl.uniform1f(this.loc(this.clean, "k"), 1 / (2 * (0.035 * clean) ** 2));
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.bindTexture(gl.TEXTURE_2D, this.mid);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(this.sharp);
        gl.uniform1f(this.loc(this.sharp, "s"), Math.max(0, Math.min(1, viewFilter.sharp)));
        gl.uniform1f(this.loc(this.sharp, "amt"), Math.max(0, Math.min(6, viewFilter.amount)));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    private fgAlloc(w: number, h: number) {
        if (w === this.fgW && h === this.fgH) return false;
        const { gl } = this;
        this.fgW = w; this.fgH = h;
        const float = (tw: number, th: number, old?: WebGLTexture | null) => {
            if (old) gl.deleteTexture(old);
            const t = this.tex(gl.LINEAR, gl.LINEAR);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, tw, th, 0, gl.RGBA, gl.HALF_FLOAT, null);
            return t;
        };
        for (const [L] of FG_LEVELS) this.flow.set(L, float(Math.max(1, w >> L), Math.max(1, h >> L), this.flow.get(L)));
        this.flowFinal = float(Math.max(1, w >> FG_OUT), Math.max(1, h >> FG_OUT), this.flowFinal);
        if (this.out) gl.deleteTexture(this.out);
        this.out = this.tex(gl.NEAREST, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        return true;
    }

    private passTo(target: WebGLTexture, w: number, h: number) {
        const { gl } = this;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fgFb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
        gl.viewport(0, 0, w, h);
    }

    private bindUnits(...texs: WebGLTexture[]) {
        const { gl } = this;
        texs.forEach((t, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); });
        gl.activeTexture(gl.TEXTURE0);
    }

    // endereco de cada parametro dos shaders, procurado uma vez so (procurar pelo nome a cada quadro custa)
    private locs = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
    private loc(p: WebGLProgram, k: string) {
        let m = this.locs.get(p);
        if (!m) this.locs.set(p, m = new Map());
        if (!m.has(k)) m.set(k, this.gl.getUniformLocation(p, k));
        return m.get(k)!;
    }

    private uni(p: WebGLProgram, vals: Record<string, number | number[] | boolean>) {
        const { gl } = this;
        for (const [k, v] of Object.entries(vals)) {
            const loc = this.loc(p, k);
            if (Array.isArray(v)) gl.uniform2f(loc, v[0], v[1]);
            else if (typeof v === "boolean" || ["R", "K", "A", "B", "F", "P"].includes(k)) gl.uniform1i(loc, +v);
            else gl.uniform1f(loc, v);
        }
    }

    /** guarda um quadro real; com withFlow, mede o movimento desde o anterior. Retorna se da para criar quadros do meio. */
    fgPush(f: VideoFrame, w: number, h: number, withFlow: boolean) {
        const { gl } = this;
        const r1 = this.size(w, h), r2 = this.fgAlloc(w, h);
        this.cur ^= 1;
        const A = this.frames[this.cur ^ 1], B = this.frames[this.cur];
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, B);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f as any);
        gl.generateMipmap(gl.TEXTURE_2D);
        const can = withFlow && this.hasPrev && !r1 && !r2;
        this.hasPrev = true;
        this.flowOk = false;
        if (!can) return false;
        let prev: WebGLTexture | null = null;
        gl.useProgram(this.pFlow);
        for (const [L, R, K] of FG_LEVELS) {
            const lw = Math.max(1, w >> L), lh = Math.max(1, h >> L);
            const target = this.flow.get(L)!;
            this.passTo(target, lw, lh);
            this.bindUnits(A, B, prev ?? A);
            this.uni(this.pFlow!, { A: 0, B: 1, P: 2, lod: L, px: [1 / lw, 1 / lh], size: [lw, lh], R, K, hasP: !!prev });
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            prev = target;
        }
        const lw = Math.max(1, w >> FG_OUT), lh = Math.max(1, h >> FG_OUT);
        gl.useProgram(this.pPick);
        this.passTo(this.flowFinal!, lw, lh);
        this.bindUnits(A, B, prev!);
        this.uni(this.pPick!, { A: 0, B: 1, F: 2, lod: FG_OUT, px: [1 / lw, 1 / lh], size: [lw, lh] });
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        // media do erro de encaixe: reduz o mapa de movimento ate 1x1 e le esse pixel sem esperar a placa
        gl.bindTexture(gl.TEXTURE_2D, this.flowFinal);
        gl.generateMipmap(gl.TEXTURE_2D);
        const top = Math.floor(Math.log2(Math.max(lw, lh)));
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.flowFinal, top);
        if (!this.pbo) { this.pbo = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo); gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ); }
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        if (this.fence) gl.deleteSync(this.fence);
        this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        this.conf = "?";
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.flowOk = true;
        return true;
    }

    /** pinta o instante a (0 = quadro anterior, 1 = quadro novo) */
    fgDraw(a: number) {
        const { gl, w, h } = this;
        if (!this.flowOk || a >= 1) { this.process(this.frames[this.cur]); return; }
        if (this.conf === "?" && this.fence) {
            const st = gl.clientWaitSync(this.fence, 0, 0);
            if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
                const v = new Float32Array(4);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
                gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, v);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
                this.lastCost = v[2] / 25;
                this.conf = Number.isFinite(this.lastCost) && this.lastCost > this.maxCost ? "ruim" : "ok";
                if (this.conf === "ruim") this.skipped++;
            }
        }
        // ainda sem resposta da placa (dura menos de 1 pintura): repete o quadro anterior; par ruim: so quadros reais
        if (this.conf === "?") { this.process(this.frames[this.cur ^ 1]); return; }
        if (this.conf === "ruim") { this.process(this.frames[a < 0.5 ? this.cur ^ 1 : this.cur]); return; }
        const A = this.frames[this.cur ^ 1], B = this.frames[this.cur];
        gl.useProgram(this.pInterp);
        this.passTo(this.out!, w, h);
        this.bindUnits(A, B, this.flowFinal!);
        this.uni(this.pInterp!, { A: 0, B: 1, F: 2, a, size: [w, h] });
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.process(this.out!);
    }
}

export class LatestFramePainter {
    // fila com horario de exibicao: cada quadro novo sai no ritmo em que o jogo o mostrou, nao no ritmo em que a rede entregou
    private pending: { f: VideoFrame; due: number; }[] = [];
    private queue: VideoFrame[] = [];
    private lastTs = -1;
    private seg: { ts: number; start: number; end: number; steps: number; } | null = null;
    private lastStep = -1;
    private dirty = false;
    private raf = 0;
    private stopped = false;
    // atraso (chegada - horario do quadro) dos ultimos quadros: o menor e a base, a variacao vira a folga do buffer
    private lags: number[] = [];
    private base = 0;
    private lastArrival = 0;
    painted = 0;
    /** quadros com conteudo novo (repetidos do transmissor descartados) */
    fresh = 0;
    /** maior intervalo entre chegadas desde a ultima leitura (ms) */
    maxGap = 0;
    /** folga atual do buffer (ms) */
    delay = 0;
    /** quadros que chegaram tarde demais e foram pulados */
    late = 0;
    /** quadros reais e criados pela geracao de quadros */
    fgReal = 0;
    fgMade = 0;
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

    get fgActive() { return viewFg.mult > 1 && !!this.gl?.fgOk; }
    get fgSkipped() { return this.gl?.skipped ?? 0; }

    push(frame: VideoFrame) {
        // o transmissor repete o ultimo quadro quando o jogo nao mandou um novo: mesmo horario = repetido
        if (frame.timestamp === this.lastTs) { frame.close(); return; }
        if (frame.timestamp < this.lastTs) {
            // live reiniciou (horario voltou): recomeca a medida
            this.lags = [];
            this.pending.forEach(p => p.f.close());
            this.pending = [];
        }
        this.lastTs = frame.timestamp;
        this.fresh++;
        const now = performance.now();
        if (this.lastArrival) this.maxGap = Math.max(this.maxGap, now - this.lastArrival);
        this.lastArrival = now;
        this.lags.push(now - frame.timestamp / 1000);
        if (this.lags.length > 180) this.lags.shift();
        const sorted = [...this.lags].sort((a, b) => a - b);
        this.base = sorted[0];
        // folga = maior variacao recente das chegadas + 3 ms, no maximo 60 ms
        this.delay = Math.min(60, sorted[sorted.length - 1] - this.base + 3);
        // no comeco ainda nao se conhece a rede: comeca com 20 ms para nao precisar crescer aos trancos
        if (this.lags.length < 60) this.delay = Math.max(this.delay, 20);
        this.pending.push({ f: frame, due: frame.timestamp / 1000 + this.base + this.delay });
        while (this.pending.length > 8) this.pending.shift()!.f.close();
    }

    private fit(w: number, h: number) {
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
    }

    /** quadros cuja hora de exibicao ja chegou (com 4 ms de antecedencia, para cair na pintura certa) */
    private takeReady(now: number) {
        const out: VideoFrame[] = [];
        while (this.pending.length && this.pending[0].due <= now + 4) out.push(this.pending.shift()!.f);
        return out;
    }

    private loop() {
        if (this.stopped) return;
        const now = performance.now();
        const ready = this.takeReady(now);
        if (this.fgActive) {
            this.queue.push(...ready);
            this.fgStep(now);
        } else {
            // sem geracao: um quadro por pintura, na ordem; se mais de 2 deram a hora juntos (rede travou), pula os mais velhos
            this.queue.forEach(q => q.close());
            this.queue = [];
            this.seg = null;
            while (ready.length > 2) { ready.shift()!.close(); this.late++; }
            const f = ready.shift();
            if (ready.length) this.pending.unshift({ f: ready[0], due: now });
            if (f) {
                this.fit(f.displayWidth, f.displayHeight);
                if (this.gl) this.gl.draw(f, f.displayWidth, f.displayHeight);
                else this.ctx!.drawImage(f, 0, 0);
                this.painted++;
                this.onPaint(f.displayWidth, f.displayHeight);
                f.close();
            }
        }
        this.raf = requestAnimationFrame(this.loop);
    }

    private fgStep(now: number) {
        const gl = this.gl!;
        const seg = this.seg;
        // o proximo trecho comeca quando o atual termina; so se acumularem 3 (rede travou) pula para o mais novo
        if (this.queue.length && (!seg || now >= seg.end || this.queue.length >= 3)) {
            if (seg && now < seg.end) while (this.queue.length > 1) { this.queue.shift()!.close(); this.late++; }
            const f = this.queue.shift()!;
            const w = f.displayWidth, h = f.displayHeight;
            this.fit(w, h);
            // intervalo real entre os dois quadros do jogo; parado por muito tempo (menu, tela estatica) = sem quadros do meio
            const d = seg ? (f.timestamp - seg.ts) / 1000 : 0;
            const ok = gl.fgPush(f, w, h, d > 0 && d <= 150);
            // ja tem outro quadro esperando = a imagem esta mais atrasada que o normal: este trecho passa um pouco mais rapido
            const dur = ok ? d * (this.queue.length ? 0.8 : 1) : 0;
            this.seg = { ts: f.timestamp, start: now, end: now + dur, steps: ok ? Math.round(viewFg.mult) : 1 };
            this.lastStep = -1;
            this.fgReal++;
            this.dirty = true;
            f.close();
        }
        const s = this.seg;
        if (!s) return;
        // o trecho entre dois quadros reais e dividido em partes iguais: 2x = 1 quadro criado no meio, 4x = 3
        const step = s.end > s.start ? Math.min(s.steps - 1, Math.floor((now - s.start) / (s.end - s.start) * s.steps)) : 0;
        if (step === this.lastStep && !this.dirty) return;
        this.lastStep = step;
        this.dirty = false;
        // passo 0 = quadro anterior (ja na tela no fim do trecho passado), entao o real novo entra no fim do trecho
        const a = s.steps > 1 ? (step + 1) / s.steps : 1;
        gl.fgDraw(a);
        if (a < 1) this.fgMade++;
        this.painted++;
        this.onPaint(this.canvas.width, this.canvas.height);
    }

    stop() {
        this.stopped = true;
        cancelAnimationFrame(this.raf);
        this.pending.forEach(p => p.f.close());
        this.pending = [];
        this.queue.forEach(q => q.close());
        this.queue = [];
    }
}
