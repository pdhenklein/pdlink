// Carregador do pdLink dentro do Discord.
// 1. Se uma atualizacao foi baixada, coloca-a no lugar antes de carregar (nada muda com o Discord aberto).
// 2. Guarda as configuracoes numa pasta propria (nao mistura com outro Vencord).
// 3. Carrega o pdLink, que por sua vez carrega o Discord original (_app.asar).
const fs = require("original-fs");
const path = require("path");

const base = path.join(process.env.LOCALAPPDATA || "", "GoLiveP2P");
const app = path.join(base, "app");
const pending = path.join(base, "pending");

function log(msg) {
    try {
        fs.mkdirSync(path.join(base, "logs"), { recursive: true });
        fs.appendFileSync(path.join(base, "logs", "carregador.log"), `[${new Date().toISOString()}] ${msg}\n`);
    } catch { }
}

try {
    if (fs.existsSync(path.join(pending, "version.txt"))) {
        const old = app + ".old";
        fs.rmSync(old, { recursive: true, force: true });
        if (fs.existsSync(app)) fs.renameSync(app, old);
        fs.renameSync(pending, app);
        fs.rmSync(old, { recursive: true, force: true });
        log("atualizacao aplicada: " + fs.readFileSync(path.join(app, "version.txt"), "utf8").trim());
    }
} catch (e) {
    log("falha ao aplicar atualizacao: " + e);
    // se a troca falhou no meio, volta a versao anterior
    try {
        if (!fs.existsSync(path.join(app, "patcher.js")) && fs.existsSync(app + ".old")) fs.renameSync(app + ".old", app);
    } catch { }
}

process.env.VENCORD_USER_DATA_DIR = path.join(base, "data");

try {
    require(path.join(app, "patcher.js"));
} catch (e) {
    // pdLink quebrado ou removido: abre o Discord normal, sem nada
    log("falha ao carregar o pdLink, abrindo o Discord normal: " + e);
    const original = path.join(__dirname, "..", "_app.asar");
    const pkg = require(path.join(original, "package.json"));
    require.main.filename = path.join(original, pkg.main);
    require(require.main.filename);
}
