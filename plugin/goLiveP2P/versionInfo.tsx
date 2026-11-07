import { PluginNative } from "@utils/types";
import { useEffect, useState } from "@webpack/common";

const Native = VencordNative.pluginHelpers.pdLink as PluginNative<typeof import("./native")>;

// Linha da tela de plugins: qual versao do pdLink esta instalada (e se ja ha uma baixada esperando o Discord abrir de novo)
export function VersionInfo() {
    const [u, setU] = useState<{ current: string; ready: string; } | null>(null);
    useEffect(() => { Native.updateStatus().then(setU).catch(() => setU({ current: "", ready: "" })); }, []);
    if (!u) return <span>Versao: ...</span>;
    return (
        <div>
            <div>Versao instalada: <b>{u.current || "de desenvolvimento"}</b></div>
            {u.ready && u.ready !== u.current && <div>Versao {u.ready} ja baixada: vale quando voce fechar e abrir o Discord.</div>}
        </div>
    );
}
