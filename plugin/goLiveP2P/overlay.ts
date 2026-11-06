import { BrowserWindow, screen } from "electron";
import { ChildProcess, spawn } from "child_process";

import { makeBoard } from "./marksCore";

// Janela transparente que fica por cima da janela (ou tela) transmitida e desenha o que os espectadores marcam.
// - nao pega cliques e nao rouba o foco (o jogo continua funcionando normalmente);
// - fica fora da captura (SetWindowDisplayAffinity), entao a marcacao nao entra na imagem da live;
// - a posicao vem do auxiliar ("rect"), que avisa sempre que a janela transmitida se mexe.

let win: BrowserWindow | null = null;
let tracker: ChildProcess | null = null;
let ready = false;
let queue: string[] = [];
let lastRect: { x: number; y: number; w: number; h: number; } | null = null;
let helperPath = "";

function page() {
    return `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
<canvas id="c" style="position:fixed;left:0;top:0;width:100%;height:100%"></canvas>
<script>
var __name = function (f) { return f; };
var makeBoard = ${makeBoard.toString()};
var board = makeBoard();
var cv = document.getElementById("c"), ctx = cv.getContext("2d"), raf = 0;
function redraw() {
  var busy = board.draw(ctx, cv.width, cv.height, performance.now(), { x: 0, y: 0, w: cv.width, h: cv.height });
  if (busy && !raf) raf = requestAnimationFrame(function () { raf = 0; redraw(); });
}
function fit() {
  var d = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(innerWidth * d));
  cv.height = Math.max(1, Math.round(innerHeight * d));
  redraw();
}
window.__m = function (m) {
  var s = board.sanitize(m);
  if (!s) return;
  s.from = String(m.from || "").slice(0, 32);
  s.n = String(m.n || "").slice(0, 32);
  board.apply(s, performance.now());
  redraw();
};
addEventListener("resize", fit);
fit();
</script></body></html>`;
}

function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    ready = false;
    win = new BrowserWindow({
        show: false, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false,
        focusable: false, skipTaskbar: true, fullscreenable: false, type: "toolbar", title: "GoLive P2P marcacoes",
        width: 400, height: 300,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    });
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(true);
    win.setAlwaysOnTop(true, "screen-saver");
    win.webContents.once("did-finish-load", () => {
        ready = true;
        for (const js of queue) win?.webContents.executeJavaScript(js).catch(() => { });
        queue = [];
    });
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(page()));
    win.on("closed", () => { win = null; ready = false; });
    return win;
}

function place(r: { x: number; y: number; w: number; h: number; }) {
    const w = ensureWindow();
    // o auxiliar fala em pixels fisicos; o Electron usa unidades logicas (DIP)
    const dip = screen.screenToDipRect(null, { x: r.x, y: r.y, width: r.w, height: r.h });
    w.setBounds(dip);
    w.setBounds(dip); // 2x: entre monitores com escalas diferentes a primeira chamada pode errar o tamanho
    if (!w.isVisible()) w.showInactive();
    // o Windows so aplica "fora da captura" depois que a janela aparece; reafirma aqui (verificado: 0x11 = WDA_EXCLUDEFROMCAPTURE)
    w.setContentProtection(true);
    w.setAlwaysOnTop(true, "screen-saver");
}

function onLine(line: string) {
    let o: any;
    try { o = JSON.parse(line); } catch { return; }
    if (o.gone) { lastRect = null; win?.hide(); return; }
    if (o.hidden) { lastRect = null; win?.hide(); return; }
    if (typeof o.w === "number" && o.w > 0 && o.h > 0) {
        lastRect = o;
        place(o);
    }
}

export function startOverlay(helper: string, src: { hwnd?: number; monitor?: number; }) {
    stopOverlay();
    helperPath = helper;
    const args = ["rect"];
    if (src.hwnd != null) args.push("--hwnd", String(src.hwnd));
    else args.push("--monitor", String(src.monitor ?? 0));
    const p = spawn(helperPath, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    tracker = p;
    let buf = "";
    p.stdout!.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (tracker === p) onLine(line);
        }
    });
    p.on("exit", () => { if (tracker === p) tracker = null; });
}

export function sendOverlay(m: object) {
    const js = "window.__m(" + JSON.stringify(m) + ")";
    if (!win || win.isDestroyed()) ensureWindow();
    if (ready) win!.webContents.executeJavaScript(js).catch(() => { });
    else queue.push(js);
}

export function stopOverlay() {
    if (tracker) {
        try { tracker.stdin?.end(); } catch { }
        try { tracker.kill(); } catch { }
        tracker = null;
    }
    lastRect = null;
    queue = [];
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    ready = false;
}

export function overlayInfo() {
    return {
        tracking: !!tracker,
        visible: !!win && !win.isDestroyed() && win.isVisible(),
        bounds: win && !win.isDestroyed() ? win.getBounds() : null,
        rect: lastRect
    };
}
