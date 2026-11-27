/*
 * pdLink - musica, parte de fundo: acha as musicas (yt-dlp), baixa o audio para uma pasta temporaria
 * e mede a hora certa, para todos os PCs da chamada tocarem no mesmo ponto.
 */

import { execFile } from "child_process";
import { createHash } from "crypto";
import { createSocket } from "dgram";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

let dir = "";
let note: (text: string) => void = () => { };
export function musicInit(musicDir: string, log: (text: string) => void) { dir = musicDir; note = log; }

const exe = () => join(dir, "yt-dlp.exe");

// Login do YouTube: a pessoa escolhe (nas opcoes) o navegador onde ja esta logada; o yt-dlp usa essa sessao.
// Desligado por padrao. So nomes desta lista chegam ao yt-dlp.
const NAMES: Record<string, string> = { firefox: "Firefox", edge: "Microsoft Edge", chrome: "Google Chrome", brave: "Brave", opera: "Opera", operagx: "Opera GX" };
const BROWSERS = new Set(Object.keys(NAMES));
const browserName = () => NAMES[browser] ?? browser;
// O yt-dlp so conhece o Opera comum; o Opera GX guarda o login em outra pasta, entao passo a pasta dele
const cookieArg = (b: string) => b === "operagx" ? "opera:" + join(process.env.APPDATA ?? "", "Opera Software", "Opera GX Stable") : b;
let browser = "";
export function musicBrowser(b: string) {
    const v = BROWSERS.has(b) ? b : "";
    if (v !== browser) note(`musica: conta do YouTube ${v ? "do navegador " + v : "desligada"}`);
    browser = v;
}

/** Navegador padrao do Windows (o que abre links), em nome que o yt-dlp entende; "" se for outro. */
export function defaultBrowser(): Promise<string> {
    return new Promise(res => {
        execFile("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", "/v", "ProgId"], { windowsHide: true, timeout: 10000, encoding: "utf8" }, (e, out) => {
            const id = e ? "" : (/ProgId\s+REG_SZ\s+(.+)/i.exec(String(out))?.[1] ?? "");
            res(/^Firefox/i.test(id) ? "firefox" : /^MSEdge/i.test(id) ? "edge" : /^Chrome/i.test(id) ? "chrome" : /^Brave/i.test(id) ? "brave" : /^Opera\s*GX/i.test(id) ? "operagx" : /^Opera/i.test(id) ? "opera" : "");
        });
    });
}

/** O login funcionou? Pede o historico da conta (so abre logado), 1 item, sem baixar nada. */
export async function musicCheckLogin(): Promise<{ ok: true; } | { ok: false; error: string; }> {
    if (!browser) return { ok: false, error: "nenhum navegador escolhido" };
    try {
        await ensureTool();
        await run(["--flat-playlist", "-I", "1", "--print", "id", ":ythistory"], 60000);
        return { ok: true };
    } catch (e: any) {
        const m = String(e?.message ?? e);
        return { ok: false, error: /requires? (an? )?(account|login)|login required|sign in to view|not logged in/i.test(m) ? "o login ainda nao aparece nesse navegador. Termine de entrar no YouTube por la e clique em Pronto de novo" : m };
    }
}
const cacheDir = () => join(dir, "cache");
const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";

/** So aceito enderecos destes sites: o endereco pode vir de outra pessoa da chamada. */
const HOSTS = /^(?:[a-z0-9-]+\.)*(?:youtube\.com|youtu\.be|soundcloud\.com|suno\.com|suno\.ai|open\.spotify\.com)$/i;
export function allowedUrl(text: string) {
    try {
        const u = new URL(text);
        return u.protocol === "https:" && HOSTS.test(u.hostname) && !u.username && !u.password;
    } catch {
        return false;
    }
}

