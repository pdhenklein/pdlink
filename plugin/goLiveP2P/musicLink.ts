/*
 * pdLink - musica do PC: o som e transmitido ao vivo, o arquivo nunca sai do PC de quem colocou.
 * Quem colocou a musica (dono) toca o arquivo e manda so o audio, por conexao direta, para cada pessoa da chamada.
 * Quem ouve pede a conexao (MOFFER) e o dono responde (MANSWER) so se a pessoa esta na chamada.
 * Os enderecos de rede vao junto na oferta/resposta, entao bastam duas mensagens (repetidas se o ponto de encontro perder).
 */

import { plog } from "./logger";

export interface MusicSignal { send(inbox: string, msg: any): void; inbox: string; }

const rand = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");
const MAX_SDP = 20000;
const MAX_LISTENERS = 24;

/** Pede ao Opus som de musica: estereo, alta qualidade, sem cortar o silencio. */
export function musicSdp(sdp: string) {
    const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1];
    if (!pt) return sdp;
    const extra = "stereo=1;sprop-stereo=1;maxaveragebitrate=256000;usedtx=0;useinbandfec=1";
    const re = new RegExp("a=fmtp:" + pt + " ([^\\r\\n]*)");
    if (re.test(sdp)) return sdp.replace(re, (_l, p: string) => "a=fmtp:" + pt + " " + p.split(";").filter(x => !/^(stereo|sprop-stereo|maxaveragebitrate|usedtx)=/.test(x)).concat(extra).join(";"));
    return sdp.replace(new RegExp("(a=rtpmap:" + pt + " opus/48000[^\\r\\n]*)"), "$1\r\na=fmtp:" + pt + " " + extra);
}

/** Espera juntar os enderecos de rede (no maximo `ms`), para mandar tudo numa mensagem so. */
function gathered(pc: RTCPeerConnection, ms = 2500) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise<void>(res => {
        const t = setTimeout(res, ms);
        pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); res(); } });
    });
}

// ------------------------------------------------------------------ dono: manda o som

interface Out { pc: RTCPeerConnection; userId: string; answer?: string; }

export class MusicServer {
    private conns = new Map<string, Out>();
    private timer: any;
    private rtt = 0;

    constructor(private sig: () => MusicSignal | null, private ice: RTCConfiguration, private track: MediaStreamTrack, private stream: MediaStream, private allowed: (userId: string) => boolean) {
        this.timer = setInterval(() => this.check(), 3000);
    }

    /** atraso estimado ate os ouvintes (s), para o dono ouvir junto com eles */
    latency() { return this.conns.size ? Math.min(0.4, Math.max(0.05, this.rtt / 2 + 0.07)) : 0; }
    count() { return [...this.conns.values()].filter(c => c.pc.connectionState === "connected").length; }

    async onOffer(m: any) {
        const sig = this.sig();
        if (!sig) return;
        const connectionId = String(m.connectionId ?? "");
        const userId = String(m.userId ?? "");
        const from = String(m.from ?? "");
        if (!/^m[0-9a-f]{16}$/.test(connectionId) || !/^glp\/v1\/[0-9a-f]{24}\/in\/[0-9a-f]{16}$/.test(from)) return;
        if (!/^\d{5,25}$/.test(userId) || !this.allowed(userId) || typeof m.sdp !== "string" || m.sdp.length > MAX_SDP) {
            sig.send(from, { type: "MANSWER", connectionId, denied: true });
            return;
        }
        const dup = this.conns.get(connectionId);
        if (dup) { if (dup.answer) sig.send(from, { type: "MANSWER", connectionId, sdp: dup.answer }); return; }
        // uma conexao por pessoa: a nova substitui a antiga
        for (const [id, c] of this.conns) if (c.userId === userId) this.drop(id);
        if (this.conns.size >= MAX_LISTENERS) { sig.send(from, { type: "MANSWER", connectionId, denied: true }); return; }
        const pc = new RTCPeerConnection(this.ice);
        const out: Out = { pc, userId };
        this.conns.set(connectionId, out);
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === "connected") plog("musica do PC: transmitindo para mais uma pessoa");
            if (pc.connectionState === "failed" || pc.connectionState === "closed") this.drop(connectionId);
        };
        try {
            pc.addTrack(this.track, this.stream);
            await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
            const ans = await pc.createAnswer();
            await pc.setLocalDescription({ type: "answer", sdp: musicSdp(ans.sdp ?? "") });
            await gathered(pc);
            if (this.conns.get(connectionId) !== out) return;
            out.answer = pc.localDescription?.sdp ?? "";
            sig.send(from, { type: "MANSWER", connectionId, sdp: out.answer });
        } catch (e) {
            plog("musica do PC: pedido de conexao falhou - " + String(e));
            this.drop(connectionId);
        }
    }

    private drop(id: string) {
        const c = this.conns.get(id);
        if (!c) return;
        this.conns.delete(id);
        try { c.pc.close(); } catch { }
    }

    /** derruba quem nao pode mais ouvir (saiu da chamada, ou a musica do PC saiu da fila) */
    async check() {
        // quem saiu da chamada para de receber na hora
        for (const [id, c] of this.conns) if (!this.allowed(c.userId)) this.drop(id);
        let best = 0;
        for (const c of this.conns.values()) {
            try {
                const st = await c.pc.getStats();
                st.forEach((r: any) => { if (r.type === "remote-inbound-rtp" && typeof r.roundTripTime === "number") best = Math.max(best, r.roundTripTime); });
            } catch { }
        }
        this.rtt = best;
    }

    stop() {
        clearInterval(this.timer);
        for (const id of [...this.conns.keys()]) this.drop(id);
    }
}

