// Envio de arquivos entre PCs, direto (sem servidor e sem limite de tamanho).
// Quem envia so "oferece" o arquivo; quando alguem clica em Baixar, esse PC abre uma conexao direta com quem enviou
// e o arquivo e lido por pedacos e gravado no destino escolhido. Nada fica guardado em disco no meio do caminho.

const CHUNK = 64 * 1024; // tamanho de cada mensagem
const BLOCK = 1024 * 1024; // quanto se le do disco por vez
const HIGH = 8 * 1024 * 1024; // acima disso o envio espera a fila esvaziar
const LOW = 2 * 1024 * 1024;
const WINDOW = 32 * 1024 * 1024; // no maximo isso enviado e ainda nao gravado pelo destino (limita a memoria)
const ACK_EVERY = 4 * 1024 * 1024;
const CONNECT_TIMEOUT = 25000;

export interface FileOffer {
    id: string;
    name: string;
    size: number;
    inbox: string; // onde achar quem enviou (endereco de sinalizacao)
}

/** Confere uma oferta vinda da rede. */
export function sanitizeOffer(raw: any): FileOffer | null {
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{4,40}$/.test(raw.id)) return null;
    if (typeof raw.inbox !== "string" || !/^glp\/v1\/[0-9a-f]{24}\/in\/[0-9a-f]{16}$/.test(raw.inbox)) return null;
    if (typeof raw.size !== "number" || !Number.isFinite(raw.size) || raw.size < 0 || raw.size > 2 ** 50) return null;
    if (typeof raw.name !== "string") return null;
    const name = raw.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 200);
    if (!name) return null;
    return { id: raw.id, name, size: Math.floor(raw.size), inbox: raw.inbox };
}

export interface Sink {
    write(chunk: Uint8Array): Promise<void>;
    /** ok = false quando a transferencia foi cancelada ou falhou (o destino pode apagar o arquivo incompleto). */
    close(ok: boolean): Promise<void>;
}

export interface Progress {
    state: "connecting" | "downloading" | "done" | "error" | "cancelled";
    bytes: number;
    total: number;
    speed: number; // bytes por segundo
    error?: string;
}

export interface ServeStatus {
    state: "connecting" | "sending" | "done" | "error" | "cancelled";
    bytes: number;
    error?: string;
}

export interface Signal {
    send(inbox: string, msg: any): void;
    inbox: string;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const rand = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");

/** Candidatos ICE que chegam antes da descricao remota ficam na fila (senao se perdem). */
class CandidateQueue {
    private list: RTCIceCandidateInit[] = [];
    private ready = false;
    constructor(private pc: RTCPeerConnection) { }
    add(c: RTCIceCandidateInit) {
        if (this.ready) this.pc.addIceCandidate(c).catch(() => { });
        else this.list.push(c);
    }
    flush() {
        this.ready = true;
        for (const c of this.list) this.pc.addIceCandidate(c).catch(() => { });
        this.list = [];
    }
}

interface ServeEntry {
    answerSdp?: string;
    replyTo: string;
    pc: RTCPeerConnection;
    cands: CandidateQueue;
    userId: string;
    fileId: string;
    sent: number;
    acked: number;
    closed: boolean;
    wake?: () => void;
}

interface FetchEntry {
    pc: RTCPeerConnection;
    cands: CandidateQueue;
    answered: (m: any) => void;
}

export class FileEngine {
    /** Arquivos que EU ofereci: quem pode baixar cada um. */
    private outgoing = new Map<string, { file: File; to: Set<string>; }>();
    private serving = new Map<string, ServeEntry>();
    private early = new Map<string, RTCIceCandidateInit[]>();
    private fetching = new Map<string, FetchEntry>();
    onServe: (fileId: string, userId: string, st: ServeStatus) => void = () => { };
    /** Diagnostico (so testes): cada etapa da conexao. */
    dbg: ((line: string) => void) | null = null;

    constructor(private sig: () => Signal | null, private ice: RTCConfiguration) { }

    // ------------------------------------------------------------------ quem envia

    offer(file: File, toUserIds: string[]): FileOffer | null {
        const sig = this.sig();
        if (!sig) return null;
        const id = "f" + rand();
        this.outgoing.set(id, { file, to: new Set(toUserIds) });
        return { id, name: file.name, size: file.size, inbox: sig.inbox };
    }

