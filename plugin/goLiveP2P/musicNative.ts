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
const cacheDir = () => join(dir, "cache");
const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";

/** So aceito enderecos destes sites: o endereco pode vir de outra pessoa da chamada. */
const HOSTS = /^(?:[a-z0-9-]+\.)*(?:youtube\.com|youtu\.be|soundcloud\.com|suno\.com|suno\.ai)$/i;
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
        execFile(exe(), ["--no-warnings", "--no-config", "--ignore-config", "--use-extractors", "default,-generic", ...args], { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (e, out, err) => {
            if (e) rej(new Error((String(err).trim().split("\n").filter(l => /ERROR/.test(l)).pop() ?? String(e.message)).replace(/^ERROR:\s*/, "").slice(0, 200)));
            else res(String(out));
        });
    });
}

export interface Found { src: string; ref: string; title: string; artist: string; dur: number; img: string; }

function srcOf(url: string) {
    try {
        const h = new URL(url).hostname;
        return /youtu/.test(h) ? "yt" : /soundcloud/.test(h) ? "sc" : /suno/.test(h) ? "suno" : "url";
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

/** Busca por nome, ou le um link (musica ou playlist). */
export async function musicSearch(query: string): Promise<{ ok: true; items: Found[]; list: boolean; } | { ok: false; error: string; }> {
    try {
        query = String(query ?? "").trim().slice(0, 400);
        if (!query) return { ok: true, items: [], list: false };
        const isUrl = /^https?:\/\//i.test(query);
        if (isUrl && !allowedUrl(query)) return { ok: false, error: "Esse site ainda nao e aceito. Use YouTube, SoundCloud ou Suno." };
        if (isUrl && isSuno(query)) {
            const { media: _m, ...found } = await sunoPage(query);
            return { ok: true, items: [found], list: false };
        }
        await ensureTool();
        const target = isUrl ? query : "ytsearch8:" + query;
        const out = await run(["-J", "--flat-playlist", "--playlist-end", "200", "--", target], 40000);
        const d = JSON.parse(out);
        const entries: any[] = Array.isArray(d.entries) ? d.entries : [d];
        const items = entries.map(toFound).filter((x): x is Found => !!x);
        return { ok: true, items, list: isUrl && Array.isArray(d.entries) };
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
