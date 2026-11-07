// Botao pequeno "pdLink X.Y.Z" na barra de cima do Discord: quadradinho azul com a setinha de baixar.
// Desenhado pelo proprio mod (nao usa a fila de avisos do Vencord, que podia deixar o aviso preso e invisivel).
// Clique: a setinha vira 3, 2, 1, o Discord fecha, atualiza e abre sozinho. Clicar durante a contagem cancela.

const ID = "pdlink-update-btn";
const ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><path d="M7 11l5 5l5-5"/><path d="M12 4v12"/></svg>';
let timer: ReturnType<typeof setTimeout> | undefined;
let place: ReturnType<typeof setInterval> | undefined;
let watcher: MutationObserver | undefined;
let onResize: (() => void) | undefined;

export function hideUpdateBanner() {
    clearTimeout(timer);
    clearInterval(place);
    watcher?.disconnect();
    if (onResize) removeEventListener("resize", onResize);
    onResize = undefined;
    document.getElementById(ID)?.remove();
}

// Ao lado esquerdo dos icones da barra de cima (caixa de entrada, ajuda...). Os nomes de classe do Discord mudam, entao acho os
// icones pela posicao: da direita para a esquerda, pego o grupo de botoes colado na borda da janela (os controles de janela do
// Windows nao sao da pagina e nao contam). Sem nada achado: encaixa a 158 px da borda, onde esse grupo costuma ficar.
function position(btn: HTMLElement): Element | null {
    const Y = 18;
    let left = innerWidth - 158 + 10, mid = Y, parent: Element | null = null;
    let x = innerWidth - 2, gap = 0, found = false;
    while (x > innerWidth - 420 && gap < 36) {
        const hit = document.elementsFromPoint(x, Y).find(e => e !== btn && !btn.contains(e) && e.closest('button,[role="button"],[tabindex],svg'));
        const t = hit?.closest('button,[role="button"],[tabindex]') ?? hit?.closest("svg");
        const r = t?.getBoundingClientRect();
        if (r && r.width > 0 && r.width < 80 && r.height < 60 && r.top < 50) {
            found = true; gap = 0; left = r.left; mid = r.top + r.height / 2; x = r.left - 2; parent = t!.parentElement;
        } else { x -= 8; if (found) gap += 8; }
    }
    btn.style.right = Math.max(8, innerWidth - left + 10) + "px";
    btn.style.top = Math.round(mid - 12) + "px";
    return parent;
}

export function showUpdateBanner(version: string, _inCall: boolean, restart: () => Promise<string>) {
    hideUpdateBanner();
    const btn = document.createElement("div");
    btn.id = ID;
    btn.style.cssText = "position:fixed;top:6px;z-index:2147483000;width:24px;height:24px;border-radius:6px;background:#5865f2;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;-webkit-app-region:no-drag;font:500 13px/1 gg sans,Segoe UI,sans-serif;";
    const tip = document.createElement("div");
    tip.style.cssText = "position:absolute;top:30px;right:0;background:#111214;color:#dbdee1;font:500 12px/1.3 gg sans,Segoe UI,sans-serif;padding:5px 9px;border-radius:5px;white-space:nowrap;display:none;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.4);";
    const face = document.createElement("span");
    face.style.cssText = "display:flex;align-items:center;justify-content:center;pointer-events:none;";
    btn.append(face, tip);

    const idle = () => { face.innerHTML = ICON; tip.textContent = `pdLink ${version}`; btn.style.background = "#5865f2"; };
    let counting = false;
    const fail = (why: string) => {
        counting = false;
        face.textContent = "!";
        btn.style.background = "#da373c";
        tip.textContent = `Nao consegui atualizar (${why}). Feche e abra o Discord para instalar o pdLink ${version}.`;
        tip.style.whiteSpace = "normal";
        tip.style.width = "260px";
    };
    const tick = (left: number) => {
        if (left <= 0) {
            face.textContent = "...";
            restart().then(r => { if (r !== "ok") fail(String(r)); }).catch(e => fail(String(e)));
            return;
        }
        face.textContent = String(left);
        timer = setTimeout(() => tick(left - 1), 1000);
    };

    btn.onclick = () => {
        if (counting) { counting = false; clearTimeout(timer); idle(); return; }
        counting = true;
        tip.style.display = "none";
        tick(3);
    };
    btn.oncontextmenu = e => { e.preventDefault(); if (!counting) hideUpdateBanner(); };
    btn.onmouseenter = () => { tip.style.display = "block"; };
    btn.onmouseleave = () => { tip.style.display = "none"; };

    idle();
    document.body.appendChild(btn);

    // Procurar os icones custa uns milissegundos, entao so se refaz quando algo muda: a janela mudou de tamanho, ou entrou/saiu
    // um botao no grupo de icones (ex.: o botao de atualizar do proprio Discord). E, por garantia, de vez em quando (5 s, so com a janela visivel).
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let observed: Element | null = null;
    const update = () => {
        if (document.hidden) return;
        const parent = position(btn);
        if (parent !== observed) {
            watcher?.disconnect();
            observed = parent;
            if (parent) watcher?.observe(parent, { childList: true });
        }
    };
    const soon = () => { clearTimeout(debounce); debounce = setTimeout(update, 120); };
    watcher = new MutationObserver(soon);
    onResize = soon;
    addEventListener("resize", soon);
    update();
    place = setInterval(update, 5000);
}
