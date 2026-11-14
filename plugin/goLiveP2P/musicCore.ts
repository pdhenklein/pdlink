/*
 * pdLink - musica sincronizada na chamada.
 * Este arquivo e o "cerebro" da fila: nao toca som nem fala com a rede, so guarda o estado e decide quem vence
 * quando duas pessoas mexem ao mesmo tempo. Assim da para testar fora do Discord.
 */

export interface Track {
    /** identificador desta entrada na fila (a mesma musica pode aparecer duas vezes) */
    id: string;
    /** de onde vem: "yt", "sc", "suno", "url" */
    src: string;
    /** endereco original ou identificador na fonte */
    ref: string;
    title: string;
    artist: string;
    /** duracao em segundos (0 = desconhecida) */
    dur: number;
    /** quem colocou (id do Discord) */
    by: string;
    /** capa (endereco https) */
    img: string;
}

export type LoopMode = "off" | "one" | "all";

export interface MusicState {
    /** numero da versao: quem tem o maior vence; empate decide pelo `who` */
    rev: number;
    who: string;
    queue: Track[];
    /** id da musica atual ("" = nada tocando) */
    cur: string;
    playing: boolean;
    /** posicao (segundos) valida no instante `at` */
    pos: number;
    /** instante do relogio comum (ms) em que `pos` valia */
    at: number;
    loop: LoopMode;
}

export const MAX_QUEUE = 300;
/** folga para todo mundo comecar junto depois de um comando (ms) */
export const LEAD_MS = 250;
/** estado parado ha mais tempo que isso e esquecido (ms) */
export const STALE_MS = 12 * 3600 * 1000;

export const emptyState = (): MusicState => ({ rev: 0, who: "", queue: [], cur: "", playing: false, pos: 0, at: 0, loop: "off" });

export const newer = (a: Pick<MusicState, "rev" | "who">, b: Pick<MusicState, "rev" | "who">) =>
    a.rev !== b.rev ? a.rev > b.rev : a.who > b.who;

export const currentTrack = (s: MusicState) => s.queue.find(t => t.id === s.cur) ?? null;

/** posicao da musica atual no instante `now` do relogio comum */
export function positionAt(s: MusicState, now: number) {
    const t = currentTrack(s);
    if (!t) return 0;
    let p = s.playing ? s.pos + (now - s.at) / 1000 : s.pos;
    if (p < 0) p = 0;
    if (t.dur > 0 && p > t.dur) p = t.dur;
    return p;
}

const str = (v: any, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: any) => (typeof v === "number" && isFinite(v) ? v : 0);