    allow(fileId: string, userIds: string[]) {
        const o = this.outgoing.get(fileId);
        if (o) for (const u of userIds) o.to.add(u);
    }

    withdraw(fileId: string) {
        this.outgoing.delete(fileId);
        for (const s of this.serving.values()) if (s.fileId === fileId) this.endServe(s, "cancelled");
    }

    /** Mensagem de sinalizacao recebida; devolve true se era sobre arquivos. */
    onSignal(m: any): boolean {
        this.dbg?.(`recv ${m.type} ${m.connectionId} ${m.candidate ? String(m.candidate.candidate).slice(0, 60) : ""}`);
        if (m.type === "FOFFER") { this.acceptFetch(m).catch(e => this.dbg?.("acceptFetch erro " + e)); return true; }
        if (m.type === "FANSWER") { this.fetching.get(m.connectionId)?.answered(m); return true; }
        if (m.type === "FCAND") {
            const q = this.serving.get(m.connectionId)?.cands ?? this.fetching.get(m.connectionId)?.cands;
            if (q && m.candidate) q.add(m.candidate);
            else if (m.candidate && typeof m.connectionId === "string") {
                // chegou antes da oferta: guarda por pouco tempo
                const list = this.early.get(m.connectionId) ?? [];
                list.push(m.candidate);
                this.early.set(m.connectionId, list.slice(-20));
                setTimeout(() => this.early.delete(m.connectionId), 10000);
            }
            return true;
        }
        return false;
    }

    private async acceptFetch(m: any) {
        const sig = this.sig();
        const entry = this.outgoing.get(String(m.fileId));
        const userId = String(m.userId ?? "");
        if (!sig || !entry || !entry.to.has(userId) || typeof m.sdp !== "string") {
            sig?.send(m.from, { type: "FANSWER", connectionId: m.connectionId, denied: true });
            return;
        }
        const connectionId = String(m.connectionId);
        // o servidor de mensagens as vezes perde pacotes e o baixador repete o pedido: se ja atendi, so reenvio a resposta
        const dup = this.serving.get(connectionId);
        if (dup) {
            if (dup.answerSdp) sig.send(m.from, { type: "FANSWER", connectionId, sdp: dup.answerSdp });
            return;
        }
        const pc = new RTCPeerConnection(this.ice);
        const st: ServeEntry = { replyTo: String(m.from), pc, cands: new CandidateQueue(pc), userId, fileId: String(m.fileId), sent: 0, acked: 0, closed: false };
        this.serving.set(connectionId, st);
        for (const c of this.early.get(connectionId) ?? []) st.cands.add(c);
        this.early.delete(connectionId);
        this.onServe(st.fileId, userId, { state: "connecting", bytes: 0 });
        pc.onicecandidate = ev => { if (ev.candidate) this.sig()?.send(m.from, { type: "FCAND", connectionId, candidate: ev.candidate.toJSON() }); };
        pc.ondatachannel = ev => this.serve(ev.channel, st, entry.file);
        pc.onconnectionstatechange = () => {
            if (["failed", "closed", "disconnected"].includes(pc.connectionState)) this.endServe(st, st.sent >= entry.file.size && entry.file.size > 0 ? "done" : "error", "conexao caiu");
        };
        await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
        st.cands.flush();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        st.answerSdp = answer.sdp;
        sig.send(m.from, { type: "FANSWER", connectionId, sdp: answer.sdp });
        this.dbg?.(`send FANSWER ${connectionId}`);
        pc.oniceconnectionstatechange = () => this.dbg?.(`serve ice ${connectionId} ${pc.iceConnectionState}`);
        // ninguem abriu o canal: desiste
        setTimeout(() => { if (!st.closed && pc.connectionState !== "connected") this.endServe(st, "error", "sem resposta"); }, CONNECT_TIMEOUT);
    }

    private endServe(st: ServeEntry, state: ServeStatus["state"], error?: string) {
        if (st.closed) return;
        st.closed = true;
        st.wake?.();
        this.onServe(st.fileId, st.userId, { state, bytes: st.sent, error });
        setTimeout(() => { try { st.pc.close(); } catch { } }, 600);
        for (const [k, v] of this.serving) if (v === st) this.serving.delete(k);
    }

