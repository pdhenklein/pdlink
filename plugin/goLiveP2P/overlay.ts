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
// Fora da captura (SetWindowDisplayAffinity) so quando precisa: transmitindo a TELA INTEIRA, a janela entraria na imagem da live
// e as marcacoes apareceriam em dobro. Transmitindo uma JANELA, a captura pega so aquela janela, entao a nossa pode
// aparecer normalmente em prints (Ferramenta de Recorte, Lightshot) e gravacoes (ShadowPlay).
let protect = false;
let isTemp = false; // janela criada so para mostrar um aviso (sem live): fecha sozinha
let tempTimer: any = null;

function page() {
    return `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
<style>
#toast { position: fixed; top: 24px; right: 24px; max-width: 380px; padding: 12px 16px; border-radius: 12px; background: rgba(24,25,28,.96);
  color: #fff; font: 600 15px/1.35 "Segoe UI", sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.5); opacity: 0; transform: translateY(-12px);
  transition: opacity .3s, transform .3s; border-left: 4px solid #5865f2; }
#toast.show { opacity: 1; transform: none; }
#toast .tt { font-size: 13px; color: #b5bac1; font-weight: 600; margin-bottom: 2px; }
#toast .tx { word-break: break-word; }
</style>
<canvas id="c" style="position:fixed;left:0;top:0;width:100%;height:100%"></canvas>
<div id="toast"><div class="tt"></div><div class="tx"></div></div>
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
var toastEl = document.getElementById("toast"), toastTimer = 0;
window.__t = function (t) {
  toastEl.querySelector(".tt").textContent = String(t.title || "").slice(0, 80);
  toastEl.querySelector(".tx").textContent = String(t.text || "").slice(0, 200);
  toastEl.className = "show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.className = ""; }, Math.min(15000, Math.max(2000, Number(t.ms) || 7000)));
};
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
        focusable: false, skipTaskbar: true, fullscreenable: false, type: "toolbar", title: "pdLink marcacoes",
        width: 400, height: 300,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    });
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(protect);
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
    w.setContentProtection(protect);
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

export function startOverlay(helper: string, src: { hwnd?: number; monitor?: number; }, temporary = false, excludeFromCapture = false) {
    stopOverlay();
    isTemp = temporary;
    protect = excludeFromCapture;
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

/** Aviso por cima do jogo. Sem live ativa, abre a janela transparente so durante o aviso. */
export function showToast(helper: string, title: string, text: string, ms = 7000) {
    if (!tracker) startOverlay(helper, { monitor: 0 }, true);
    const js = "window.__t(" + JSON.stringify({ title, text, ms }) + ")";
    if (!win || win.isDestroyed()) ensureWindow();
    if (ready) win!.webContents.executeJavaScript(js).catch(() => { });
    else queue.push(js);
    if (isTemp) {
        clearTimeout(tempTimer);
        tempTimer = setTimeout(() => { if (isTemp) stopOverlay(); }, ms + 1500);
    }
}

export function stopOverlay() {
    isTemp = false;
    clearTimeout(tempTimer);
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
