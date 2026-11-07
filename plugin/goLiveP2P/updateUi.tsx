import { useEffect, useState } from "@webpack/common";

/** Contagem de 3 s depois de clicar em Atualizar. Fechar a faixa (Cancelar) para a contagem: o temporizador morre com o componente. */
export function UpdateCountdown({ version, inCall, restart }: { version: string; inCall: boolean; restart: () => Promise<string>; }) {
    const [left, setLeft] = useState(3);
    const [failed, setFailed] = useState("");
    useEffect(() => {
        if (left <= 0) {
            restart().then(r => { if (r !== "ok") setFailed(String(r)); }).catch(e => setFailed(String(e)));
            return;
        }
        const t = setTimeout(() => setLeft(n => n - 1), 1000);
        return () => clearTimeout(t);
    }, [left]);
    if (failed) return <span>Nao consegui atualizar agora ({failed}). Feche e abra o Discord para instalar o pdLink {version}.</span>;
    return <span>{left > 0 ? `Atualizando o pdLink para ${version} em ${left}...` : "Fechando o Discord..."} Ele abre sozinho.{inCall ? " Discord fechando..." : ""}</span>;
}
