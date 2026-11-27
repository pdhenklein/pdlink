import { PluginNative } from "@utils/types";
import { useEffect, useState } from "@webpack/common";

import { showUpdateBanner } from "./updateBanner";

const Native = VencordNative.pluginHelpers.pdLink as PluginNative<typeof import("./native")>;

// Linha da tela de plugins: qual versao do pdLink esta instalada (e se ja ha uma baixada esperando o Discord abrir de novo)
export function VersionInfo() {
    const [u, setU] = useState<{ current: string; ready: string; } | null>(null);
    useEffect(() => { Native.updateStatus().then(setU).catch(() => setU({ current: "", ready: "" })); }, []);
    if (!u) return <span>Versao: ...</span>;
    return (
        <div>
            <div>Versao instalada: <b>{u.current || "de desenvolvimento"}</b></div>
            {u.current && u.ready && u.ready !== u.current && <div>Versao {u.ready} ja baixada: vale quando voce fechar e abrir o Discord.</div>}
            {/* so na build de desenvolvimento: mostra o aviso de atualizacao de verdade, mas o Atualizar nao reinicia nada */}
            {!u.current && (
                <button
                    onClick={() => showUpdateBanner("teste", false, async () => "isto e so um teste da build de desenvolvimento, nada foi instalado")}
                    style={{ marginTop: 6, padding: "4px 10px", borderRadius: 4, cursor: "pointer", background: "var(--brand-500, #5865f2)", color: "#fff", border: 0, fontWeight: 600 }}
                >
                    Ver o aviso de atualizacao (teste)
                </button>
            )}
        </div>
    );
}