    private serve(dc: RTCDataChannel, st: ServeEntry, file: File) {
        dc.binaryType = "arraybuffer";
        dc.bufferedAmountLowThreshold = LOW;
        const wake = () => st.wake?.();
        dc.onbufferedamountlow = wake;
        let started = false;
        dc.onclose = () => this.endServe(st, st.sent >= file.size && file.size > 0 ? "done" : "cancelled");
        dc.onmessage = ev => {
            if (typeof ev.data !== "string") return;
            let msg: any;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.t === "get" && !started) {
                started = true;
                this.stream(dc, st, file).catch(e => {
                    try { dc.send(JSON.stringify({ t: "error", message: String(e) })); } catch { }
                    this.endServe(st, "error", String(e));
                });
            } else if (msg.t === "ack" && typeof msg.n === "number") { st.acked = Math.max(st.acked, msg.n); wake(); }
            else if (msg.t === "done") this.endServe(st, "done");
            else if (msg.t === "cancel") this.endServe(st, "cancelled");
        };
    }

    private async stream(dc: RTCDataChannel, st: ServeEntry, file: File) {
        const size = file.size;
        dc.send(JSON.stringify({ t: "start", size, name: file.name }));
        this.onServe(st.fileId, st.userId, { state: "sending", bytes: 0 });
        let pos = 0;
        let lastReport = 0;
        while (pos < size && !st.closed) {
            const block = new Uint8Array(await file.slice(pos, Math.min(size, pos + BLOCK)).arrayBuffer());
            for (let o = 0; o < block.length && !st.closed; o += CHUNK) {
                // espera ha espaco: fila do canal e janela de bytes ainda nao gravados pelo destino
                while (!st.closed && (dc.bufferedAmount > HIGH || st.sent - st.acked > WINDOW)) {
                    await Promise.race([new Promise<void>(r => { st.wake = r; }), sleep(50)]);
                }
                if (st.closed) return;
                const part = block.subarray(o, o + CHUNK);
                dc.send(part);
                st.sent += part.length;
            }
            pos += block.length;
            const now = performance.now();
            if (now - lastReport > 150) { lastReport = now; this.onServe(st.fileId, st.userId, { state: "sending", bytes: st.sent }); }
        }
    }

    // ------------------------------------------------------------------ quem baixa

    fetch(offer: FileOffer, myUserId: string, sink: Sink, onProgress: (p: Progress) => void) {
        const sig = this.sig();
        const connectionId = "d" + rand();
        let finished = false;
        let total = offer.size, written = 0, lastAck = 0;
        let queue: Promise<void> = Promise.resolve();
        const t0 = performance.now();
        let lastReport = 0;
        let pc: RTCPeerConnection | null = null;
        let dc: RTCDataChannel | null = null;
        let timer: any = null;
        let resolveDone!: () => void, rejectDone!: (e: Error) => void;
        const done = new Promise<void>((res, rej) => { resolveDone = res; rejectDone = rej; });
        done.catch(() => { });

        const report = (state: Progress["state"], error?: string, force = false) => {
            const now = performance.now();
            if (!force && now - lastReport < 120) return;
            lastReport = now;
            onProgress({ state, bytes: written, total, speed: written / Math.max(0.001, (now - t0) / 1000), error });
        };
        const finish = (state: "done" | "error" | "cancelled", error?: string) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            clearInterval(retry);
            this.fetching.delete(connectionId);
            // espera as gravacoes pendentes antes de fechar o arquivo
            queue.then(() => sink.close(state === "done")).catch(() => { }).then(() => {
                report(state, error, true);
                if (state === "done") resolveDone(); else rejectDone(new Error(error ?? state));
            });
            try { dc?.send(JSON.stringify({ t: state === "done" ? "done" : "cancel" })); } catch { }
            setTimeout(() => { try { pc?.close(); } catch { } }, 600);
        };

