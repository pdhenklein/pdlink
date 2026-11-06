import { app, BrowserWindow, dialog, shell } from "electron";
import { closeSync, openSync, unlinkSync, writeSync } from "fs";
import { join } from "path";

// Lado nativo do recebimento de arquivos: janela "Salvar como" do Windows e gravacao em disco.
// So grava em caminhos que a propria pessoa escolheu na janela de salvar.

const allowed = new Set<string>();
const open = new Map<number, string>();

export async function saveDialog(name: string): Promise<string | null> {
    const safe = name.replace(/[\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200) || "arquivo";
    const opts = { title: "Salvar arquivo", defaultPath: join(app.getPath("downloads"), safe) };
    const win = BrowserWindow.getFocusedWindow();
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    allowed.add(r.filePath);
    return r.filePath;
}

export function openFile(path: string): number {
    if (!allowed.has(path)) throw new Error("caminho nao escolhido pelo usuario");
    const fd = openSync(path, "w");
    open.set(fd, path);
    return fd;
}

export function writeFile(fd: number, data: Uint8Array) {
    if (!open.has(fd)) throw new Error("arquivo nao esta aberto");
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
}

/** ok = false apaga o arquivo incompleto. */
export function closeFile(fd: number, ok: boolean) {
    const path = open.get(fd);
    if (path == null) return;
    open.delete(fd);
    try { closeSync(fd); } catch { }
    if (!ok) { try { unlinkSync(path); } catch { } }
}

export function reveal(path: string) {
    if (allowed.has(path)) shell.showItemInFolder(path);
}

export function closeAll() {
    for (const fd of [...open.keys()]) closeFile(fd, false);
}
