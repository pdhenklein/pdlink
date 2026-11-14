import { randomBytes } from "crypto";
import { execFile, spawn } from "child_process";
import { ConnectSrc, CspPolicies, ImageSrc } from "@main/csp";
import { app, IpcMainInvokeEvent } from "electron";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "fs";
import { createServer, Server, ServerResponse } from "http";
import { tmpdir } from "os";
import { join } from "path";

import { closeAll, closeFile, openFile, reveal, saveDialog, writeFile } from "./fileNative";
import { musicClean, musicClock as mClock, musicFetch as mFetch, musicInit, musicLyrics as mLyrics, musicSearch as mSearch } from "./musicNative";
import { overlayInfo, sendOverlay, showToast, startOverlay, stopOverlay } from "./overlay";
import { discordUpdateExe, relaunchAfterExit } from "./updateRestart";

// Brokers MQTT publicos usados so para sinalizacao (textos de conexao e quem esta ao vivo); o video nunca passa por la
CspPolicies["wss://broker.emqx.io:8084"] = ConnectSrc;
CspPolicies["wss://broker.hivemq.com:8884"] = ConnectSrc;
// capas das musicas
CspPolicies["i.ytimg.com"] = ImageSrc;
CspPolicies["*.sndcdn.com"] = ImageSrc;
CspPolicies["*.suno.ai"] = ImageSrc;

// Instalado (pacote): o auxiliar e a pagina de assistir ficam ao lado deste arquivo (patcher.js).
// Desenvolvimento: usa as pastas do projeto.
const PKG_DIR = __dirname;
const PACKAGED = existsSync(join(PKG_DIR, "golive-helper.exe"));
const VIEWER_PAGE = PACKAGED ? join(PKG_DIR, "viewer.html") : "F:/Discord2/Vencord/src/userplugins/goLiveP2P/viewer.html";
const WATCH_PORT = 47615;
const HELPER = PACKAGED ? join(PKG_DIR, "golive-helper.exe") : "F:\\Discord2\\helper\\bin\\golive-helper-p15.exe";
// relatorios de diagnostico: no pacote ficam na pasta de dados do usuario
const PROBE_DIR = PACKAGED ? join(PKG_DIR, "..", "logs") : "F:/Discord2/probe";

export interface StreamOpts {
    hwnd?: number;
    monitor?: number;
    fps: number;
    maxH: number; // 0 = tamanho original
    quality: number; // 1..100
    pid?: number; // audio so desse processo (janela)
    audio?: boolean;
    bitrate?: number; // H.264 pela placa de video
    cursor?: "follow" | "always" | "never";
}

let server: Server | null = null;
let port = 0;
const token = randomBytes(16).toString("hex");
// senha da pagina de teste: so existe neste PC e so e entregue pelo servidor local (127.0.0.1)
const pageToken = randomBytes(16).toString("hex");
const clients = new Set<ServerResponse>();
let helper: ReturnType<typeof spawn> | null = null;
let lastError = "";
let lastStat = "";

function run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(HELPER, args, { encoding: "buffer", windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
            if (err) reject(err);
            else resolve((stdout as unknown as Buffer).toString("utf8"));
        });
    });
}

export interface SourcesQuery {
    only?: "w" | "m"; // atualiza so janelas ou so telas
    icons?: boolean;
}

let lastWindowDiag = "";