        if (!sig) {
            finish("error", "sem conexao com a chamada");
            return { done, cancel() { } };
        }
        report("connecting", undefined, true);
        pc = new RTCPeerConnection(this.ice);
        const cands = new CandidateQueue(pc);
        dc = pc.createDataChannel("f", { ordered: true });
        dc.binaryType = "arraybuffer";
        this.fetching.set(connectionId, {
            pc, cands,
            answered: async m => {
                if (answered) return; // resposta repetida
                answered = true;
                clearInterval(retry);
                if (m.denied) { finish("error", "quem enviou nao liberou este arquivo (ou ja saiu)"); return; }
                try {
                    await pc!.setRemoteDescription({ type: "answer", sdp: m.sdp });
                    cands.flush();
                } catch (e) { finish("error", String(e)); }
            }
        });
        // os candidatos ICE podem surgir antes de a oferta ser enviada; sairiam na frente dela e seriam perdidos
        let offerSent = false;
        let answered = false;
        let retry: any = null;
        const sentCands: any[] = [];
        const outCands: any[] = [];
        pc.onicecandidate = ev => {
            if (!ev.candidate) return;
            const msg = { type: "FCAND", connectionId, candidate: ev.candidate.toJSON() };
            if (offerSent) { this.sig()?.send(offer.inbox, msg); sentCands.push(msg); } else outCands.push(msg);
        };
        pc.onconnectionstatechange = () => {
            if (["failed", "closed"].includes(pc!.connectionState) && !finished) finish("error", "a conexao com quem enviou caiu");
        };
        timer = setTimeout(() => finish("error", "quem enviou nao respondeu (ele ainda esta na chamada?)"), CONNECT_TIMEOUT);
        dc.onopen = () => { clearTimeout(timer); dc!.send(JSON.stringify({ t: "get", id: offer.id })); };
        dc.onclose = () => { if (!finished && !(total > 0 && written >= total)) finish("error", "quem enviou fechou a conexao"); };
        dc.onmessage = ev => {
            if (finished) return;
            if (typeof ev.data === "string") {
                let msg: any;
                try { msg = JSON.parse(ev.data); } catch { return; }
                if (msg.t === "start") {
                    total = typeof msg.size === "number" ? msg.size : total;
                    report("downloading", undefined, true);
                    if (total === 0) finish("done");
                } else if (msg.t === "error") finish("error", String(msg.message ?? "erro no envio"));
                return;
            }
            const chunk = new Uint8Array(ev.data as ArrayBuffer);
            queue = queue.then(async () => {
                if (finished) return;
                await sink.write(chunk);
                written += chunk.length;
                if (written - lastAck >= ACK_EVERY) { lastAck = written; try { dc!.send(JSON.stringify({ t: "ack", n: written })); } catch { } }
                report("downloading");
                if (written >= total) finish("done");
            }).catch(e => finish("error", "erro ao gravar: " + String(e)));
        };
        pc.createOffer().then(async o => {
            await pc!.setLocalDescription(o);
            sig.send(offer.inbox, { type: "FOFFER", connectionId, sdp: o.sdp, fileId: offer.id, userId: myUserId });
            this.dbg?.(`send FOFFER ${connectionId}`);
            pc!.oniceconnectionstatechange = () => this.dbg?.(`fetch ice ${connectionId} ${pc!.iceConnectionState}`);
            offerSent = true;
            for (const c of outCands) { sig.send(offer.inbox, c); sentCands.push(c); }
            outCands.length = 0;
            // sem resposta em 2 s: repete o pedido (e os candidatos); o servidor publico perde mensagens de vez em quando
            let tries = 0;
            retry = setInterval(() => {
                if (finished || answered || ++tries > 10) { clearInterval(retry); return; }
                this.dbg?.(`retry FOFFER ${connectionId}`);
                sig.send(offer.inbox, { type: "FOFFER", connectionId, sdp: o.sdp, fileId: offer.id, userId: myUserId });
                for (const c of sentCands) sig.send(offer.inbox, c);
            }, 2000);
        }).catch(e => finish("error", String(e)));

        return {
            done,
            cancel: () => finish("cancelled", "cancelado")
        };
    }

    close() {
        for (const s of [...this.serving.values()]) this.endServe(s, "cancelled");
        for (const f of this.fetching.values()) { try { f.pc.close(); } catch { } }
        this.fetching.clear();
        this.outgoing.clear();
    }
}
