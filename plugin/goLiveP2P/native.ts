import { randomBytes } from "crypto";
import { execFile, spawn } from "child_process";
import { ConnectSrc, CspPolicies } from "@main/csp";
import { app, IpcMainInvokeEvent } from "electron";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "fs";
import { createServer, Server, ServerResponse } from "http";
import { tmpdir } from "os";
import { join } from "path";

import { overlayInfo, sendOverlay, startOverlay, stopOverlay } from "./overlay";

// Brokers MQTT publicos usados so para sinalizacao (textos de conexao e quem esta ao vivo); o video nunca passa por la
CspPolicies["wss://broker.emqx.io:8084"] = ConnectSrc;
CspPolicies["wss://broker.hivemq.com:8884"] = ConnectSrc;

// Instalado (pacote): o auxiliar e a pagina de assistir ficam ao lado deste arquivo (patcher.js).
// Desenvolvimento: usa as pastas do projeto.
const PKG_DIR = __dirname;
const PACKAGED = existsSync(join(PKG_DIR, "golive-helper.exe"));
const VIEWER_PAGE = PACKAGED ? join(PKG_DIR, "viewer.html") : "F:/Discord2/Vencord/src/userplugins/goLiveP2P/viewer.html";
const WATCH_PORT = 47615;
const HELPER = PACKAGED ? join(PKG_DIR, "golive-helper.exe") : "F:\\Discord2\\helper\\bin\\golive-helper-p8.exe";
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

export async function getSources(_: IpcMainInvokeEvent, q: SourcesQuery = {}) {
    if (!existsSync(HELPER)) throw new Error("Auxiliar nao encontrado em " + HELPER);
    const list = JSON.parse(await run(["list", "--json"]));
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
    const hidden = new Set(["discord.exe", "explorer.exe", "applicationframehost.exe", "systemsettings.exe", "textinputhost.exe", "golive-helper.exe", "golive-helper-p6.exe", "golive-helper-p7.exe", "golive-helper-p8.exe", "whatsapp.root.exe", "whatsapp.exe"]);
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
    proc.stderr!.on("data", (d: Buffer) => { lastError = d.toString("utf8").slice(-300); lastStat = d.toString("utf8"); });
    proc.on("exit", code => {
        if (helper === proc) helper = null;
        if (code) lastError = "auxiliar saiu com codigo " + code + ". " + lastError;
    });
    return { port, token };
}

export function stopStream(_: IpcMainInvokeEvent) {
    killHelper();
}

export function status(_: IpcMainInvokeEvent) {
    return { running: !!helper, lastError, lastStat, clients: clients.size };
}

// Marcacoes dos espectadores (ping e desenho) desenhadas por cima da janela transmitida
export function overlayStart(_: IpcMainInvokeEvent, src: { hwnd?: number; monitor?: number; }) {
    startOverlay(HELPER, src);
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

app.on("before-quit", () => {
    stopOverlay();
    killHelper();
    for (const c of clients) { try { c.end(); } catch { } }
    server?.close();
});

export function saveProbe(_: IpcMainInvokeEvent, name: string, data: string) {
    try {
        const { mkdirSync, writeFileSync } = require("fs") as typeof import("fs");
        mkdirSync(PROBE_DIR, { recursive: true });
        writeFileSync(join(PROBE_DIR, name), data, "utf8");
        return "ok";
    } catch (e) {
        return "erro: " + String(e);
    }
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
const REPO = "pdhenklein/golive-p2p";
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

async function checkUpdate() {
    if (!PACKAGED) return;
    const fs = require("original-fs") as typeof import("fs");
    try {
        update.current = readVersion(PKG_DIR);
        const known = readVersion(PENDING_DIR);
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { "User-Agent": "GoLiveP2P" } });
        if (!res.ok) throw new Error("GitHub respondeu " + res.status);
        const rel = await res.json() as { tag_name: string; assets: { name: string; browser_download_url: string; }[]; };
        const ver = rel.tag_name.replace(/^v/, "");
        if (!newer(ver, update.current)) return;
        if (known === ver) { update.ready = ver; return; }

        const tmp = PENDING_DIR + ".tmp";
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.mkdirSync(tmp, { recursive: true });
        for (const a of rel.assets) {
            // instalador e carregador nao fazem parte da pasta do plugin
            if (a.name === "version.txt" || a.name.endsWith(".asar") || a.name.endsWith(".exe") && a.name !== "golive-helper.exe") continue;
            const r = await fetch(a.browser_download_url, { headers: { "User-Agent": "GoLiveP2P" } });
            if (!r.ok) throw new Error(`falha ao baixar ${a.name}: ${r.status}`);
            fs.writeFileSync(join(tmp, a.name), Buffer.from(await r.arrayBuffer()));
        }
        for (const f of ["patcher.js", "preload.js", "renderer.js", "golive-helper.exe", "viewer.html"])
            if (!fs.existsSync(join(tmp, f))) throw new Error("versao nova incompleta, falta " + f);
        // version.txt por ultimo: e ele que diz ao carregador que a pasta esta completa
        fs.writeFileSync(join(tmp, "version.txt"), ver);
        fs.rmSync(PENDING_DIR, { recursive: true, force: true });
        fs.renameSync(tmp, PENDING_DIR);
        update.ready = ver;
        update.error = "";
    } catch (e) {
        update.error = String(e);
    }
}

if (PACKAGED) {
    setTimeout(checkUpdate, 15_000);
    setInterval(checkUpdate, 3 * 60 * 60_000);
}

export function updateStatus(_: IpcMainInvokeEvent) {
    return update;
}
