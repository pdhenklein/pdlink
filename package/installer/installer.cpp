// Instalador do GoLive P2P: coloca so este plugin no Discord e nada mais.
// Sim = instala/atualiza, Nao = remove tudo e devolve o Discord original.
#include <windows.h>
#include <tlhelp32.h>
#include <urlmon.h>
#include <shlobj.h>
#include <string>
#include <vector>

static const wchar_t* TITLE = L"GoLive P2P";
static const wchar_t* BASE_URL = L"https://github.com/pdhenklein/golive-p2p/releases/latest/download/";
static const wchar_t* FILES[] = { L"patcher.js", L"preload.js", L"renderer.js", L"renderer.css", L"viewer.html",
                                  L"viewer-hw.js", L"golive-helper.exe", L"golive-shim.asar", L"version.txt" };

static std::wstring env(const wchar_t* name) {
    wchar_t buf[MAX_PATH * 2];
    DWORD n = GetEnvironmentVariableW(name, buf, MAX_PATH * 2);
    return n ? std::wstring(buf, n) : L"";
}
static bool exists(const std::wstring& p) { return GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES; }
static bool quiet = false; // /silencioso: sem janelas, responde sim a tudo (para testes)
static int ask(const std::wstring& msg, UINT type) {
    if (quiet) return (type & 0xF) == MB_OK || (type & 0xF) == MB_OKCANCEL ? IDOK : IDYES;
    return MessageBoxW(nullptr, msg.c_str(), TITLE, type | MB_SETFOREGROUND);
}
static bool startsWithI(const std::wstring& s, const std::wstring& prefix) {
    return s.size() >= prefix.size() && !_wcsnicmp(s.c_str(), prefix.c_str(), prefix.size());
}

static void removeTree(const std::wstring& dir) {
    if (!exists(dir)) return;
    std::wstring from = dir + L'\0';
    SHFILEOPSTRUCTW op{};
    op.wFunc = FO_DELETE;
    op.pFrom = from.c_str();
    op.fFlags = FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT;
    SHFileOperationW(&op);
}

// so processos que rodam de dentro da pasta do Discord ou do GoLive P2P
static std::vector<DWORD> discordPids(const std::wstring& discord, const std::wstring& base) {
    std::vector<DWORD> out;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    PROCESSENTRY32W e{ sizeof(e) };
    for (BOOL ok = Process32FirstW(snap, &e); ok; ok = Process32NextW(snap, &e)) {
        if (_wcsicmp(e.szExeFile, L"Discord.exe") && _wcsicmp(e.szExeFile, L"golive-helper.exe")) continue;
        HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, e.th32ProcessID);
        if (!h) continue;
        wchar_t path[MAX_PATH * 2];
        DWORD n = MAX_PATH * 2;
        if (QueryFullProcessImageNameW(h, 0, path, &n) && (startsWithI(path, discord + L"\\") || startsWithI(path, base + L"\\")))
            out.push_back(e.th32ProcessID);
        CloseHandle(h);
    }
    CloseHandle(snap);
    return out;
}

// Fecha o Discord (pergunta antes, porque derruba a call)
static bool closeDiscord(const std::wstring& discord, const std::wstring& base) {
    auto pids = discordPids(discord, base);
    if (pids.empty()) return true;
    if (ask(L"O Discord precisa ser fechado para continuar.\n\nSe voce estiver numa call, saia dela antes.\n\nFechar o Discord agora?", MB_OKCANCEL | MB_ICONQUESTION) != IDOK)
        return false;
    for (DWORD pid : pids) {
        HANDLE h = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid);
        if (!h) continue;
        TerminateProcess(h, 0);
        WaitForSingleObject(h, 5000);
        CloseHandle(h);
    }
    Sleep(1000);
    return true;
}