let getting: Promise<void> | null = null;
/** Baixa o yt-dlp na primeira vez; depois deixa ele se atualizar sozinho 1 vez por dia. */
function ensureTool() {
    if (existsSync(exe())) { selfUpdate(); return Promise.resolve(); }
    getting ??= (async () => {
        note("musica: baixando o yt-dlp (so na primeira vez)");
        mkdirSync(dir, { recursive: true });
        const r = await fetch(YTDLP_URL, { redirect: "follow" });
        if (!r.ok) throw new Error("nao consegui baixar o yt-dlp (" + r.status + ")");
        const data = Buffer.from(await r.arrayBuffer());
        if (data.length < 5_000_000 || data[0] !== 0x4d || data[1] !== 0x5a) throw new Error("o yt-dlp baixado veio estragado");
        writeFileSync(exe() + ".part", data);
        renameSync(exe() + ".part", exe());
        note("musica: yt-dlp pronto");
    })().finally(() => { getting = null; });
    return getting;
}

let updatedAt = 0;
function selfUpdate() {
    const stamp = join(dir, "atualizado.txt");
    if (!updatedAt) { try { updatedAt = statSync(stamp).mtimeMs; } catch { updatedAt = 1; } }
    if (Date.now() - updatedAt < 24 * 3600 * 1000) return;
    updatedAt = Date.now();
    try { writeFileSync(stamp, new Date().toISOString()); } catch { }
    execFile(exe(), ["-U"], { windowsHide: true, timeout: 120000 }, (e, out) => note("musica: atualizacao do yt-dlp: " + (e ? "falhou" : String(out).trim().split("\n").pop())));
}

