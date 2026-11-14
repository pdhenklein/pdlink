/*
 * pdLink - musica: a parte que toca. Olha o estado combinado (musicCore) e mantem o player deste PC
 * no ponto certo: corrige pequenas diferencas mudando de leve a velocidade, e as grandes pulando direto.
 *
 * Musica do PC de outra pessoa: nao ha arquivo aqui; toca o som que chega ao vivo de quem colocou.
 * Musica do MEU PC: alem de tocar, o som vai para a transmissao (so enquanto ela esta tocando).
 */

import { currentTrack, MusicSync, Track } from "./musicCore";
import type { Incoming } from "./musicLink";

/** diferenca (s) acima da qual pula direto em vez de ajustar a velocidade */
const JUMP = 0.25;
/** diferenca (s) considerada "no ponto" */
const FINE = 0.015;

export interface PlayerHooks {
    /** som ao vivo de outra pessoa para esta musica (null = musica normal, toca aqui) */
    remote?(t: Track): Incoming | null;
    /** esta musica e do meu PC: manda o som para a chamada */
    sending?(t: Track): boolean;
    /** atraso ate quem ouve (s): eu ouco a minha musica com esse atraso, junto com eles */
    latency?(): number;
}

interface Route { ctx: AudioContext; monitor: GainNode; send: GainNode; delay: DelayNode; }

export class MusicPlayer {
    readonly audio = new Audio();
    /** toca o som que chega de outra pessoa */
    private live = new Audio();
    /** "" = pronto; senao o que esta acontecendo ("carregando", mensagem de erro) */
    status = "";
    onStatus: () => void = () => { };
    private loadedId = "";
    private loadingId = "";
    private timer: any = null;
    private startTimer: any = null;
    private urls = new Map<string, string>();
    private route: Route | null = null;
    private vol = 1;
    private mute = false;

    /**
     * @param load devolve um endereco tocavel (blob:) para a musica, ou lanca erro
     * @param now relogio comum (o mesmo usado no MusicSync)
     */
    constructor(private sync: MusicSync, private now: () => number, private load: (t: Track) => Promise<string>, private hooks: PlayerHooks = {}) {
        this.audio.preload = "auto";
        (this.audio as any).preservesPitch = false;
        this.live.autoplay = true;
        this.timer = setInterval(() => this.reconcile(), 200);
    }

    stop() {
        clearInterval(this.timer);
        clearTimeout(this.startTimer);
        this.audio.pause();
        this.audio.removeAttribute("src");
        this.audio.load();
        this.live.pause();
        this.live.srcObject = null;
        for (const u of this.urls.values()) URL.revokeObjectURL(u);
        this.urls.clear();
        this.route?.ctx.close().catch(() => { });
        this.route = null;
    }

    private applyVolume() {
        const v = this.mute ? 0 : this.vol;
        if (this.route) this.route.monitor.gain.value = v;
        else { this.audio.volume = this.vol; this.audio.muted = this.mute; }
        this.live.volume = this.vol; this.live.muted = this.mute;
    }
    setVolume(v: number) { this.vol = Math.max(0, Math.min(1, v)); this.applyVolume(); }
    setMuted(m: boolean) { this.mute = m; this.applyVolume(); }

    /**
     * Liga a saida para a transmissao. Depois disso o som do player passa por aqui:
     * player -> atraso -> volume -> alto-falante, e player -> chave -> transmissao.
     */
    sendTo(ctx: AudioContext, dest: MediaStreamAudioDestinationNode) {
        if (this.route) return;
        const src = ctx.createMediaElementSource(this.audio);
        const delay = ctx.createDelay(1);
        const monitor = ctx.createGain();
        const send = ctx.createGain();
        send.gain.value = 0;
        src.connect(delay).connect(monitor).connect(ctx.destination);
        src.connect(send).connect(dest);
        this.audio.volume = 1; this.audio.muted = false;
        this.route = { ctx, monitor, send, delay };
        this.applyVolume();
    }

    /** diferenca atual (s) entre o som deste PC e o ponto combinado; so para medir */
    error() {
        const s = this.sync.state;
        if (!s.playing || s.wait || this.audio.paused) return 0;
        return this.audio.currentTime - (s.pos + (this.now() - s.at) / 1000);
    }

    private setStatus(t: string) { if (t !== this.status) { this.status = t; this.onStatus(); } }

    private async fetchTrack(t: Track) {
        let u = this.urls.get(t.id);
        if (!u) { u = await this.load(t); this.urls.set(t.id, u); }
        return u;
    }