export async function getSources(_: IpcMainInvokeEvent, q: SourcesQuery = {}) {
    if (!existsSync(HELPER)) throw new Error("Auxiliar nao encontrado em " + HELPER);
    const list = JSON.parse(await run(["list", "--json", "--all"]));
    // diagnostico: quais janelas ficaram de fora da lista e por que (ajuda quando um jogo "nao aparece")
    try {
        const diag = JSON.stringify({ at: new Date().toISOString(), naLista: list.windows.map((w: any) => `${w.exe} | ${w.title}${w.min ? " (minimizada)" : ""}`), ignoradas: list.skipped });
        const key = diag.replace(/"at":"[^"]*",/, "");
        if (key !== lastWindowDiag) {
            lastWindowDiag = key;
            const { mkdirSync, writeFileSync } = require("fs") as typeof import("fs");
            mkdirSync(PROBE_DIR, { recursive: true });
            writeFileSync(join(PROBE_DIR, "janelas-ignoradas.json"), diag, "utf8");
        }
    } catch { }
    const dir = mkdtempSync(join(tmpdir(), "golive-"));
    try {
        const args = ["thumbs", "--out", dir, "--w", "320", "--icons", q.icons === false ? "0" : "1"];
        if (q.only) args.push("--only", q.only);
        await run(args);
    } catch (e) {
        lastError = String(e);
    }
    const thumb = (name: string) => {
        try {
            return "data:image/jpeg;base64," + readFileSync(join(dir, name + ".jpg")).toString("base64");
        } catch {
            return null;
        }
    };
    const icon = (name: string) => {
        try {
            return "data:image/png;base64," + readFileSync(join(dir, name + ".png")).toString("base64");
        } catch {
            return null;
        }
    };
    // janelas que o seletor nativo do Discord nao mostra
    const hidden = new Set(["discord.exe", "explorer.exe", "applicationframehost.exe", "systemsettings.exe", "textinputhost.exe", "golive-helper.exe", "golive-helper-p6.exe", "golive-helper-p7.exe", "golive-helper-p8.exe", "golive-helper-p12.exe", "golive-helper-p13.exe", "golive-helper-p14.exe", "golive-helper-p15.exe", "whatsapp.root.exe", "whatsapp.exe"]);
    list.windows = list.windows.filter((w: any) => !hidden.has(String(w.exe).toLowerCase()));
    const windows = list.windows.map((w: any) => ({ ...w, thumb: thumb("w" + w.hwnd), icon: icon("i" + w.hwnd) }));
    const monitors = list.monitors.map((m: any) => ({ ...m, thumb: thumb("m" + m.index) }));
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
    return { windows, monitors };
}

function allowedOrigin(origin?: string) {
    return !!origin && /^https:\/\/([a-z0-9-]+\.)?discord\.com$/.test(origin);
}

function ensureServer(): Promise<void> {
    if (server) return Promise.resolve();
    return new Promise(resolve => {
        server = createServer((req, res) => {
            if (req.url?.split("#")[0] === "/watch" || req.url === "/") {
                try {
                    const html = readFileSync(VIEWER_PAGE, "utf8").replace("__GLV_LOCAL_TOKEN__", pageToken);
                    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
                    res.end(html);
                } catch {
                    res.writeHead(500);
                    res.end("pagina de assistir nao encontrada");
                }
                return;
            }
            if (req.url === "/viewer-hw.js") {
                try {
                    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
                    res.end(readFileSync(join(VIEWER_PAGE, "..", "viewer-hw.js")));
                } catch {
                    res.writeHead(404);
                    res.end();
                }
                return;
            }
            const origin = req.headers.origin as string | undefined;
            if (req.url !== "/stream/" + token || !allowedOrigin(origin)) {
                res.writeHead(404);
                res.end();
                return;
            }
            res.writeHead(200, {
                "Content-Type": "application/octet-stream",
                "Access-Control-Allow-Origin": origin!,
                "Cache-Control": "no-store",
                "Vary": "Origin"
            });
            clients.add(res);
            req.on("close", () => clients.delete(res));
        });
        const onListening = () => {
            port = (server!.address() as any).port;
            resolve();
        };
        // porta fixa para o endereco de "assistir no navegador" nao mudar entre aberturas
        server.once("error", () => server!.listen(0, "127.0.0.1", onListening));
        server.listen(WATCH_PORT, "127.0.0.1", onListening);
    });
}

function killHelper() {
    if (helper) {
        try { helper.stdin?.end(); } catch { }
        try { helper.kill(); } catch { }
        helper = null;
    }
}