// ------------------------------------------------------------------ quem ouve: recebe o som

export interface Incoming { stream: MediaStream | null; status: string; }

export class MusicClient {
    private pc: RTCPeerConnection | null = null;
    private connectionId = "";
    private retry: any = null;
    private giveUp: any = null;
    readonly state: Incoming = { stream: null, status: "conectando" };

    constructor(private sig: () => MusicSignal | null, private ice: RTCConfiguration, readonly owner: string, private myUserId: string, private changed: () => void) {
        this.connect();
    }

    private set(stream: MediaStream | null, status: string) {
        this.state.stream = stream; this.state.status = status;
        this.changed();
    }

    private async connect() {
        this.close(false);
        const sig = this.sig();
        if (!sig) { this.set(null, "erro: sem conexao com o ponto de encontro"); return; }
        const pc = new RTCPeerConnection(this.ice);
        const connectionId = "m" + rand();
        this.pc = pc; this.connectionId = connectionId;
        this.set(null, "conectando");
        pc.addTransceiver("audio", { direction: "recvonly" });
        pc.ontrack = ev => { if (this.pc === pc) this.set(ev.streams[0] ?? new MediaStream([ev.track]), ""); };
        pc.onconnectionstatechange = () => {
            if (this.pc !== pc) return;
            if (pc.connectionState === "connected") { clearTimeout(this.giveUp); plog("musica do PC: recebendo o som"); }
            if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
                this.set(null, "erro: o som de quem colocou caiu, tentando de novo");
                setTimeout(() => { if (this.pc === pc) this.connect(); }, 3000);
            }
        };
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription({ type: "offer", sdp: musicSdp(offer.sdp ?? "") });
            await gathered(pc);
            if (this.pc !== pc) return;
            const msg = { type: "MOFFER", connectionId, sdp: pc.localDescription?.sdp ?? "", userId: this.myUserId };
            let tries = 0;
            const go = () => { if (this.pc === pc && !pc.remoteDescription && tries++ < 15) { this.sig()?.send(this.owner, msg); this.retry = setTimeout(go, 1000); } };
            go();
            // quem colocou a musica nao respondeu (saiu da chamada ou fechou o Discord)
            this.giveUp = setTimeout(() => {
                if (this.pc === pc && pc.connectionState !== "connected") {
                    this.set(null, "erro: quem colocou essa musica nao esta transmitindo (saiu da chamada?)");
                    setTimeout(() => { if (this.pc === pc) this.connect(); }, 8000);
                }
            }, 16000);
        } catch (e) {
            this.set(null, "erro: " + String(e));
        }
    }

    onAnswer(m: any) {
        const pc = this.pc;
        if (!pc || m.connectionId !== this.connectionId || pc.remoteDescription) return;
        clearTimeout(this.retry);
        if (m.denied) {
            // pode ser que eu tenha acabado de entrar na chamada e quem colocou ainda nao me viu: tento de novo depois
            this.set(null, "erro: quem colocou essa musica nao liberou o som para voce");
            const pc0 = pc;
            setTimeout(() => { if (this.pc === pc0) this.connect(); }, 10000);
            return;
        }
        if (typeof m.sdp !== "string" || m.sdp.length > MAX_SDP) return;
        pc.setRemoteDescription({ type: "answer", sdp: m.sdp }).catch(e => this.set(null, "erro: " + String(e)));
    }

    close(final = true) {
        clearTimeout(this.retry); clearTimeout(this.giveUp);
        try { this.pc?.close(); } catch { }
        this.pc = null; this.connectionId = "";
        if (final) this.state.stream = null;
    }
}
