import { settings } from "./settings";

// O Discord toca audio e video mandados no chat sempre no volume maximo. O player dele pode nem estar na pagina
// (fica so na memoria) e volta o volume para 100% sozinho, entao aqui o controle e feito no proprio "tocar" e no
// "mudar volume" de todo audio/video. So vale para arquivos do Discord; a musica e as lives do pdLink nao passam aqui.
// Quando a pessoa mexe na barrinha de volume do player, fica o volume que ela escolheu.
const userSet = new WeakSet<HTMLMediaElement>();
const DISCORD_CDN = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\//i;
const proto = HTMLMediaElement.prototype;
const volDesc = Object.getOwnPropertyDescriptor(proto, "volume")!;
const origPlay = proto.play;
let lastSlider = 0;

const fromChat = (el: HTMLMediaElement) => DISCORD_CDN.test(el.currentSrc || el.src || el.querySelector("source")?.src || "");
const target = () => Math.max(0, Math.min(1, Number(settings.store.chatVolume ?? 30) / 100));
const active = (el: HTMLMediaElement) => target() < 1 && !userSet.has(el) && fromChat(el);

function onInput(e: Event) {
    const t = e.target as Element | null;
    if (t?.closest?.('[role="slider"], [class*="volume" i], [aria-label*="volume" i], [aria-label*="volume"]')) lastSlider = Date.now();
}

let on = false;
export function startChatVolume() {
    if (on) return;
    on = true;
    Object.defineProperty(proto, "volume", {
        ...volDesc,
        set(this: HTMLMediaElement, v: number) {
            if (on && active(this)) {
                if (Date.now() - lastSlider < 1500) userSet.add(this);
                else v = Math.min(v, target());
            }
            volDesc.set!.call(this, v);
        }
    });
    proto.play = function (this: HTMLMediaElement) {
        if (on && active(this) && volDesc.get!.call(this) > target()) volDesc.set!.call(this, target());
        return origPlay.call(this);
    };
    for (const t of ["pointerdown", "wheel", "keydown"]) document.addEventListener(t, onInput, true);
}

export function stopChatVolume() {
    if (!on) return;
    on = false;
    Object.defineProperty(proto, "volume", volDesc);
    proto.play = origPlay;
    for (const t of ["pointerdown", "wheel", "keydown"]) document.removeEventListener(t, onInput, true);
}