export async function startStream(_: IpcMainInvokeEvent, o: StreamOpts) {
    await ensureServer();
    killHelper();
    lastError = "";
    const args = ["stream"];
    if (o.hwnd != null) args.push("--hwnd", String(o.hwnd));
    else args.push("--monitor", String(o.monitor ?? 0));
    args.push("--fps", String(o.fps), "--quality", String(o.quality), "--cursor", o.cursor ?? "follow");
    if (o.maxH > 0) args.push("--maxh", String(o.maxH));
    // video comprimido em H.264 na propria placa de video (se nao houver codificador por hardware, o auxiliar volta ao JPEG)
    args.push("--codec", "h264", "--bitrate", String(Math.round(o.bitrate ?? 12e6)));
    if (o.audio !== false) {
        // janela: so o som do processo dela. Tela inteira: tudo menos o proprio Discord (evita eco da chamada)
        if (o.hwnd != null && o.pid) args.push("--pid", String(o.pid));
        else if (o.hwnd == null) args.push("--exclude-pid", String(process.pid));
    }

    const proc = spawn(HELPER, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    helper = proc;
    logLine(`captura: iniciada (${o.hwnd != null ? "janela" : "tela inteira " + (o.monitor ?? 0)}, ${o.maxH}p ${o.fps} fps, som ${o.audio !== false ? "sim" : "nao"})`);
    let errLines = 0;
    // Tela inteira com som: anota quem esta tocando som e se faz parte do Discord. Se a voz do Discord vazar na live, este arquivo
    // (audio-sessoes.json, na pasta de logs) mostra qual programa esta refazendo o som do Discord.
    if (o.audio !== false && o.hwnd == null) {
        setTimeout(() => {
            run(["audio-sessions", "--root", String(process.pid)]).then(t => writeProbe("audio-sessoes.json", t)).catch(() => { });
        }, 4000);
    }
    let buf = Buffer.alloc(0);
    proc.stdout!.on("data", (chunk: Buffer) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        while (buf.length >= 5) {
            const len = buf.readUInt32LE(1);
            if (len > 32 * 1024 * 1024) { buf = Buffer.alloc(0); break; }
            if (buf.length < 5 + len) break;
            const frame = buf.subarray(0, 5 + len);
            const isVideo = frame[0] === 0; // so JPEG pode ser descartado; H.264 perderia referencias
            buf = buf.subarray(5 + len);
            if (helper !== proc) continue;
            // audio nunca e descartado; video so quando o cliente esta atrasado
            for (const c of clients) if (!isVideo || !c.writableNeedDrain) c.write(frame);
        }
    });
    proc.stderr!.on("data", (d: Buffer) => {
        lastError = d.toString("utf8").slice(-300); lastStat = d.toString("utf8");
        if (errLines++ < 8) logLine("captura diz: " + lastStat.trim().slice(0, 300));
    });
    proc.on("exit", code => {
        logLine(`captura: encerrada (codigo ${code})${code ? " - " + lastError.trim().slice(-200) : ""}`);
        if (helper === proc) helper = null;
        if (code) lastError = "auxiliar saiu com codigo " + code + ". " + lastError;
    });
    return { port, token };
}

export function stopStream(_: IpcMainInvokeEvent) {
    if (helper) logLine("captura: pedido para parar");
    killHelper();
}

export function status(_: IpcMainInvokeEvent) {
    return { running: !!helper, lastError, lastStat, clients: clients.size };
}

// Marcacoes dos espectadores (ping e desenho) desenhadas por cima da janela transmitida
export function overlayStart(_: IpcMainInvokeEvent, src: { hwnd?: number; monitor?: number; }, excludeFromCapture?: boolean) {
    startOverlay(HELPER, src, false, !!excludeFromCapture);
}

export function overlayMark(_: IpcMainInvokeEvent, json: string) {
    try { sendOverlay(JSON.parse(json)); } catch { }
}

export function overlayStop(_: IpcMainInvokeEvent) {
    stopOverlay();
}

export function overlayStatus(_: IpcMainInvokeEvent) {
    return overlayInfo();
}

/** Aviso por cima do jogo (some sozinho). Funciona com ou sem live. */
export function overlayToast(_: IpcMainInvokeEvent, title: string, text: string, ms: number) {
    showToast(HELPER, String(title), String(text), Number(ms) || 7000);
}

// Arquivos recebidos: janela de salvar do Windows e gravacao em disco
export function fileSaveDialog(_: IpcMainInvokeEvent, name: string) {
    return saveDialog(String(name));
}
export function fileOpen(_: IpcMainInvokeEvent, path: string) {
    return openFile(String(path));
}
export function fileWrite(_: IpcMainInvokeEvent, fd: number, data: Uint8Array) {
    writeFile(fd, data);
}
export function fileClose(_: IpcMainInvokeEvent, fd: number, ok: boolean) {
    closeFile(fd, !!ok);
}
export function fileReveal(_: IpcMainInvokeEvent, path: string) {
    reveal(String(path));
}

app.on("before-quit", () => {
    closeAll();
    stopOverlay();
    killHelper();
    for (const c of clients) { try { c.end(); } catch { } }
    server?.close();
});

