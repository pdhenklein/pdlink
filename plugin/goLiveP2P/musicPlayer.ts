/*
 * pdLink - musica: a parte que toca. Olha o estado combinado (musicCore) e mantem o player deste PC
 * no ponto certo: corrige pequenas diferencas mudando de leve a velocidade, e as grandes pulando direto.
 */

import { currentTrack, MusicSync, Track } from "./musicCore";

/** diferenca (s) acima da qual pula direto em vez de ajustar a velocidade */
const JUMP = 0.25;
/** diferenca (s) considerada "no ponto" */
const FINE = 0.015;

export class MusicPlayer {
    readonly audio = new Audio();
    /** "" = pronto; senao o que esta acontecendo ("carregando", mensagem de erro) */
    status = "";
    onStatus: () => void = () => { };
    private loadedId = "";
    private loadingId = "";
    private timer: any = null;
    private startTimer: any = null;
    private urls = new Map<string, string>();

    /**
     * @param load devolve um endereco tocavel (blob:) para a musica, ou lanca erro
     * @param now relogio comum (o mesmo usado no MusicSync)
     */
    constructor(private sync: MusicSync, private now: () => number, private load: (t: Track) => Promise<string>) {
        this.audio.preload = "auto";
        (this.audio as any).preservesPitch = false;
        this.timer = setInterval(() => this.reconcile(), 200);
    }

    stop() {
        clearInterval(this.timer);
        clearTimeout(this.startTimer);
        this.audio.pause();
        this.audio.removeAttribute("src");
        this.audio.load();
        for (const u of this.urls.values()) URL.revokeObjectURL(u);
        this.urls.clear();
    }

    setVolume(v: number) { this.audio.volume = Math.max(0, Math.min(1, v)); }
    setMuted(m: boolean) { this.audio.muted = m; }

    /** diferenca atual (s) entre o som deste PC e o ponto combinado; so para medir */
    error() {
        const s = this.sync.state;
        if (!s.playing || this.audio.paused) return 0;
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
        const i = s.queue.findIndex(t => t.id === s.cur);
        const nxt = i >= 0 ? s.queue[i + 1] : null;
        if (nxt && !this.urls.has(nxt.id)) this.fetchTrack(nxt).catch(() => { });
        // solta da memoria o que saiu da fila
        const alive = new Set(s.queue.map(t => t.id));
        for (const [id, u] of this.urls) if (!alive.has(id)) { URL.revokeObjectURL(u); this.urls.delete(id); }
    }

    reconcile() {
        const s = this.sync.state;
        const a = this.audio;
        const t = currentTrack(s);
        if (!t) {
            if (this.loadedId) { a.pause(); a.removeAttribute("src"); a.load(); this.loadedId = ""; }
            this.setStatus("");
            return;
        }
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