    /** baixa a proxima da fila antes da hora, para a troca sair sem buraco */
    private preloadNext() {
        const s = this.sync.state;
        const nxt = s.cur ? s.queue[1] : null;
        if (nxt && !this.urls.has(nxt.id) && !this.hooks.remote?.(nxt)) this.fetchTrack(nxt).catch(() => { });
        // solta da memoria o que saiu da fila
        const alive = new Set(s.queue.map(t => t.id));
        for (const [id, u] of this.urls) if (!alive.has(id)) { URL.revokeObjectURL(u); this.urls.delete(id); }
    }

    /** chave da transmissao e atraso de quem transmite */
    private setSending(on: boolean) {
        const r = this.route;
        if (!r) return;
        const g = on ? 1 : 0;
        if (r.send.gain.value !== g) r.send.gain.value = g;
        const d = on ? this.hooks.latency?.() ?? 0 : 0;
        // mexer no atraso no meio da musica da um "solucinho": so ajusta quando a diferenca vale a pena
        if (Math.abs(r.delay.delayTime.value - d) > 0.03) r.delay.delayTime.value = d;
        if (r.ctx.state === "suspended") r.ctx.resume().catch(() => { });
    }

    private playLive(inc: Incoming | null) {
        const want = inc?.stream ?? null;
        if (this.live.srcObject !== want) { this.live.srcObject = want; if (want) this.live.play().catch(() => { }); }
    }

    reconcile() {
        const s = this.sync.state;
        const a = this.audio;
        const t = currentTrack(s);
        if (!t) {
            if (this.loadedId) { a.pause(); a.removeAttribute("src"); a.load(); this.loadedId = ""; }
            this.playLive(null);
            this.setSending(false);
            this.setStatus("");
            return;
        }
        const inc = this.hooks.remote?.(t) ?? null;
        if (inc) {
            // musica do PC de outra pessoa: o tempo e o som sao de quem colocou
            if (!a.paused) a.pause();
            this.loadedId = ""; this.loadingId = "";
            this.setSending(false);
            this.playLive(inc);
            this.setStatus(inc.status);
            return;
        }
        this.playLive(null);
        this.setSending(!!this.hooks.sending?.(t));
        if (this.loadedId !== t.id) {
            if (this.loadingId === t.id) return;
            this.loadingId = t.id;
            a.pause();
            this.setStatus("carregando");
            this.fetchTrack(t).then(u => {
                if (this.loadingId !== t.id) return;
                this.loadingId = "";
                a.src = u;
                this.loadedId = t.id;
                this.setStatus("");
                this.preloadNext();
                this.reconcile();
            }).catch(e => {
                if (this.loadingId !== t.id) return;
                // nao trava a fila: fica marcado o erro e tenta de novo daqui a pouco
                this.setStatus("erro: " + String(e?.message ?? e).slice(0, 200));
                setTimeout(() => { if (this.loadingId === t.id) this.loadingId = ""; }, 5000);
            });
            return;
        }
        if (s.wait) {
            // carregou aqui: avisa a chamada, e so entao o tempo comeca a andar (para todos, a partir do zero)
            if (!a.paused) a.pause();
            if (Math.abs(a.currentTime - s.pos) > 0.01) a.currentTime = s.pos;
            this.sync.do({ t: "begin", id: t.id });
            return;
        }
        const target = s.pos + (this.now() - s.at) / 1000;
        if (!s.playing) {
            clearTimeout(this.startTimer); this.startTimer = null;
            if (!a.paused) a.pause();
            if (Math.abs(a.currentTime - s.pos) > 0.05) a.currentTime = s.pos;
            return;
        }
        if (target < s.pos) {
            // comando acabou de chegar e o inicio esta marcado para daqui a alguns ms: deixa no ponto e dispara na hora exata
            if (!a.paused) a.pause();
            if (Math.abs(a.currentTime - s.pos) > 0.01) a.currentTime = s.pos;
            if (!this.startTimer) this.startTimer = setTimeout(() => { this.startTimer = null; this.reconcile(); }, Math.max(0, (s.pos - target) * 1000));
            return;
        }
        if (a.paused) {
            a.currentTime = target;
            a.playbackRate = 1;
            a.play().catch(() => { });
            return;
        }
        const diff = a.currentTime - target;
        if (Math.abs(diff) > JUMP) { a.currentTime = target + 0.02; a.playbackRate = 1; }
        else if (Math.abs(diff) > FINE) a.playbackRate = 1 - Math.max(-0.04, Math.min(0.04, diff * 0.6));
        else if (a.playbackRate !== 1) a.playbackRate = 1;
        this.preloadNext();
    }
}
