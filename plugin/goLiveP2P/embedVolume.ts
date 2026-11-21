import { RendererSettings } from "@main/settings";
import { app, WebFrameMain, webFrameMain } from "electron";

// A previa do Spotify num link do chat roda num quadro do proprio Spotify (fora da pagina do Discord) e toca no maximo.
// O processo principal do Discord consegue entrar nesse quadro: ali o volume fica preso no escolhido nas opcoes do pdLink.
const frames: { processId: number; routingId: number; }[] = [];
const EMBED = /^https:\/\/open\.spotify\.com\/embed\//;

const volume = () => {
    const v = Number(RendererSettings.store.plugins?.pdLink?.chatVolume ?? 30);
    return Math.max(0, Math.min(1, (Number.isFinite(v) ? v : 30) / 100));
};

const script = (v: number) => `(() => {
    globalThis.__pdlVol = ${v};
    const P = HTMLMediaElement.prototype, d = Object.getOwnPropertyDescriptor(P, "volume");
    if (!globalThis.__pdlVolOn) {
        globalThis.__pdlVolOn = true;
        const play = P.play;
        Object.defineProperty(P, "volume", { ...d, set(x) { d.set.call(this, Math.min(x, globalThis.__pdlVol)); } });
        P.play = function () { d.set.call(this, globalThis.__pdlVol); return play.apply(this, arguments); };
    }
    for (const el of document.querySelectorAll("audio,video")) d.set.call(el, globalThis.__pdlVol);
})()`;

function liveFrames() {
    const out: WebFrameMain[] = [];
    for (let i = frames.length - 1; i >= 0; i--) {
        const f = webFrameMain.fromId(frames[i].processId, frames[i].routingId);
        if (f) out.push(f); else frames.splice(i, 1);
    }
    return out;
}

app.on("browser-window-created", (_, win) => {
    win.webContents.on("frame-created", (_e, { frame }) => {
        frame?.once("dom-ready", () => {
            if (!EMBED.test(frame.url)) return;
            liveFrames();
            frames.push({ processId: frame.processId, routingId: frame.routingId });
            if (volume() < 1) frame.executeJavaScript(script(volume())).catch(() => { });
        });
    });
});

RendererSettings.addChangeListener("plugins.pdLink.chatVolume", () => {
    for (const f of liveFrames()) f.executeJavaScript(script(volume())).catch(() => { });
});