/** Confere um estado que veio da rede (nunca confiar no formato). */
export function sanitize(m: any): MusicState | null {
    if (!m || typeof m !== "object" || !Array.isArray(m.queue)) return null;
    const seen = new Set<string>();
    const queue: Track[] = [];
    for (const t of m.queue.slice(0, MAX_QUEUE)) {
        const id = str(t?.id, 24);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        queue.push({ id, src: str(t.src, 8), ref: str(t.ref, 400), title: str(t.title, 200), artist: str(t.artist, 120), dur: Math.max(0, num(t.dur)), by: str(t.by, 25), img: /^https:\/\//.test(str(t.img, 300)) ? str(t.img, 300) : "" });
    }
    const cur = seen.has(str(m.cur, 24)) ? str(m.cur, 24) : "";
    const loop: LoopMode = m.loop === "one" || m.loop === "all" ? m.loop : "off";
    return { rev: Math.max(0, Math.floor(num(m.rev))), who: str(m.who, 25), queue, cur, playing: !!m.playing && !!cur, pos: Math.max(0, num(m.pos)), at: num(m.at), loop };
}

export type Action =
    | { t: "add"; tracks: Track[]; next?: boolean; }
    | { t: "remove"; id: string; }
    | { t: "move"; id: string; to: number; }
    | { t: "clear"; }
    | { t: "play"; }
    | { t: "pause"; }
    | { t: "seek"; pos: number; }
    | { t: "nudge"; by: number; }
    | { t: "jump"; id: string; }
    | { t: "next"; }
    | { t: "prev"; }
    | { t: "loop"; mode: LoopMode; };

function startTrack(s: MusicState, id: string, at: number, playing = true) {
    s.cur = id;
    s.pos = 0;
    s.at = at;
    s.playing = playing && !!id;
}

function after(s: MusicState, wrap: boolean) {
    const i = s.queue.findIndex(t => t.id === s.cur);
    if (i < 0) return s.queue[0]?.id ?? "";
    if (i + 1 < s.queue.length) return s.queue[i + 1].id;
    return wrap ? s.queue[0].id : "";
}

/** Aplica um comando de alguem. Devolve o estado novo (ou o mesmo objeto se nada mudou). */
export function apply(old: MusicState, a: Action, who: string, now: number): MusicState {
    const s: MusicState = { ...old, queue: old.queue.slice() };
    const start = now + LEAD_MS;
    const here = positionAt(old, now);
    switch (a.t) {
        case "add": {
            const have = new Set(s.queue.map(t => t.id));
            const fresh = a.tracks.filter(t => t.id && !have.has(t.id)).slice(0, Math.max(0, MAX_QUEUE - s.queue.length));
            if (!fresh.length) return old;
            const i = s.queue.findIndex(t => t.id === s.cur);
            if (a.next && i >= 0) s.queue.splice(i + 1, 0, ...fresh); else s.queue.push(...fresh);
            // fila estava parada no fim (ou vazia): ja comeca a tocar a primeira que entrou
            if (!s.cur) startTrack(s, fresh[0].id, start);
            break;
        }
        case "remove": {
            const i = s.queue.findIndex(t => t.id === a.id);
            if (i < 0) return old;
            if (s.cur === a.id) {
                const nxt = s.queue[i + 1]?.id ?? "";
                s.queue.splice(i, 1);
                startTrack(s, nxt, start, old.playing);
            } else s.queue.splice(i, 1);
            break;
        }
        case "move": {
            const i = s.queue.findIndex(t => t.id === a.id);
            if (i < 0) return old;
            const to = Math.max(0, Math.min(s.queue.length - 1, Math.floor(a.to)));
            if (to === i) return old;
            const [t] = s.queue.splice(i, 1);
            s.queue.splice(to, 0, t);
            break;
        }
        case "clear":
            if (!s.queue.length) return old;
            s.queue = []; startTrack(s, "", now, false);
            break;
        case "play":
            if (s.playing || !s.queue.length) return old;
            if (!s.cur) startTrack(s, s.queue[0].id, start);
            else { s.pos = here; s.at = start; s.playing = true; }
            break;
        case "pause":
            if (!s.playing) return old;
            s.pos = here; s.at = now; s.playing = false;
            break;
        case "seek":
        case "nudge": {
            const t = currentTrack(s);
            if (!t) return old;
            let p = a.t === "seek" ? a.pos : here + a.by;
            if (!isFinite(p)) return old;
            p = Math.max(0, t.dur > 0 ? Math.min(p, Math.max(0, t.dur - 0.5)) : p);
            s.pos = p; s.at = s.playing ? start : now;
            break;
        }
        case "jump":
            if (!s.queue.some(t => t.id === a.id)) return old;
            startTrack(s, a.id, start);
            break;
        case "next": {
            if (!s.cur) return old;
            startTrack(s, after(s, s.loop === "all"), start, true);
            break;
        }
        case "prev": {
            const i = s.queue.findIndex(t => t.id === s.cur);
            if (i < 0) return old;
            // como nos players: depois de 3 s, "voltar" recomeca a musica; antes disso, vai para a anterior
            startTrack(s, here > 3 || i === 0 ? s.cur : s.queue[i - 1].id, start, true);
            break;
        }
        case "loop":
            if (s.loop === a.mode) return old;
            s.loop = a.mode;
            break;
    }
    s.rev = old.rev + 1;
    s.who = who;
    return s;
}

/**
 * A musica chegou ao fim: passa para a proxima. Todo mundo calcula isto sozinho e chega no MESMO resultado
 * (mesma versao, mesmo instante de inicio), entao ninguem precisa avisar ninguem e nao ha disputa.
 */
export function advanceIfEnded(old: MusicState, now: number): MusicState {
    const t = currentTrack(old);
    if (!t || !old.playing || t.dur <= 0) return old;
    const endAt = old.at + (t.dur - old.pos) * 1000;
    if (now < endAt) return old;
    const s: MusicState = { ...old, queue: old.queue.slice() };
    const nxt = old.loop === "one" ? t.id : after(s, old.loop === "all");
    startTrack(s, nxt, endAt, true);
    s.rev = old.rev + 1;
    s.who = "~fim";
    return s;
}

export interface Transport {
    /** publica o estado para a chamada (fica guardado para quem entrar depois) */
    publish(text: string, keep: boolean): void;
}

/** Junta estado + rede: repete o envio ate ver a propria mensagem voltar, e aceita so o que for mais novo. */
export class MusicSync {
    state = emptyState();
    onChange: (s: MusicState, mine: boolean) => void = () => { };
    private echoTimer: any = null;
    private tick: any = null;
    private tries = 0;
    private lastHeal = 0;
    private lastChange = 0;
    private nextHave = 0;

    constructor(private who: string, private now: () => number, private net: Transport) {
        this.tick = setInterval(() => { this.checkEnd(); this.sayHave(); }, 250);
    }

    stop() { clearInterval(this.tick); clearTimeout(this.echoTimer); }

    /**
     * De tempos em tempos cada um diz so "estou na versao N". Quem estiver mais adiantado reenvia o estado.
     * E isso que conserta uma mensagem perdida no caminho para UMA pessoa (o eco so prova que o ponto de encontro recebeu).
     */
    private sayHave() {
        const t = Date.now();
        if (t < this.nextHave) return;
        // logo depois de uma mudanca confere mais vezes; parado, quase nao gasta nada
        this.nextHave = t + (t - this.lastChange < 15000 ? 700 : 4000) + Math.random() * 300;
        this.net.publish(JSON.stringify({ have: [this.state.rev, this.state.who] }), false);
    }

    private heal() {
        if (this.state.rev > 0 && Date.now() - this.lastHeal > 400) {
            this.lastHeal = Date.now();
            this.net.publish(JSON.stringify(this.state), true);
        }
    }

    position() { return positionAt(this.state, this.now()); }

    do(a: Action) {
        this.checkEnd();
        const s = apply(this.state, a, this.who, this.now());
        if (s === this.state) return;
        this.state = s;
        this.lastChange = Date.now();
        this.onChange(s, true);
        this.send();
    }

    private checkEnd() {
        let s = this.state, n = 0;
        // varias musicas podem ter acabado se o PC ficou suspenso
        for (; n < 50; n++) { const x = advanceIfEnded(s, this.now()); if (x === s) break; s = x; }
        if (!n) return;
        this.state = s;
        this.onChange(s, false);
        // guarda no ponto de encontro para quem entrar depois; como todos mandam o mesmo texto, nao ha conflito
        this.net.publish(JSON.stringify(s), true);
    }

    private send() {
        clearTimeout(this.echoTimer);
        this.tries = 0;
        const go = () => {
            this.net.publish(JSON.stringify(this.state), true);
            // o ponto de encontro devolve a minha propria mensagem; se nao voltar, ela se perdeu: manda de novo
            if (++this.tries < 8) this.echoTimer = setTimeout(go, 600 + this.tries * 200);
        };
        go();
    }

    /** mensagem que chegou do ponto de encontro (inclusive o eco das minhas) */
    receive(text: string) {
        let m: any;
        try { m = JSON.parse(text); } catch { return; }
        if (Array.isArray(m?.have)) {
            const theirs = { rev: Number(m.have[0]) || 0, who: String(m.have[1] ?? "") };
            if (newer(this.state, theirs)) this.heal();
            else if (newer(theirs, this.state)) this.nextHave = 0; // estou atrasado: aviso logo, para alguem me mandar
            return;
        }
        const s = sanitize(m);
        if (!s) return;
        if (s.rev === this.state.rev && s.who === this.state.who) { clearTimeout(this.echoTimer); return; }
        if (newer(s, this.state)) {
            if (!s.playing && this.now() - s.at > STALE_MS) return;
            clearTimeout(this.echoTimer);
            this.state = s;
            this.lastChange = Date.now();
            this.onChange(s, false);
            this.checkEnd();
            return;
        }
        // alguem esta com informacao velha: reenvia a minha
        this.heal();
    }
}
