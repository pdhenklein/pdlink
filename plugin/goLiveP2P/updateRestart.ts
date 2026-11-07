import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

// Reabre o Discord depois que ele fechar (o carregador instala a atualizacao baixada na abertura).
// O comando roda separado do Discord: espera alguns segundos (tempo de o Discord fechar por completo) e abre pelo Update.exe,
// o mesmo jeito que o instalador usa.

export function discordUpdateExe(localAppData = process.env.LOCALAPPDATA ?? "") {
    return join(localAppData, "Discord", "Update.exe");
}

export function relaunchAfterExit(updateExe: string, waitSeconds = 5): boolean {
    if (!existsSync(updateExe)) return false;
    // "ping -n N" espera N-1 segundos sem depender de nada instalado
    const wait = Math.max(2, Math.round(waitSeconds) + 1);
    const cmd = `ping -n ${wait} 127.0.0.1 >nul & "${updateExe}" --processStart Discord.exe`;
    const p = spawn("cmd.exe", ["/d", "/s", "/c", `"${cmd}"`], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true });
    p.unref();
    return true;
}
