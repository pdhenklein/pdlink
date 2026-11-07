// Faixa "pdLink X esta pronto / Atualizar" desenhada pelo proprio mod, por cima do Discord.
// Nao usa a fila de avisos do Vencord: la, um aviso que o Discord apagou sem avisar deixa todos os seguintes presos e invisiveis.

const ID = "pdlink-update-banner";
let timer: ReturnType<typeof setTimeout> | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text = "") {
    const e = document.createElement(tag);
    e.style.cssText = css;
    e.textContent = text;
    return e;
}

export function hideUpdateBanner() {
    clearTimeout(timer);
    document.getElementById(ID)?.remove();
}

export function showUpdateBanner(version: string, inCall: boolean, restart: () => Promise<string>) {
    hideUpdateBanner();
    const bar = el("div", "position:fixed;top:0;left:0;right:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 16px;background:#5865f2;color:#fff;font:600 14px/1.3 gg sans,Segoe UI,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4);");
    bar.id = ID;
    const text = el("span", "");
    const btn = (label: string, css: string) => el("button", "border:0;border-radius:4px;padding:4px 14px;font:inherit;cursor:pointer;" + css, label);
    const main = btn("Atualizar", "background:#fff;color:#5865f2;");
    const cancel = btn("Cancelar", "background:rgba(255,255,255,.2);color:#fff;display:none;");
    const close = btn("x", "background:transparent;color:#fff;padding:4px 8px;");
    bar.append(text, main, cancel, close);

    const idle = () => { text.textContent = `pdLink ${version} esta pronto.`; main.style.display = ""; cancel.style.display = "none"; close.style.display = ""; };
    const tick = (left: number) => {
        if (left <= 0) {
            text.textContent = "Discord fechando...";
            cancel.style.display = "none";
            restart().then(r => { if (r !== "ok") fail(String(r)); }).catch(e => fail(String(e)));
            return;
        }
        text.textContent = `Atualizando o pdLink para ${version} em ${left}... Ele abre sozinho.${inCall ? " Discord fechando..." : ""}`;
        timer = setTimeout(() => tick(left - 1), 1000);
    };
    const fail = (why: string) => {
        text.textContent = `Nao consegui atualizar agora (${why}). Feche e abra o Discord para instalar o pdLink ${version}.`;
        cancel.style.display = "none";
        close.style.display = "";
    };

    main.onclick = () => { main.style.display = "none"; close.style.display = "none"; cancel.style.display = ""; tick(3); };
    cancel.onclick = () => { clearTimeout(timer); idle(); };
    close.onclick = hideUpdateBanner;
    idle();
    document.body.appendChild(bar);
}