// ---- log da sessao: UM arquivo (logs/pdlink.log), recomecado toda vez que o Discord abre. Se passar de 3 MB, recomeca
// guardando so a metade mais nova, para nunca crescer sem limite.
const LOG_FILE = join(PROBE_DIR, "pdlink.log");
const LOG_MAX = 3 * 1024 * 1024;
let logBytes = 0;
const stamp = () => { const d = new Date(); return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0"); };
function logLine(text: string) {
    try {
        const fs = require("fs") as typeof import("fs");
        const NL = String.fromCharCode(10);
        const line = stamp() + " " + text.split(NL).join(" | ") + NL;
        if (logBytes === 0) {
            fs.mkdirSync(PROBE_DIR, { recursive: true });
            const head = `pdLink ${readVersion(PKG_DIR) || "desenvolvimento"} - Discord aberto em ${new Date().toLocaleString("pt-BR")}` + NL;
            fs.writeFileSync(LOG_FILE, head, "utf8");
            logBytes = head.length;
        }
        if (logBytes > LOG_MAX) {
            const keep = fs.readFileSync(LOG_FILE, "utf8").slice(-LOG_MAX / 2);
            fs.writeFileSync(LOG_FILE, "(inicio do log cortado: ficou grande demais)" + NL + keep.slice(keep.indexOf(NL) + 1), "utf8");
            logBytes = LOG_MAX / 2;
        }
        fs.appendFileSync(LOG_FILE, line, "utf8");
        logBytes += line.length;
    } catch { }
}

logLine("parte de fundo do pdLink iniciada");

// ---- musica
musicInit(PACKAGED ? join(PKG_DIR, "..", "music") : "F:/Discord2/probe/music", t => logLine(t));
setTimeout(musicClean, 30000); setInterval(musicClean, 6 * 3600 * 1000);
export function musicSearch(_: IpcMainInvokeEvent, query: string) { return mSearch(query); }
export function musicFetch(_: IpcMainInvokeEvent, ref: string) { return mFetch(String(ref)); }
export function musicClock(_: IpcMainInvokeEvent) { return mClock(); }
export function musicLyrics(_: IpcMainInvokeEvent, title: string, artist: string, dur: number) { return mLyrics(String(title ?? "").slice(0, 300), String(artist ?? "").slice(0, 200), Number(dur) || 0); }

/** Linhas vindas da tela do Discord (ja juntadas em lotes). */
export function log(_: IpcMainInvokeEvent, lines: string[]) {
    if (Array.isArray(lines)) for (const l of lines.slice(0, 500)) logLine(String(l).slice(0, 2000));
}

function writeProbe(name: string, data: string) {
    try {
        const { mkdirSync, writeFileSync } = require("fs") as typeof import("fs");
        mkdirSync(PROBE_DIR, { recursive: true });
        writeFileSync(join(PROBE_DIR, name), data, "utf8");
        return "ok";
    } catch (e) {
        return "erro: " + String(e);
    }
}

export function saveProbe(_: IpcMainInvokeEvent, name: string, data: string) {
    return writeProbe(name, data);
}

export function takeFlag(_: IpcMainInvokeEvent, name: string) {
    const f = join(PROBE_DIR, name + ".flag");
    if (!existsSync(f)) return false;
    try { unlinkSync(f); } catch { }
    return true;
}

export async function watchBase(_: IpcMainInvokeEvent) {
    await ensureServer();
    return `http://127.0.0.1:${port}/watch`;
}

/** Pede um quadro-chave ao codificador (um espectador entrou ou perdeu dados). */
export function keyFrame(_: IpcMainInvokeEvent) {
    try { helper?.stdin?.write("K"); } catch { }
}

export function localToken(_: IpcMainInvokeEvent) {
    return pageToken;
}

// Atualizacao automatica (so na versao instalada): baixa a versao nova para "pending";
// o carregador troca os arquivos na proxima vez que o Discord abrir.
const REPO = "pdhenklein/pdlink";
const PENDING_DIR = join(PKG_DIR, "..", "pending");
let update = { current: "", ready: "", error: "" };

function readVersion(dir: string) {
    try { return readFileSync(join(dir, "version.txt"), "utf8").trim(); } catch { return ""; }
}

function newer(a: string, b: string) {
    const pa = a.replace(/^v/, "").split(".").map(Number), pb = b.replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
}

// Pergunta ao GitHub qual e a versao mais nova SEM usar a API (ela limita a 60 consultas por hora): o endereco
// "releases/latest" so redireciona para a tag mais nova, e os downloads diretos tambem nao entram nesse limite.
async function latestVersion() {
    const r = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "manual", headers: { "User-Agent": "pdLink" } });
    const m = /\/releases\/tag\/v?([0-9][^/?#]*)/.exec(r.headers.get("location") || "");
    if (!m) throw new Error("nao achei a versao mais nova (GitHub respondeu " + r.status + ")");
    return m[1];
}

const UPDATE_FILES = ["patcher.js", "preload.js", "renderer.js", "renderer.css", "golive-helper.exe", "viewer.html", "viewer-hw.js"];
const UPDATE_REQUIRED = ["patcher.js", "preload.js", "renderer.js", "golive-helper.exe", "viewer.html"];
let updating = false, failedVer = "", failedAt = 0;

async function checkUpdate() {
    if (!PACKAGED || updating) return;
    updating = true;
    const fs = require("original-fs") as typeof import("fs");
    try {
        update.current = readVersion(PKG_DIR);
        const ver = await latestVersion();
        if (!newer(ver, update.current)) return;
        if (readVersion(PENDING_DIR) === ver) { update.ready = ver; return; }
        if (failedVer === ver && Date.now() - failedAt < 60_000) return;

        const tmp = PENDING_DIR + ".tmp";
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.mkdirSync(tmp, { recursive: true });
        for (const name of UPDATE_FILES) {
            const r = await fetch(`https://github.com/${REPO}/releases/download/v${ver}/${name}`, { headers: { "User-Agent": "pdLink" } });
            if (!r.ok) {
                if (UPDATE_REQUIRED.includes(name)) throw new Error(`falha ao baixar ${name}: ${r.status}`);
                continue;
            }
            fs.writeFileSync(join(tmp, name), Buffer.from(await r.arrayBuffer()));
        }
        for (const f of UPDATE_REQUIRED)
            if (!fs.existsSync(join(tmp, f))) throw new Error("versao nova incompleta, falta " + f);
        // version.txt por ultimo: e ele que diz ao carregador que a pasta esta completa
        fs.writeFileSync(join(tmp, "version.txt"), ver);
        fs.rmSync(PENDING_DIR, { recursive: true, force: true });
        fs.renameSync(tmp, PENDING_DIR);
        update.ready = ver;
        update.error = "";
        logLine(`atualizacao: ${ver} baixada, pronta para instalar`);
    } catch (e) {
        update.error = String(e);
        logLine("atualizacao: falhou - " + String(e));
        try { failedVer = await latestVersion(); } catch { }
        failedAt = Date.now();
    } finally {
        updating = false;
    }
}

// a cada 1 minuto (e logo ao abrir): a faixa "Atualizar" aparece poucos segundos depois de uma versao sair no GitHub
if (PACKAGED) {
    setTimeout(checkUpdate, 5_000);
    setInterval(checkUpdate, 60_000);
}

export function updateStatus(_: IpcMainInvokeEvent) {
    if (PACKAGED) {
        update.current = readVersion(PKG_DIR);
        update.ready = update.ready || (newer(readVersion(PENDING_DIR), update.current) ? readVersion(PENDING_DIR) : "");
    }
    return update;
}

/**
 * Botao "Atualizar": fecha o Discord e abre de novo. A versao ja baixada em "pending" e instalada pelo carregador na abertura.
 * Devolve "ok" ou o motivo de nao ter feito nada.
 */
export function updateRestart(_: IpcMainInvokeEvent) {
    if (!PACKAGED) return "so na versao instalada";
    const ready = readVersion(PENDING_DIR);
    if (!ready || !newer(ready, readVersion(PKG_DIR))) return "nao ha atualizacao baixada";
    if (!relaunchAfterExit(discordUpdateExe(), 5)) return "nao achei o Discord para reabrir";
    // da um instante para a resposta voltar a tela e fecha de vez (nao so minimiza para a bandeja)
    setTimeout(() => {
        app.quit(); // fecha com a limpeza normal (para o auxiliar, fecha arquivos)...
        setTimeout(() => app.exit(0), 2500); // ...e garante que fechou mesmo se o Discord so tentar ir para a bandeja
    }, 400);
    return "ok";
}