function run(args: string[], timeout: number) {
    return new Promise<string>((res, rej) => {
        const login = browser ? ["--cookies-from-browser", cookieArg(browser)] : [];
        execFile(exe(), ["--no-warnings", "--no-config", "--ignore-config", "--use-extractors", "default,-generic", ...login, ...args], { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (e, out, err) => {
            if (e) {
                const raw = (String(err).trim().split("\n").filter(l => /ERROR/.test(l)).pop() ?? String(e.message)).replace(/^ERROR:\s*/, "");
                // o YouTube as vezes bloqueia downloads de uma internet por um tempo ("confirme que voce nao e um robo")
                rej(new Error(/not a bot|Sign in to confirm/i.test(raw)
                    ? (browser
                        ? "o YouTube pediu login de novo: abra o YouTube no " + browserName() + " e confira se o login esta ativo, ou escolha outro navegador na aba Conta da janela de musica"
                        : "o YouTube bloqueou por um tempo os downloads desta internet. Tente mais tarde, use SoundCloud, Suno ou musica do PC, ou entre com a sua conta na aba Conta da janela de musica")
                    : /cookie|decrypt|DPAPI|could not find .* database|Could not copy/i.test(raw)
                        ? "nao consegui ler o login do " + browserName() + " porque ele esta aberto. Feche o " + browserName() + " por completo (inclusive o icone perto do relogio) e clique em Pronto de novo. Se nao der, entre no YouTube pelo Firefox e escolha Firefox abaixo"
                        : raw.slice(0, 200)));
            }
            else res(String(out));
        });
    });
}

export interface Found { src: string; ref: string; title: string; artist: string; dur: number; img: string; }

function srcOf(url: string) {
    try {
        const h = new URL(url).hostname;
        return /youtu/.test(h) ? "yt" : /soundcloud/.test(h) ? "sc" : /suno/.test(h) ? "suno" : /spotify/.test(h) ? "spotify" : "url";
    } catch { return "url"; }
}

function toFound(e: any): Found | null {
    let ref: string = e?.webpage_url || e?.original_url || e?.url || "";
    if (e?.ie_key === "Youtube" && e?.id) ref = "https://www.youtube.com/watch?v=" + e.id;
    if (!allowedUrl(ref)) return null;
    const src = srcOf(ref);
    let img = "";
    if (src === "yt" && /^[\w-]{6,20}$/.test(e.id ?? "")) img = `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`;
    else if (typeof e.thumbnail === "string") img = e.thumbnail;
    else if (Array.isArray(e.thumbnails) && e.thumbnails.length) img = String(e.thumbnails[e.thumbnails.length - 1]?.url ?? "");
    return {
        src, ref, img,
        title: String(e.title ?? "Sem nome").slice(0, 200),
        artist: String(e.artist ?? e.uploader ?? e.channel ?? "").slice(0, 120),
        dur: Math.max(0, Number(e.duration) || 0)
    };
}

// ------------------------------------------------------------------ Suno
// O yt-dlp nao aceita o Suno, entao leio a pagina publica da musica (a mesma que abre para quem recebe o link).

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const isSuno = (url: string) => { try { return /(^|\.)suno\.(com|ai)$/i.test(new URL(url).hostname); } catch { return false; } };
const unescapeHtml = (t: string) => t.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

async function sunoPage(url: string): Promise<Found & { media: string; }> {
    const r = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
    // o link curto (suno.com/s/...) redireciona para a pagina da musica; confiro que continuou no Suno
    if (!r.ok || !allowedUrl(r.url) || !isSuno(r.url)) throw new Error("nao consegui abrir essa pagina do Suno (" + r.status + ")");
    const html = await r.text();
    const id = r.url.match(/\/song\/([0-9a-f-]{36})/i)?.[1];
    if (!id) throw new Error("esse link do Suno nao e de uma musica");
    const media = html.match(new RegExp("https://cdn\\d\\.suno\\.ai/" + id + "\\.mp4", "i"))?.[0];
    if (!media) throw new Error("essa musica do Suno nao esta publica");
    const meta = (p: string) => unescapeHtml(html.match(new RegExp('<meta property="' + p + '" content="([^"]*)"'))?.[1] ?? "");
    const img = meta("og:image");
    return {
        src: "suno", ref: "https://suno.com/song/" + id, media,
        title: (meta("og:title") || "Musica do Suno").slice(0, 200),
        artist: "Suno",
        dur: Math.max(0, Number(html.match(/duration\\?":([0-9.]+)/)?.[1]) || 0),
        img: /^https:\/\/cdn\d\.suno\.ai\//.test(img) ? img : ""
    };
}

async function sunoDownload(ref: string, key: string) {
    const page = await sunoPage(ref);
    const r = await fetch(page.media, { headers: { "user-agent": UA, referer: "https://suno.com/" } });
    if (!r.ok || !isSuno(r.url) || !r.body) throw new Error("o Suno nao entregou o audio (" + r.status + ")");
    const MAX = 200 * 1024 * 1024;
    if (Number(r.headers.get("content-length") ?? 0) > MAX) throw new Error("arquivo grande demais");
    const parts: Uint8Array[] = [];
    let size = 0;
    const reader = r.body.getReader();
    for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX) { reader.cancel().catch(() => { }); throw new Error("arquivo grande demais"); }
        parts.push(value);
    }
    writeFileSync(join(cacheDir(), key + ".mp4"), Buffer.concat(parts));
}

// ------------------------------------------------------------------ Spotify
// O audio do Spotify e protegido, entao ninguem toca direto dele (nem os bots pagos). Leio da pagina publica do player
// embutido o nome, os artistas, a duracao e a capa; na hora de tocar, acho a mesma musica no YouTube.

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
export const isSpotify = (url: string) => { try { return new URL(url).hostname === "open.spotify.com"; } catch { return false; } };
const spotifyImg = (url: unknown) => {
    const h = String(url ?? "").match(/^https:\/\/[a-z0-9.-]*(?:scdn\.co|spotifycdn\.com)\/image\/([0-9a-f]{20,64})$/i)?.[1];
    return h ? "https://i.scdn.co/image/" + h : "";
};
const bestImg = (e: any) => {
    const list: any[] = e?.visualIdentity?.image ?? e?.coverArt?.sources ?? [];
    const pick = list.find(i => i?.maxWidth === 300) ?? list[0];
    return spotifyImg(pick?.url);
};
const artistsOf = (e: any) => (Array.isArray(e?.artists) ? e.artists.map((a: any) => a?.name).filter(Boolean).join(", ") : String(e?.subtitle ?? "")).replace(/ /g, " ").slice(0, 120);

/** "https://open.spotify.com/intl-pt/track/ID?si=..." vira { kind: "track", id: "ID" } */
function spotifyParts(url: string) {
    const m = url.match(/^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|playlist)\/([A-Za-z0-9]{22})(?:[/?#]|$)/i);
    return m ? { kind: m[1].toLowerCase(), id: m[2] } : null;
}

async function spotifyEntity(kind: string, id: string) {
    if (!SPOTIFY_ID.test(id)) throw new Error("link do Spotify invalido");
    const r = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("nao consegui abrir esse link do Spotify (" + r.status + ")");
    const html = await r.text();
    if (html.length > 5_000_000) throw new Error("pagina do Spotify grande demais");
    const json = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    const e = json ? JSON.parse(json)?.props?.pageProps?.state?.data?.entity : null;
    if (!e) throw new Error("esse link do Spotify nao e publico");
    return e;
}

/** Le uma musica, album ou playlist do Spotify. A ref de cada musica e o link dela no Spotify. */
async function spotifyPage(url: string): Promise<{ items: Found[]; list: boolean; name?: string; capped?: boolean; }> {
    const p = spotifyParts(url);
    if (!p) throw new Error("use um link de musica, album ou playlist do Spotify");
    const e = await spotifyEntity(p.kind, p.id);
    const track = (id: string, title: unknown, artist: string, ms: unknown, img: string): Found => ({
        src: "spotify", ref: "https://open.spotify.com/track/" + id, img, artist,
        title: String(title ?? "Sem nome").slice(0, 200),
        dur: Math.max(0, Math.round(Number(ms) || 0) / 1000)
    });
    if (p.kind === "track") return { items: [track(p.id, e.name ?? e.title, artistsOf(e), e.duration, bestImg(e))], list: false };
    // album e playlist: a capa de cada musica e acertada na hora de tocar
    const cover = bestImg(e);
    const items = (Array.isArray(e.trackList) ? e.trackList : []).slice(0, 300)
        .map((t: any) => {
            const id = String(t?.uri ?? "").split(":").pop() ?? "";
            return SPOTIFY_ID.test(id) && t?.isPlayable !== false ? track(id, t.title, artistsOf(t), t.duration, cover) : null;
        })
        .filter((x: Found | null): x is Found => !!x);
    if (!items.length) throw new Error("nao achei musicas nesse link do Spotify");
    // o link publico do Spotify so mostra as 100 primeiras musicas de uma playlist
    return { items, list: true, name: String(e.name ?? e.title ?? "").slice(0, 60), capped: e.trackList.length >= 100 };
}

const resolved = new Map<string, { ref: string; img: string; dur: number; }>();
const BAD_VERSION = /\b(live|ao vivo|en vivo|cover|karaoke|instrumental|remix|8d|sped ?up|slowed|nightcore|reverb|acapella|acoustic|ac[uú]stico|reaction|tutorial|lyrics? video)\b/i;

/** Acha no YouTube a mesma musica de um link do Spotify (duracao parecida, sem versao ao vivo, cover, remix...). */
export async function musicResolve(ref: string, title: string, artist: string, dur: number): Promise<{ ok: true; ref: string; img: string; dur: number; } | { ok: false; error: string; }> {
    try {
        const p = spotifyParts(ref);
        if (!p || p.kind !== "track") return { ok: false, error: "link do Spotify invalido" };
        const have = resolved.get(p.id);
        if (have) return { ok: true, ...have };
        // a capa da propria musica (nas playlists a lista nao traz)
        let img = "";
        try { img = bestImg(await spotifyEntity("track", p.id)); } catch { }
        await ensureTool();
        const first = String(artist ?? "").split(",")[0].trim();
        const name = String(title ?? "").slice(0, 150);
        const out = await run(["-J", "--flat-playlist", "--", "ytsearch8:" + (first + " " + name).trim()], 40000);
        const entries: any[] = JSON.parse(out)?.entries ?? [];
        const d = Number(dur) || 0;
        const norm = (v: string) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
        const wantBad = BAD_VERSION.test(name);
        const scored = entries
            .filter(e => e?.id && /^[\w-]{6,20}$/.test(e.id))
            .map(e => {
                const t = norm(e.title), ch = norm(e.channel ?? e.uploader ?? "");
                const diff = d > 0 && e.duration ? Math.abs(Number(e.duration) - d) : 5;
                let s = Math.min(diff, 60);
                if (!wantBad && BAD_VERSION.test(t)) s += 40;
                if (!t.includes(norm(name).split(" (")[0].slice(0, 30))) s += 15;
                if (first && (ch.includes(norm(first)) || ch.endsWith(" - topic"))) s -= 4;
                return { e, s, diff };
            })
            .filter(x => d <= 0 || x.diff <= 15)
            .sort((a, b) => a.s - b.s);
        const best = scored[0]?.e;
        if (!best) return { ok: false, error: "nao achei essa musica do Spotify no YouTube" };
        const res = { ref: "https://www.youtube.com/watch?v=" + best.id, img: img || `https://i.ytimg.com/vi/${best.id}/mqdefault.jpg`, dur: Math.max(0, Number(best.duration) || 0) };
        if (resolved.size > 500) resolved.clear();
        resolved.set(p.id, res);
        note(`musica: Spotify "${name}" -> YouTube ${best.id}`);
        return { ok: true, ...res };
    } catch (e: any) {
        note("musica: Spotify falhou - " + String(e?.message ?? e));
        return { ok: false, error: "nao consegui achar essa musica do Spotify agora" };
    }
}

/** Busca por nome, ou le um link (musica ou playlist). */
export async function musicSearch(query: string, max = 500): Promise<{ ok: true; items: Found[]; list: boolean; name?: string; capped?: boolean; } | { ok: false; error: string; }> {
    try {
        query = String(query ?? "").trim().slice(0, 400);
        if (!query) return { ok: true, items: [], list: false };
        const isUrl = /^https?:\/\//i.test(query);
        if (isUrl && !allowedUrl(query)) return { ok: false, error: "Esse site ainda nao e aceito. Use YouTube, SoundCloud, Suno ou Spotify." };
        if (isUrl && isSpotify(query)) return { ok: true, ...await spotifyPage(query) };
        if (isUrl && isSuno(query)) {
            const { media: _m, ...found } = await sunoPage(query);
            return { ok: true, items: [found], list: false };
        }
        await ensureTool();
        const target = isUrl ? query : "ytsearch8:" + query;
        const out = await run(["-J", "--flat-playlist", "--playlist-end", String(Math.min(2000, Math.max(1, Math.round(Number(max) || 500)))), "--", target], 180000);
        const d = JSON.parse(out);
        const entries: any[] = Array.isArray(d.entries) ? d.entries : [d];
        const items = entries.map(toFound).filter((x): x is Found => !!x);
        return { ok: true, items, list: isUrl && Array.isArray(d.entries), name: String(d.title ?? "").slice(0, 60) };
    } catch (e: any) {
        note("musica: busca falhou - " + String(e?.message ?? e));
        return { ok: false, error: String(e?.message ?? e) };
    }
}

const MIME: Record<string, string> = { webm: "audio/webm", m4a: "audio/mp4", mp4: "audio/mp4", mp3: "audio/mpeg", opus: "audio/ogg", ogg: "audio/ogg", wav: "audio/wav" };
const fetching = new Map<string, Promise<{ file: string; mime: string; }>>();

function cached(key: string) {
    try {
        for (const f of readdirSync(cacheDir())) {
            const ext = f.split(".").pop() ?? "";
            if (f.startsWith(key + ".") && MIME[ext]) return { file: join(cacheDir(), f), mime: MIME[ext] };
        }
    } catch { }
    return null;
}

/** Apaga audios guardados ha mais de 1 dia (a pasta e so um apoio para nao baixar duas vezes). */
export function musicClean() {
    try {
        for (const f of readdirSync(cacheDir())) {
            const p = join(cacheDir(), f);
            try { if (Date.now() - statSync(p).mtimeMs > 24 * 3600 * 1000) unlinkSync(p); } catch { }
        }
    } catch { }
}

/** Baixa o audio da musica e devolve os dados para o player. */
export async function musicFetch(ref: string): Promise<{ ok: true; data: Uint8Array; mime: string; } | { ok: false; error: string; }> {
    try {
        if (!allowedUrl(ref)) return { ok: false, error: "endereco nao aceito" };
        // o Spotify nao entrega o audio: a musica precisa ser achada no YouTube antes (musicResolve)
        if (isSpotify(ref)) return { ok: false, error: "essa musica do Spotify ainda nao foi achada no YouTube" };
        const key = createHash("sha1").update(ref).digest("hex").slice(0, 20);
        let job = fetching.get(key);
        if (!job) {
            job = (async () => {
                const have = cached(key);
                if (have) return have;
                mkdirSync(cacheDir(), { recursive: true });
                const t0 = Date.now();
                if (isSuno(ref)) await sunoDownload(ref, key);
                else await ensureTool().then(() => run([
                    "--no-playlist", "--playlist-items", "1", "--no-part", "--max-filesize", "200M",
                    "-f", "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio[protocol^=http]/bestaudio/best",
                    "-o", join(cacheDir(), key + ".%(ext)s"), "--", ref
                ], 180000));
                const got = cached(key);
                if (!got) throw new Error("o audio nao veio (arquivo grande demais ou formato nao aceito)");
                note(`musica: audio baixado em ${Date.now() - t0} ms (${Math.round(statSync(got.file).size / 1024)} KB)`);
                return got;
            })().finally(() => fetching.delete(key));
            fetching.set(key, job);
        }
        const got = await job;
        return { ok: true, data: new Uint8Array(readFileSync(got.file)), mime: got.mime };
    } catch (e: any) {
        note("musica: download falhou - " + String(e?.message ?? e));
        return { ok: false, error: String(e?.message ?? e) };
    }
}

// ------------------------------------------------------------------ hora certa

const NTP_EPOCH = 2208988800000;
const stamp = (b: Buffer, o: number) => b.readUInt32BE(o) * 1000 + (b.readUInt32BE(o + 4) / 4294967296) * 1000 - NTP_EPOCH;

function ntpSample(host: string) {
    return new Promise<{ offset: number; rtt: number; } | null>(res => {
        const s = createSocket("udp4");
        const pkt = Buffer.alloc(48); pkt[0] = 0x23;
        let t0 = 0, done = false;
        const end = (v: { offset: number; rtt: number; } | null) => { if (done) return; done = true; clearTimeout(to); try { s.close(); } catch { } res(v); };
        const to = setTimeout(() => end(null), 1500);
        s.on("error", () => end(null));
        s.on("message", m => {
            const t3 = Date.now();
            if (m.length < 48) return end(null);
            const t1 = stamp(m, 32), t2 = stamp(m, 40);
            end({ offset: ((t1 - t0) + (t2 - t3)) / 2, rtt: (t3 - t0) - (t2 - t1) });
        });
        t0 = Date.now();
        s.send(pkt, 123, host, e => { if (e) end(null); });
    });
}

/** Quanto somar ao relogio deste PC para ter a hora certa (ms). `ok: false` = nao deu para medir. */
export async function musicClock(): Promise<{ ok: boolean; offset: number; }> {
    for (const host of ["time.cloudflare.com", "time.google.com", "pool.ntp.org"]) {
        const got: { offset: number; rtt: number; }[] = [];
        for (let i = 0; i < 4; i++) { const r = await ntpSample(host); if (r && Math.abs(r.offset) < 24 * 3600 * 1000) got.push(r); }
        if (got.length >= 2) {
            // a amostra com ida e volta mais curta e a mais confiavel
            got.sort((a, b) => a.rtt - b.rtt);
            note(`musica: relogio do PC ${got[0].offset >= 0 ? "atrasado" : "adiantado"} ${Math.abs(Math.round(got[0].offset))} ms (${host})`);
            return { ok: true, offset: got[0].offset };
        }
    }
    note("musica: nao consegui medir a hora certa; usando o relogio do PC");
    return { ok: false, offset: 0 };
}

// ------------------------------------------------------------------ letra (LRCLIB: banco aberto de letras com o tempo de cada linha)

export interface LyricLine { t: number; text: string; }
export type Lyrics = { ok: true; synced: LyricLine[] | null; plain: string | null; instrumental: boolean; } | { ok: false; error: string; };

const lyricCache = new Map<string, Lyrics>();
const JUNK = /\b(official|oficial|video|v[ií]deo|audio|[aá]udio|lyrics?|letra|clipe|visuali[sz]er|hd|4k|mv|remaster(ed)?|legendado|tradu[cç][aã]o)\b/i;

/** "Artista - Musica (Official Video) [4K]" vira { artist: "Artista", track: "Musica" } */
export function cleanTitle(title: string, artist: string) {
    let t = String(title ?? "").replace(/\.(mp3|m4a|aac|wav|flac|ogg|opus|webm)$/i, "");
    t = t.replace(/[([{]([^)\]}]*)[)\]}]/g, (m, inner: string) => (JUNK.test(inner) ? " " : m));
    t = t.replace(/\s(ft\.?|feat\.?|featuring)\s.*$/i, "").split(/\s[|/]\s/)[0];
    let a = String(artist ?? "").replace(/\s*-\s*topic$/i, "").replace(/vevo$/i, "").trim();
    const dash = t.split(/\s[-–]\s/);
    if (dash.length >= 2) { a = dash[0].trim(); t = dash.slice(1).join(" - "); }
    t = t.replace(/[([{][^)\]}]*[)\]}]/g, " ").replace(/["']/g, "").replace(/\s+/g, " ").trim();
    return { track: t.slice(0, 150), artist: a.slice(0, 100) };
}

export function parseLrc(text: string): LyricLine[] {
    const out: LyricLine[] = [];
    for (const raw of String(text).split(/\r?\n/).slice(0, 2000)) {
        const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)\]/g)];
        if (!stamps.length) continue;
        // tira as marcas de tempo de cada palavra (<00:18.89>)
        const words = raw.replace(/\[[^\]]*\]/g, "").replace(/<\d{1,3}:\d{1,2}(?:\.\d{1,3})?>/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
        for (const s of stamps) out.push({ t: Number(s[1]) * 60 + Number(s[2]), text: words });
    }
    return out.sort((x, y) => x.t - y.t);
}