// Pastas resources de todas as versoes instaladas do Discord (app-1.0.xxxx)
static std::vector<std::wstring> resourceDirs(const std::wstring& discord) {
    std::vector<std::wstring> out;
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW((discord + L"\\app-*").c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return out;
    do {
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            std::wstring r = discord + L"\\" + fd.cFileName + L"\\resources";
            if (exists(r + L"\\app.asar") || exists(r + L"\\_app.asar")) out.push_back(r);
        }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
    return out;
}

static void startDiscord(const std::wstring& discord) {
    std::wstring upd = discord + L"\\Update.exe";
    ShellExecuteW(nullptr, L"open", upd.c_str(), L"--processStart Discord.exe", discord.c_str(), SW_SHOWNORMAL);
}

static std::wstring exeDir() {
    wchar_t buf[MAX_PATH];
    GetModuleFileNameW(nullptr, buf, MAX_PATH);
    std::wstring s = buf;
    return s.substr(0, s.find_last_of(L'\\'));
}

// Baixa a versao mais nova do GitHub (ou copia da pasta do instalador, se os arquivos estiverem ao lado dele)
static bool fetchFiles(const std::wstring& dest, std::wstring& err) {
    std::wstring local = exeDir();
    bool useLocal = exists(local + L"\\patcher.js") && exists(local + L"\\golive-shim.asar");
    CreateDirectoryW(dest.c_str(), nullptr);
    std::wstring nocache = L"?t=" + std::to_wstring(GetTickCount64());
    for (auto f : FILES) {
        std::wstring to = dest + L"\\" + f;
        if (useLocal) {
            if (!CopyFileW((local + L"\\" + f).c_str(), to.c_str(), FALSE)) { err = std::wstring(L"nao achei ") + f; return false; }
        } else {
            std::wstring url = std::wstring(BASE_URL) + f + nocache;
            if (URLDownloadToFileW(nullptr, url.c_str(), to.c_str(), 0, nullptr) != S_OK) {
                err = std::wstring(L"falha ao baixar ") + f + L". Confira a internet e tente de novo.";
                return false;
            }
        }
    }
    return true;
}

static int install(const std::wstring& discord, const std::wstring& base) {
    std::wstring err, fresh = base + L"\\app.new";
    CreateDirectoryW(base.c_str(), nullptr);
    removeTree(fresh);
    if (!fetchFiles(fresh, err)) {
        removeTree(fresh);
        ask(L"Nao foi possivel instalar: " + err, MB_OK | MB_ICONERROR);
        return 1;
    }
    if (!closeDiscord(discord, base)) { removeTree(fresh); return 1; }

    // arquivos do plugin
    removeTree(base + L"\\app");
    removeTree(base + L"\\pending");
    std::wstring shim = base + L"\\golive-shim.asar";
    MoveFileExW((fresh + L"\\golive-shim.asar").c_str(), shim.c_str(), MOVEFILE_REPLACE_EXISTING);
    if (!MoveFileW(fresh.c_str(), (base + L"\\app").c_str())) {
        ask(L"Nao foi possivel copiar os arquivos (algum programa esta usando a pasta?).", MB_OK | MB_ICONERROR);
        return 1;
    }

    // carregador: o app.asar original vira _app.asar e o nosso entra no lugar
    auto dirs = resourceDirs(discord);
    int done = 0;
    for (auto& r : dirs) {
        std::wstring app = r + L"\\app.asar", orig = r + L"\\_app.asar";
        if (!exists(orig) && !MoveFileW(app.c_str(), orig.c_str())) continue;
        if (CopyFileW(shim.c_str(), app.c_str(), FALSE)) done++;
    }
    if (!done) {
        ask(L"Nao consegui modificar o Discord. Tente rodar o instalador de novo.", MB_OK | MB_ICONERROR);
        return 1;
    }
    startDiscord(discord);
    ask(L"Pronto! O GoLive P2P foi instalado e o Discord esta abrindo.\n\nPara fazer live, use o botao de transmitir de sempre na call.\nAs atualizacoes chegam sozinhas.", MB_OK | MB_ICONINFORMATION);
    return 0;
}

static int uninstall(const std::wstring& discord, const std::wstring& base) {
    if (!closeDiscord(discord, base)) return 1;
    for (auto& r : resourceDirs(discord)) {
        std::wstring app = r + L"\\app.asar", orig = r + L"\\_app.asar";
        if (!exists(orig)) continue;
        DeleteFileW(app.c_str());
        MoveFileW(orig.c_str(), app.c_str());
    }
    removeTree(base);
    startDiscord(discord);
    ask(L"O GoLive P2P foi removido. O Discord voltou ao normal.", MB_OK | MB_ICONINFORMATION);
    return 0;
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR cmd, int) {
    std::wstring local = env(L"LOCALAPPDATA");
    std::wstring discord = local + L"\\Discord", base = local + L"\\GoLiveP2P";
    if (resourceDirs(discord).empty()) {
        ask(L"Nao encontrei o Discord instalado neste PC.\nInstale o Discord pelo site discord.com e tente de novo.", MB_OK | MB_ICONERROR);
        return 1;
    }
    quiet = cmd && wcsstr(cmd, L"/silencioso");
    if (cmd && wcsstr(cmd, L"/remover")) return uninstall(discord, base);
    if (cmd && wcsstr(cmd, L"/instalar")) return install(discord, base);

    int r = ask(L"O que voce quer fazer?\n\nSim = instalar ou atualizar o GoLive P2P\nNao = remover o GoLive P2P do Discord", MB_YESNOCANCEL | MB_ICONQUESTION);
    if (r == IDYES) return install(discord, base);
    if (r == IDNO) return uninstall(discord, base);
    return 0;
}