async function lrclib(path: string) {
    const r = await fetch("https://lrclib.net/api/" + path, { headers: { "user-agent": "pdLink" }, signal: AbortSignal.timeout(10000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("o site de letras nao respondeu (" + r.status + ")");
    const text = await r.text();
    if (text.length > 2_000_000) throw new Error("resposta grande demais");
    return JSON.parse(text);
}

/** Acha a letra pelo nome. So vai ao LRCLIB o titulo e o artista da musica, nada sobre quem pede. */
export async function musicLyrics(title: string, artist: string, dur: number): Promise<Lyrics> {
    const { track, artist: a } = cleanTitle(title, artist);
    if (!track) return { ok: false, error: "musica sem nome" };
    const key = (track + "|" + a + "|" + Math.round(Number(dur) || 0)).toLowerCase();
    const have = lyricCache.get(key);
    if (have) return have;
    try {
        const d = Number(dur) || 0;
        const seen: any[] = [];
        for (const q of [a ? track + " " + a : track, track]) {
            const list = await lrclib("search?q=" + encodeURIComponent(q));
            if (Array.isArray(list)) seen.push(...list.slice(0, 20));
            if (seen.some(x => x?.syncedLyrics)) break;
        }
        // a mais parecida: com tempo de linha, duracao perto e mesmo artista
        const score = (x: any) => (x?.syncedLyrics ? 0 : 20) + (d > 0 ? Math.min(30, Math.abs(Number(x?.duration) - d)) : 0)
            + (a && String(x?.artistName ?? "").toLowerCase().includes(a.toLowerCase()) ? 0 : 6);
        // o nome tem que bater (o titulo do video pode vir como "Musica - Artista", entao aceito os dois lados)
        const norm = (v: string) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const like = (x: string, y: string) => { const p = norm(x), q = norm(y); return !!p && !!q && (p.includes(q) || q.includes(p)); };
        const named = (x: any) => like(x?.trackName, track) || (!!a && like(x?.trackName, a) && like(x?.artistName, track));
        const ok = seen.filter(x => x && (x.syncedLyrics || x.plainLyrics || x.instrumental) && named(x)
            && (d <= 0 || Math.abs(Number(x.duration) - d) <= (a ? 20 : 3)));
        ok.sort((x, y) => score(x) - score(y));
        const best = ok[0];
        const res: Lyrics = best
            ? { ok: true, instrumental: !!best.instrumental, synced: typeof best.syncedLyrics === "string" ? parseLrc(best.syncedLyrics) : null, plain: typeof best.plainLyrics === "string" ? best.plainLyrics.slice(0, 20000) : null }
            : { ok: false, error: "nao achei a letra dessa musica" };
        if (lyricCache.size > 200) lyricCache.clear();
        lyricCache.set(key, res);
        return res;
    } catch (e: any) {
        note("musica: letra falhou - " + String(e?.message ?? e));
        return { ok: false, error: "nao consegui buscar a letra agora" };
    }
}
