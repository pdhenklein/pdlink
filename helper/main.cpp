// golive-helper: prototype of the native capture helper (Phase 1).
// Commands:
//   list [--json]
//   capture (--hwnd N | --title TEXT | --monitor N) [--pid N] [--seconds S] [--fps F]
//           [--cursor follow|always|never] [--out DIR]
//   interactive
#define NOMINMAX
#include <windows.h>
#include <tlhelp32.h>
#include <unknwn.h>
#include <dwmapi.h>
#include <d3d11_4.h>
#include <dxgi.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mftransform.h>
#include <strmif.h>
#include <codecapi.h>
#include <mferror.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <functiondiscoverykeys_devpkey.h>
#include <audioclientactivationparams.h>
#include <shellapi.h>
#include <wincodec.h>
#include <io.h>
#include <fcntl.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <algorithm>
#include <map>
#include <set>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cwctype>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;
namespace wgc = winrt::Windows::Graphics::Capture;
namespace wdx = winrt::Windows::Graphics::DirectX;
namespace wd3d = winrt::Windows::Graphics::DirectX::Direct3D11;

struct __declspec(uuid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1")) IDirect3DDxgiInterfaceAccess : ::IUnknown {
    virtual HRESULT __stdcall GetInterface(GUID const& id, void** object) = 0;
};

// ---------------------------------------------------------------- utils

static std::string toUtf8(const std::wstring& w) {
    if (w.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
    return s;
}

static std::wstring fromUtf8(const char* s) {
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, nullptr, 0);
    std::wstring w(n > 0 ? n - 1 : 0, L'\0');
    if (n > 1) MultiByteToWideChar(CP_UTF8, 0, s, -1, w.data(), n);
    return w;
}

static void say(const char* fmt, ...) {
    char buf[2048];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    fputs(buf, stdout);
    fflush(stdout);
}

static std::string jsonEscape(const std::string& s) {
    std::string o;
    for (unsigned char c : s) {
        if (c == '"') o += "\\\"";
        else if (c == '\\') o += "\\\\";
        else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += (char)c;
    }
    return o;
}

static double nowSec() {
    using namespace std::chrono;
    return duration<double>(steady_clock::now().time_since_epoch()).count();
}

// ---------------------------------------------------------------- listing

struct WinInfo {
    HWND hwnd;
    DWORD pid;
    std::wstring exe, title;
    int w, h;
    bool minimized = false;
};

// janela que NAO entrou na lista e por que (so para diagnostico: "list --json --all")
struct SkippedWin {
    HWND hwnd;
    DWORD pid;
    std::wstring exe, title, why;
};

struct MonInfo {
    HMONITOR h;
    std::wstring name;
    RECT rc;
    bool primary;
};

static std::wstring exeNameOfPid(DWORD pid) {
    HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!p) return L"?";
    wchar_t buf[MAX_PATH * 2];
    DWORD n = (DWORD)std::size(buf);
    std::wstring r = L"?";
    if (QueryFullProcessImageNameW(p, 0, buf, &n)) {
        r.assign(buf, n);
        auto pos = r.find_last_of(L"\\/");
        if (pos != std::wstring::npos) r = r.substr(pos + 1);
    }
    CloseHandle(p);
    return r;
}

struct ListCtx {
    std::vector<WinInfo>* out;
    std::vector<SkippedWin>* skipped;
};

static bool coversAMonitor(const RECT& rc) {
    bool yes = false;
    struct Arg { const RECT* rc; bool* yes; } arg{ &rc, &yes };
    EnumDisplayMonitors(nullptr, nullptr, [](HMONITOR, HDC, LPRECT m, LPARAM lp) -> BOOL {
        auto* a = (Arg*)lp;
        const RECT& r = *a->rc;
        if (std::abs(r.left - m->left) <= 3 && std::abs(r.top - m->top) <= 3 && std::abs(r.right - m->right) <= 3 && std::abs(r.bottom - m->bottom) <= 3) *a->yes = true;
        return TRUE;
    }, (LPARAM)&arg);
    return yes;
}

// Janelas que dao para transmitir. Jogos em tela cheia ficam MINIMIZADOS quando a pessoa vai ao Discord escolher a janela
// (Alt+Tab), entao minimizadas tambem entram (a live comeca quando a janela voltar). Jogos sem titulo, em tela cheia, entram
// com o nome do programa.
static std::vector<WinInfo> listWindows(std::vector<SkippedWin>* skipped = nullptr) {
    std::vector<WinInfo> out;
    HWND self = GetConsoleWindow();
    ListCtx ctx{ &out, skipped };
    EnumWindows([](HWND h, LPARAM lp) -> BOOL {
        auto* c = (ListCtx*)lp;
        bool iconic = IsIconic(h) != 0;
        if (!IsWindowVisible(h) && !iconic) return TRUE;
        DWORD pid = 0;
        GetWindowThreadProcessId(h, &pid);
        wchar_t t[512];
        int len = GetWindowTextW(h, t, 512);
        auto skip = [&](const wchar_t* why) {
            if (c->skipped) c->skipped->push_back({ h, pid, exeNameOfPid(pid), std::wstring(t, std::max(0, len)), why });
            return TRUE;
        };
        if (GetWindow(h, GW_OWNER)) return skip(L"tem dono (janela filha)");
        LONG_PTR ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
        if ((ex & WS_EX_TOOLWINDOW) && !(ex & WS_EX_APPWINDOW)) return skip(L"janela de ferramenta");
        int cloaked = 0;
        DwmGetWindowAttribute(h, DWMWA_CLOAKED, &cloaked, sizeof cloaked);
        if (cloaked) return skip(L"oculta pelo Windows (outra area de trabalho virtual)");
        RECT rc{};
        if (iconic) {
            WINDOWPLACEMENT wp{ sizeof wp };
            if (GetWindowPlacement(h, &wp)) rc = wp.rcNormalPosition;
        } else GetWindowRect(h, &rc);
        int w = rc.right - rc.left, hh = rc.bottom - rc.top;
        std::wstring title(t, std::max(0, len));
        if (len <= 0) {
            // sem titulo: so entra se parecer um jogo em tela cheia
            if (!iconic && w >= 800 && hh >= 500 && coversAMonitor(rc)) title = exeNameOfPid(pid);
            else return skip(L"sem titulo");
        }
        if (w < 50 || hh < 50) return skip(L"muito pequena");
        WinInfo wi{ h, pid, exeNameOfPid(pid), title, w, hh };
        wi.minimized = iconic;
        c->out->push_back(wi);
        return TRUE;
    }, (LPARAM)&ctx);
    out.erase(std::remove_if(out.begin(), out.end(), [&](const WinInfo& w) { return w.hwnd == self; }), out.end());
    return out;
}

static std::vector<MonInfo> listMonitors() {
    std::vector<MonInfo> out;
    EnumDisplayMonitors(nullptr, nullptr, [](HMONITOR m, HDC, LPRECT, LPARAM lp) -> BOOL {
        MONITORINFOEXW mi{};
        mi.cbSize = sizeof mi;
        GetMonitorInfoW(m, &mi);
        ((std::vector<MonInfo>*)lp)->push_back({ m, mi.szDevice, mi.rcMonitor, (mi.dwFlags & MONITORINFOF_PRIMARY) != 0 });
        return TRUE;
    }, (LPARAM)&out);
    return out;
}

static void cmdList(bool json, bool all = false) {
    std::vector<SkippedWin> skipped;
    auto ws = listWindows(all ? &skipped : nullptr);
    auto ms = listMonitors();
    if (json) {
        std::string o = "{\"windows\":[";
        for (size_t i = 0; i < ws.size(); i++) {
            char b[128];
            snprintf(b, sizeof b, "%s{\"hwnd\":%llu,\"pid\":%lu,\"w\":%d,\"h\":%d,\"min\":%s,", i ? "," : "", (unsigned long long)(uintptr_t)ws[i].hwnd, ws[i].pid, ws[i].w, ws[i].h, ws[i].minimized ? "true" : "false");
            o += b;
            o += "\"exe\":\"" + jsonEscape(toUtf8(ws[i].exe)) + "\",\"title\":\"" + jsonEscape(toUtf8(ws[i].title)) + "\"}";
        }
        o += "],\"monitors\":[";
        for (size_t i = 0; i < ms.size(); i++) {
            char b[160];
            snprintf(b, sizeof b, "%s{\"index\":%zu,\"x\":%ld,\"y\":%ld,\"w\":%ld,\"h\":%ld,\"primary\":%s,", i ? "," : "", i, ms[i].rc.left, ms[i].rc.top, ms[i].rc.right - ms[i].rc.left, ms[i].rc.bottom - ms[i].rc.top, ms[i].primary ? "true" : "false");
            o += b;
            o += "\"name\":\"" + jsonEscape(toUtf8(ms[i].name)) + "\"}";
        }
        o += "]";
        if (all) {
            o += ",\"skipped\":[";
            for (size_t i = 0; i < skipped.size(); i++) {
                char b[96];
                snprintf(b, sizeof b, "%s{\"hwnd\":%llu,\"pid\":%lu,", i ? "," : "", (unsigned long long)(uintptr_t)skipped[i].hwnd, skipped[i].pid);
                o += b;
                o += "\"exe\":\"" + jsonEscape(toUtf8(skipped[i].exe)) + "\",\"title\":\"" + jsonEscape(toUtf8(skipped[i].title)) + "\",\"why\":\"" + jsonEscape(toUtf8(skipped[i].why)) + "\"}";
            }
            o += "]";
        }
        o += "}\n";
        fputs(o.c_str(), stdout);
        return;
    }
    say("JANELAS:\n");
    for (size_t i = 0; i < ws.size(); i++)
        say("  [%zu] %s (%s, pid %lu, %dx%d)\n", i + 1, toUtf8(ws[i].title).c_str(), toUtf8(ws[i].exe).c_str(), ws[i].pid, ws[i].w, ws[i].h);
    say("MONITORES:\n");
    for (size_t i = 0; i < ms.size(); i++)
        say("  [m%zu] %s %ldx%ld%s\n", i + 1, toUtf8(ms[i].name).c_str(), ms[i].rc.right - ms[i].rc.left, ms[i].rc.bottom - ms[i].rc.top, ms[i].primary ? " (principal)" : "");
}


// ---------------------------------------------------------------- diagnostico: quem esta tocando som agora
// "audio-sessions --root PID --json": lista os programas com som ativo, em qual saida de som, e se fazem parte do Discord
// (PID = programa principal do Discord). Serve para descobrir por que a voz do Discord vaza para uma live de tela inteira:
// programas de headset/teclado (Sonar, Nahimic, VoiceMeeter...) refazem o som do Discord e escapam da exclusao.

static DWORD windowsBuild() {
    typedef LONG(WINAPI* RtlGetVersionPtr)(PRTL_OSVERSIONINFOW);
    auto fn = (RtlGetVersionPtr)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
    RTL_OSVERSIONINFOW vi{};
    vi.dwOSVersionInfoSize = sizeof vi;
    if (fn && fn(&vi) == 0) return vi.dwBuildNumber;
    return 0;
}

static std::map<DWORD, DWORD> parentMap() {
    std::map<DWORD, DWORD> m;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return m;
    PROCESSENTRY32W pe{ sizeof pe };
    if (Process32FirstW(snap, &pe)) do { m[pe.th32ProcessID] = pe.th32ParentProcessID; } while (Process32NextW(snap, &pe));
    CloseHandle(snap);
    return m;
}

static std::set<DWORD> descendantsOf(DWORD root, const std::map<DWORD, DWORD>& parent) {
    std::set<DWORD> out{ root };
    bool grew = true;
    while (grew) {
        grew = false;
        for (auto& kv : parent) if (!out.count(kv.first) && out.count(kv.second) && kv.first != kv.second) { out.insert(kv.first); grew = true; }
    }
    return out;
}

static int cmdAudioSessions(DWORD root) {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    auto parent = parentMap();
    auto tree = root ? descendantsOf(root, parent) : std::set<DWORD>{};
    std::string o = "{\"build\":" + std::to_string(windowsBuild()) + ",\"sessions\":[";
    bool first = true;
    ComPtr<IMMDeviceEnumerator> en;
    if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en)))) {
        ComPtr<IMMDeviceCollection> col;
        if (SUCCEEDED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &col))) {
            UINT n = 0;
            col->GetCount(&n);
            for (UINT i = 0; i < n; i++) {
                ComPtr<IMMDevice> dev;
                if (FAILED(col->Item(i, &dev))) continue;
                std::wstring devName = L"?";
                ComPtr<IPropertyStore> ps;
                if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &ps))) {
                    PROPVARIANT pv;
                    PropVariantInit(&pv);
                    if (SUCCEEDED(ps->GetValue(PKEY_Device_FriendlyName, &pv)) && pv.vt == VT_LPWSTR && pv.pwszVal) devName = pv.pwszVal;
                    PropVariantClear(&pv);
                }
                ComPtr<IAudioSessionManager2> mgr;
                if (FAILED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&mgr))) continue;
                ComPtr<IAudioSessionEnumerator> se;
                if (FAILED(mgr->GetSessionEnumerator(&se))) continue;
                int cnt = 0;
                se->GetCount(&cnt);
                for (int j = 0; j < cnt; j++) {
                    ComPtr<IAudioSessionControl> sc;
                    if (FAILED(se->GetSession(j, &sc))) continue;
                    AudioSessionState st = AudioSessionStateInactive;
                    sc->GetState(&st);
                    ComPtr<IAudioSessionControl2> sc2;
                    if (FAILED(sc.As(&sc2))) continue;
                    DWORD pid = 0;
                    sc2->GetProcessId(&pid);
                    bool sys = sc2->IsSystemSoundsSession() == S_OK;
                    DWORD par = parent.count(pid) ? parent[pid] : 0;
                    char b[160];
                    snprintf(b, sizeof b, "%s{\"pid\":%lu,\"parent\":%lu,\"active\":%s,\"system\":%s,\"inDiscord\":%s,", first ? "" : ",", pid, par, st == AudioSessionStateActive ? "true" : "false", sys ? "true" : "false", tree.count(pid) ? "true" : "false");
                    first = false;
                    o += b;
                    o += "\"exe\":\"" + jsonEscape(toUtf8(pid ? exeNameOfPid(pid) : L"-")) + "\",\"parentExe\":\"" + jsonEscape(toUtf8(par ? exeNameOfPid(par) : L"-")) + "\",\"device\":\"" + jsonEscape(toUtf8(devName)) + "\"}";
                }
            }
        }
    }
    o += "]}\n";
    fputs(o.c_str(), stdout);
    return 0;
}

// ---------------------------------------------------------------- audio (process loopback)

class ActivateHandler : public Microsoft::WRL::RuntimeClass<
                            Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
                            Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler> {
public:
    HANDLE evt = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HRESULT result = E_FAIL;
    ComPtr<IAudioClient> client;
    ~ActivateHandler() { CloseHandle(evt); }
    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* op) {
        HRESULT act = E_FAIL;
        ComPtr<IUnknown> unk;
        HRESULT hr = op->GetActivateResult(&act, &unk);
        if (SUCCEEDED(hr) && SUCCEEDED(act)) unk.As(&client);
        result = FAILED(hr) ? hr : act;
        SetEvent(evt);
        return S_OK;
    }
};

static ComPtr<IAudioClient> activateProcessLoopback(DWORD pid, HRESULT& hrOut, bool exclude = false) {
    AUDIOCLIENT_ACTIVATION_PARAMS p{};
    p.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    p.ProcessLoopbackParams.TargetProcessId = pid;
    p.ProcessLoopbackParams.ProcessLoopbackMode = exclude ? PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE : PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT pv{};
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof p;
    pv.blob.pBlobData = (BYTE*)&p;
    auto handler = Microsoft::WRL::Make<ActivateHandler>();
    ComPtr<IActivateAudioInterfaceAsyncOperation> op;
    hrOut = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, handler.Get(), &op);
    if (FAILED(hrOut)) return nullptr;
    WaitForSingleObject(handler->evt, 5000);
    hrOut = handler->result;
    return handler->client;
}

struct AudioStats {
    double seconds = 0;
    int peak = 0;          // 0..32767
    uint64_t packets = 0, loudPackets = 0;
    bool ok = false;
};

static void writeWavHeader(FILE* f, uint32_t rate, uint32_t dataBytes) {
    uint16_t ch = 2, bits = 16, fmt = 1;
    uint32_t byteRate = rate * ch * bits / 8, riff = 36 + dataBytes, fmtLen = 16;
    uint16_t blockAlign = ch * bits / 8;
    fseek(f, 0, SEEK_SET);
    fwrite("RIFF", 1, 4, f); fwrite(&riff, 4, 1, f); fwrite("WAVEfmt ", 1, 8, f);
    fwrite(&fmtLen, 4, 1, f); fwrite(&fmt, 2, 1, f); fwrite(&ch, 2, 1, f); fwrite(&rate, 4, 1, f);
    fwrite(&byteRate, 4, 1, f); fwrite(&blockAlign, 2, 1, f); fwrite(&bits, 2, 1, f);
    fwrite("data", 1, 4, f); fwrite(&dataBytes, 4, 1, f);
}

static void audioThread(DWORD pid, const std::wstring& path, std::atomic<bool>& stop, AudioStats& st) {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    ComPtr<IAudioClient> client;
    HRESULT hr = S_OK;
    uint32_t rate = 0;
    HANDLE evt = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    for (uint32_t tryRate : { 48000u, 44100u }) {
        client = activateProcessLoopback(pid, hr);
        if (!client) { say("[audio] falha ao ativar loopback do processo %lu (hr=0x%08lx)\n", pid, (unsigned long)hr); continue; }
        WAVEFORMATEX fmt{ WAVE_FORMAT_PCM, 2, tryRate, tryRate * 4, 4, 16, 0 };
        hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 2000000, 0, &fmt, nullptr);
        if (SUCCEEDED(hr)) { rate = tryRate; break; }
        say("[audio] Initialize falhou em %u Hz (hr=0x%08lx)\n", tryRate, (unsigned long)hr);
        client.Reset();
    }
    if (!client) { CloseHandle(evt); return; }
    client->SetEventHandle(evt);
    ComPtr<IAudioCaptureClient> cap;
    if (FAILED(client->GetService(IID_PPV_ARGS(&cap)))) { CloseHandle(evt); return; }
    FILE* f = nullptr;
    _wfopen_s(&f, path.c_str(), L"wb");
    if (!f) { CloseHandle(evt); return; }
    writeWavHeader(f, rate, 0);
    uint64_t bytes = 0;
    client->Start();
    st.ok = true;
    say("[audio] capturando somente o processo %lu (e filhos), %u Hz\n", pid, rate);
    while (!stop) {
        WaitForSingleObject(evt, 100);
        UINT32 n = 0;
        while (SUCCEEDED(cap->GetNextPacketSize(&n)) && n > 0) {
            BYTE* data = nullptr;
            UINT32 frames = 0;
            DWORD flags = 0;
            if (FAILED(cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
            size_t sz = (size_t)frames * 4;
            st.packets++;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                std::vector<BYTE> z(sz, 0);
                fwrite(z.data(), 1, sz, f);
            } else {
                fwrite(data, 1, sz, f);
                int16_t* s = (int16_t*)data;
                int pk = 0;
                for (size_t i = 0; i < sz / 2; i++) pk = std::max(pk, (int)std::abs((int)s[i]));
                if (pk > 50) st.loudPackets++;
                st.peak = std::max(st.peak, pk);
            }
            bytes += sz;
            cap->ReleaseBuffer(frames);
        }
    }
    client->Stop();
    writeWavHeader(f, rate, (uint32_t)bytes);
    fclose(f);
    st.seconds = (double)bytes / (rate * 4.0);
    CloseHandle(evt);
}

// ---------------------------------------------------------------- video (WGC + Media Foundation)

struct VideoOut {
    ComPtr<IMFSinkWriter> writer;
    DWORD stream = 0;
    UINT w = 0, h = 0;
    LONGLONG dur = 0;

    HRESULT open(const std::wstring& path, UINT W, UINT H, UINT fps) {
        w = W; h = H; dur = 10000000LL / fps;
        ComPtr<IMFAttributes> at;
        MFCreateAttributes(&at, 2);
        at->SetUINT32(MF_SINK_WRITER_DISABLE_THROTTLING, TRUE);
        HRESULT hr = MFCreateSinkWriterFromURL(path.c_str(), nullptr, at.Get(), &writer);
        if (FAILED(hr)) return hr;
        ComPtr<IMFMediaType> out;
        MFCreateMediaType(&out);
        out->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        out->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
        out->SetUINT32(MF_MT_AVG_BITRATE, 12000000);
        out->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
        MFSetAttributeSize(out.Get(), MF_MT_FRAME_SIZE, w, h);
        MFSetAttributeRatio(out.Get(), MF_MT_FRAME_RATE, fps, 1);
        MFSetAttributeRatio(out.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
        hr = writer->AddStream(out.Get(), &stream);
        if (FAILED(hr)) return hr;
        ComPtr<IMFMediaType> in;
        MFCreateMediaType(&in);
        in->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        in->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
        in->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
        in->SetUINT32(MF_MT_DEFAULT_STRIDE, w * 4);
        MFSetAttributeSize(in.Get(), MF_MT_FRAME_SIZE, w, h);
        MFSetAttributeRatio(in.Get(), MF_MT_FRAME_RATE, fps, 1);
        MFSetAttributeRatio(in.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
        hr = writer->SetInputMediaType(stream, in.Get(), nullptr);
        if (FAILED(hr)) return hr;
        return writer->BeginWriting();
    }

    void write(const BYTE* src, UINT pitch, LONGLONG ts) {
        ComPtr<IMFMediaBuffer> buf;
        MFCreateMemoryBuffer(w * h * 4, &buf);
        BYTE* p = nullptr;
        buf->Lock(&p, nullptr, nullptr);
        MFCopyImage(p, w * 4, src, pitch, w * 4, h);
        buf->Unlock();
        buf->SetCurrentLength(w * h * 4);
        ComPtr<IMFSample> s;
        MFCreateSample(&s);
        s->AddBuffer(buf.Get());
        s->SetSampleTime(ts);
        s->SetSampleDuration(dur);
        writer->WriteSample(stream, s.Get());
    }

    void close() { if (writer) writer->Finalize(); }
};

static bool isTargetFocused(HWND target) {
    HWND fg = GetForegroundWindow();
    if (!fg) return false;
    if (fg == target) return true;
    return GetAncestor(fg, GA_ROOTOWNER) == GetAncestor(target, GA_ROOTOWNER);
}

struct Options {
    HWND hwnd = nullptr;
    int monitor = -1;
    std::wstring title;
    DWORD pid = 0;
    int seconds = 5;
    int fps = 30;
    std::string cursor = "follow";
    std::wstring out;
};

static int runCapture(Options o) {
    if (!wgc::GraphicsCaptureSession::IsSupported()) { say("ERRO: Windows Graphics Capture nao suportado neste Windows.\n"); return 2; }

    if (!o.title.empty()) {
        std::wstring needle = o.title;
        std::transform(needle.begin(), needle.end(), needle.begin(), towlower);
        for (auto& w : listWindows()) {
            std::wstring t = w.title;
            std::transform(t.begin(), t.end(), t.begin(), towlower);
            if (t.find(needle) != std::wstring::npos) { o.hwnd = w.hwnd; break; }
        }
        if (!o.hwnd) { say("ERRO: nenhuma janela com esse titulo.\n"); return 2; }
    }
    if (!o.hwnd && o.monitor < 0) { say("ERRO: informe --hwnd, --title ou --monitor.\n"); return 2; }

    HMONITOR hmon = nullptr;
    if (o.monitor >= 0) {
        auto ms = listMonitors();
        if (o.monitor >= (int)ms.size()) { say("ERRO: monitor inexistente.\n"); return 2; }
        hmon = ms[o.monitor].h;
    } else {
        DWORD wpid = 0;
        GetWindowThreadProcessId(o.hwnd, &wpid);
        if (!o.pid) o.pid = wpid;
        wchar_t t[512];
        GetWindowTextW(o.hwnd, t, 512);
        say("Janela: %s (%s, pid %lu)\n", toUtf8(t).c_str(), toUtf8(exeNameOfPid(o.pid)).c_str(), o.pid);
    }

    {
        // create the output folder and its parents
        std::wstring part;
        for (size_t i = 0; i <= o.out.size(); i++) {
            if (i == o.out.size() || o.out[i] == L'\\' || o.out[i] == L'/') {
                if (!part.empty() && part.back() != L':') CreateDirectoryW(part.c_str(), nullptr);
            }
            if (i < o.out.size()) part += o.out[i];
        }
    }

    // D3D11 device
    ComPtr<ID3D11Device> dev;
    ComPtr<ID3D11DeviceContext> ctx;
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &dev, nullptr, &ctx))) {
        say("ERRO: falha ao criar dispositivo D3D11.\n");
        return 3;
    }
    ComPtr<ID3D11Multithread> mt;
    if (SUCCEEDED(dev.As(&mt))) mt->SetMultithreadProtected(TRUE);
    ComPtr<IDXGIDevice> dxgi;
    dev.As(&dxgi);
    winrt::com_ptr<::IInspectable> insp;
    winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.Get(), insp.put()));
    auto d3dDevice = insp.as<wd3d::IDirect3DDevice>();

    // Capture item
    auto interop = winrt::get_activation_factory<wgc::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    wgc::GraphicsCaptureItem item{ nullptr };
    HRESULT hr = hmon ? interop->CreateForMonitor(hmon, winrt::guid_of<wgc::GraphicsCaptureItem>(), winrt::put_abi(item))
                      : interop->CreateForWindow(o.hwnd, winrt::guid_of<wgc::GraphicsCaptureItem>(), winrt::put_abi(item));
    if (FAILED(hr)) { say("ERRO: nao foi possivel capturar essa fonte (hr=0x%08lx).\n", (unsigned long)hr); return 3; }

    auto size = item.Size();
    UINT W = (UINT)size.Width & ~1u, H = (UINT)size.Height & ~1u;
    say("Tamanho da captura: %ux%u a %d fps por %d s\n", W, H, o.fps, o.seconds);

    // staging texture (fixed output size)
    D3D11_TEXTURE2D_DESC sd{};
    sd.Width = W; sd.Height = H; sd.MipLevels = 1; sd.ArraySize = 1;
    sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    sd.SampleDesc.Count = 1;
    sd.Usage = D3D11_USAGE_STAGING;
    sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> staging;
    dev->CreateTexture2D(&sd, nullptr, &staging);

    MFStartup(MF_VERSION);
    VideoOut vo;
    std::wstring videoPath = o.out + L"\\video.mp4";
    hr = vo.open(videoPath, W, H, (UINT)o.fps);
    if (FAILED(hr)) { say("ERRO: falha ao preparar o arquivo de video (hr=0x%08lx).\n", (unsigned long)hr); return 4; }

    std::mutex mtx;
    LONGLONG t0 = -1, lastTs = -1;
    const LONGLONG minInterval = 10000000LL / o.fps - 20000;
    std::atomic<int> framesWritten{ 0 };

    auto pool = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(d3dDevice, wdx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
    pool.FrameArrived([&](wgc::Direct3D11CaptureFramePool const& sender, winrt::Windows::Foundation::IInspectable const&) {
        auto frame = sender.TryGetNextFrame();
        if (!frame) return;
        std::lock_guard<std::mutex> lk(mtx);
        LONGLONG ts = frame.SystemRelativeTime().count();
        if (t0 < 0) t0 = ts;
        LONGLONG rel = ts - t0;
        if (lastTs >= 0 && rel - lastTs < minInterval) return;
        lastTs = rel;
        auto cs = frame.ContentSize();
        ComPtr<ID3D11Texture2D> tex;
        auto access = frame.Surface().as<IDirect3DDxgiInterfaceAccess>();
        if (FAILED(access->GetInterface(IID_PPV_ARGS(&tex)))) return;
        D3D11_BOX box{ 0, 0, 0, std::min<UINT>((UINT)cs.Width, W), std::min<UINT>((UINT)cs.Height, H), 1 };
        ctx->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, tex.Get(), 0, &box);
        D3D11_MAPPED_SUBRESOURCE m{};
        if (SUCCEEDED(ctx->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &m))) {
            vo.write((const BYTE*)m.pData, m.RowPitch, rel);
            ctx->Unmap(staging.Get(), 0);
            framesWritten++;
        }
    });

    auto session = pool.CreateCaptureSession(item);
    bool follow = (o.cursor == "follow") && o.hwnd;
    bool cursorOn = (o.cursor == "always") || (o.cursor == "follow" && !o.hwnd);
    if (follow) cursorOn = isTargetFocused(o.hwnd);
    if (o.cursor == "never") cursorOn = false;
    try { session.IsCursorCaptureEnabled(cursorOn); } catch (...) { say("(aviso) controle de cursor indisponivel\n"); }
    try { session.IsBorderRequired(false); } catch (...) {}

    // audio (only for window capture, or when --pid given)
    std::atomic<bool> stopAudio{ false };
    AudioStats ast;
    std::thread at;
    if (o.pid) at = std::thread(audioThread, o.pid, o.out + L"\\audio.wav", std::ref(stopAudio), std::ref(ast));

    std::atomic<bool> stopCursor{ false };
    std::thread ct;
    double start = nowSec();
    if (follow) {
        say("[cursor] %s no inicio\n", cursorOn ? "LIGADO" : "DESLIGADO");
        ct = std::thread([&] {
            bool cur = cursorOn;
            while (!stopCursor) {
                bool f = isTargetFocused(o.hwnd);
                if (f != cur) {
                    cur = f;
                    try { session.IsCursorCaptureEnabled(cur); } catch (...) {}
                    say("[cursor] %s em %.1fs\n", cur ? "LIGADO (janela em foco)" : "DESLIGADO (janela fora de foco)", nowSec() - start);
                }
                Sleep(30);
            }
        });
    }

    session.StartCapture();
    say("Gravando... (%d s)\n", o.seconds);
    while (nowSec() - start < o.seconds) Sleep(50);

    session.Close();
    pool.Close();
    stopCursor = true;
    stopAudio = true;
    if (ct.joinable()) ct.join();
    if (at.joinable()) at.join();
    int realFrames = framesWritten.load();
    {
        std::lock_guard<std::mutex> lk(mtx);
        // repeat the last frame at the end so a still window still gives a video of the right length
        LONGLONG endTs = (LONGLONG)o.seconds * 10000000LL - vo.dur;
        if (realFrames > 0 && endTs > lastTs + vo.dur) {
            D3D11_MAPPED_SUBRESOURCE m{};
            if (SUCCEEDED(ctx->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &m))) {
                vo.write((const BYTE*)m.pData, m.RowPitch, endTs);
                ctx->Unmap(staging.Get(), 0);
            }
        }
        vo.close();
    }
    MFShutdown();

    say("\n===== RESULTADO =====\n");
    say("Video: %d quadros novos em %ls\\video.mp4\n", realFrames, o.out.c_str());
    if (realFrames == 0)
        say("  -> Nenhum quadro. A janela estava minimizada ou escondida. Deixe-a visivel e tente de novo.\n");
    else if (realFrames < o.seconds * 3)
        say("  -> Poucos quadros: a janela ficou PARADA (nada mudou na tela). Isso e normal.\n     O video fica como uma imagem fixa. Para ver movimento, escolha uma janela com video tocando.\n");
    if (o.pid) {
        if (ast.ok) {
            int pct = ast.peak * 100 / 32767;
            say("Audio: %.1f s em %ls\\audio.wav\n", ast.seconds, o.out.c_str());
            say("Audio: volume maximo captado = %d%% (0%% = silencio)\n", pct);
            if (pct == 0)
                say("  -> Silencio: essa janela nao estava tocando som. Isso e normal se nada estava tocando nela.\n     Para testar, escolha uma janela que esteja tocando musica ou video de verdade.\n");
        } else {
            say("Audio: nao foi possivel capturar\n");
        }
    }
    return 0;
}


// ---------------------------------------------------------------- jpeg + gpu helpers (Phase 3)

static IWICImagingFactory* wicFactory() {
    static ComPtr<IWICImagingFactory> f = [] {
        ComPtr<IWICImagingFactory> x;
        CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&x));
        return x;
    }();
    return f.Get();
}

static void fitSize(UINT w, UINT h, UINT maxW, UINT maxH, UINT& ow, UINT& oh) {
    double sc = 1.0;
    if (maxW) sc = std::min(sc, (double)maxW / w);
    if (maxH) sc = std::min(sc, (double)maxH / h);
    ow = std::max(2u, (UINT)(w * sc) & ~1u);
    oh = std::max(2u, (UINT)(h * sc) & ~1u);
}

// BGRA pixels -> JPEG bytes, optionally scaled to ow x oh
static bool encodeJpeg(const BYTE* px, UINT w, UINT h, UINT pitch, UINT ow, UINT oh, float quality, std::vector<BYTE>& out) {
    auto* wic = wicFactory();
    if (!wic) return false;
    ComPtr<IWICBitmap> bmp;
    if (FAILED(wic->CreateBitmapFromMemory(w, h, GUID_WICPixelFormat32bppBGRA, pitch, pitch * h, (BYTE*)px, &bmp))) return false;
    ComPtr<IWICBitmapSource> src = bmp;
    ComPtr<IWICBitmapScaler> scaler;
    if (ow != w || oh != h) {
        wic->CreateBitmapScaler(&scaler);
        if (FAILED(scaler->Initialize(src.Get(), ow, oh, WICBitmapInterpolationModeLinear))) return false;
        src = scaler;
    } else {
        ow = w; oh = h;
    }
    ComPtr<IWICFormatConverter> conv;
    wic->CreateFormatConverter(&conv);
    if (FAILED(conv->Initialize(src.Get(), GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom))) return false;
    ComPtr<IStream> stream;
    if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream))) return false;
    ComPtr<IWICBitmapEncoder> enc;
    if (FAILED(wic->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &enc))) return false;
    if (FAILED(enc->Initialize(stream.Get(), WICBitmapEncoderNoCache))) return false;
    ComPtr<IWICBitmapFrameEncode> fr;
    ComPtr<IPropertyBag2> pb;
    if (FAILED(enc->CreateNewFrame(&fr, &pb))) return false;
    PROPBAG2 opt{};
    opt.pstrName = (LPOLESTR)L"ImageQuality";
    VARIANT v;
    VariantInit(&v);
    v.vt = VT_R4;
    v.fltVal = quality;
    pb->Write(1, &opt, &v);
    if (FAILED(fr->Initialize(pb.Get()))) return false;
    fr->SetSize(ow, oh);
    WICPixelFormatGUID pf = GUID_WICPixelFormat24bppBGR;
    fr->SetPixelFormat(&pf);
    if (FAILED(fr->WriteSource(conv.Get(), nullptr))) return false;
    if (FAILED(fr->Commit()) || FAILED(enc->Commit())) return false;
    STATSTG st{};
    stream->Stat(&st, STATFLAG_NONAME);
    HGLOBAL hg = nullptr;
    GetHGlobalFromStream(stream.Get(), &hg);
    void* p = GlobalLock(hg);
    if (!p) return false;
    out.assign((BYTE*)p, (BYTE*)p + (size_t)st.cbSize.QuadPart);
    GlobalUnlock(hg);
    return true;
}

struct Gpu {
    ComPtr<ID3D11Device> dev;
    ComPtr<ID3D11DeviceContext> ctx;
    wd3d::IDirect3DDevice d3d{ nullptr };
    LUID luid{};
    std::string adapterName;
};

static bool makeGpu(Gpu& g) {
    // escolhe a placa de video de verdade (maior memoria dedicada), nunca um adaptador virtual (Parsec, SuperDisplay...)
    ComPtr<IDXGIFactory1> fac;
    ComPtr<IDXGIAdapter1> best;
    SIZE_T bestMem = 0;
    if (SUCCEEDED(CreateDXGIFactory1(IID_PPV_ARGS(&fac)))) {
        ComPtr<IDXGIAdapter1> a;
        for (UINT i = 0; fac->EnumAdapters1(i, &a) != DXGI_ERROR_NOT_FOUND; i++, a.Reset()) {
            DXGI_ADAPTER_DESC1 d{};
            a->GetDesc1(&d);
            if (d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;
            if (d.DedicatedVideoMemory > bestMem) { bestMem = d.DedicatedVideoMemory; best = a; }
        }
    }
    const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
    HRESULT hr = E_FAIL;
    if (best) hr = D3D11CreateDevice(best.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags, nullptr, 0, D3D11_SDK_VERSION, &g.dev, nullptr, &g.ctx);
    if (FAILED(hr)) hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, nullptr, 0, D3D11_SDK_VERSION, &g.dev, nullptr, &g.ctx);
    if (FAILED(hr)) hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &g.dev, nullptr, &g.ctx);
    if (FAILED(hr)) return false;
    {
        ComPtr<IDXGIDevice> xd;
        ComPtr<IDXGIAdapter> xa;
        DXGI_ADAPTER_DESC ad{};
        if (SUCCEEDED(g.dev.As(&xd)) && SUCCEEDED(xd->GetAdapter(&xa)) && SUCCEEDED(xa->GetDesc(&ad))) {
            g.luid = ad.AdapterLuid;
            g.adapterName = toUtf8(ad.Description);
        }
    }
    ComPtr<ID3D11Multithread> mt;
    if (SUCCEEDED(g.dev.As(&mt))) mt->SetMultithreadProtected(TRUE);
    ComPtr<IDXGIDevice> dxgi;
    g.dev.As(&dxgi);
    winrt::com_ptr<::IInspectable> insp;
    if (FAILED(CreateDirect3D11DeviceFromDXGIDevice(dxgi.Get(), insp.put()))) return false;
    g.d3d = insp.as<wd3d::IDirect3DDevice>();
    return true;
}

static wgc::GraphicsCaptureItem makeItem(HWND hwnd, int monitor) {
    wgc::GraphicsCaptureItem item{ nullptr };
    auto interop = winrt::get_activation_factory<wgc::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    HRESULT hr = E_FAIL;
    if (monitor >= 0) {
        auto ms = listMonitors();
        if (monitor < (int)ms.size()) hr = interop->CreateForMonitor(ms[monitor].h, winrt::guid_of<wgc::GraphicsCaptureItem>(), winrt::put_abi(item));
    } else if (hwnd) {
        hr = interop->CreateForWindow(hwnd, winrt::guid_of<wgc::GraphicsCaptureItem>(), winrt::put_abi(item));
    }
    if (FAILED(hr)) return wgc::GraphicsCaptureItem{ nullptr };
    return item;
}

static ComPtr<ID3D11Texture2D> makeStaging(Gpu& g, UINT w, UINT h) {
    D3D11_TEXTURE2D_DESC sd{};
    sd.Width = w; sd.Height = h; sd.MipLevels = 1; sd.ArraySize = 1;
    sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    sd.SampleDesc.Count = 1;
    sd.Usage = D3D11_USAGE_STAGING;
    sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> t;
    g.dev->CreateTexture2D(&sd, nullptr, &t);
    return t;
}


static std::wstring exePathOfPid(DWORD pid) {
    HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!p) return L"";
    wchar_t buf[MAX_PATH * 2];
    DWORD n = (DWORD)std::size(buf);
    std::wstring r;
    if (QueryFullProcessImageNameW(p, 0, buf, &n)) r.assign(buf, n);
    CloseHandle(p);
    return r;
}

// exe icon -> PNG file
static bool saveIconPng(const std::wstring& exePath, const std::wstring& outFile) {
    if (exePath.empty()) return false;
    SHFILEINFOW sfi{};
    if (!SHGetFileInfoW(exePath.c_str(), 0, &sfi, sizeof sfi, SHGFI_ICON | SHGFI_LARGEICON) || !sfi.hIcon) return false;
    auto* wic = wicFactory();
    ComPtr<IWICBitmap> bmp;
    HRESULT hr = wic ? wic->CreateBitmapFromHICON(sfi.hIcon, &bmp) : E_FAIL;
    DestroyIcon(sfi.hIcon);
    if (FAILED(hr)) return false;
    ComPtr<IWICStream> st;
    wic->CreateStream(&st);
    if (FAILED(st->InitializeFromFilename(outFile.c_str(), GENERIC_WRITE))) return false;
    ComPtr<IWICBitmapEncoder> enc;
    wic->CreateEncoder(GUID_ContainerFormatPng, nullptr, &enc);
    enc->Initialize(st.Get(), WICBitmapEncoderNoCache);
    ComPtr<IWICBitmapFrameEncode> fr;
    enc->CreateNewFrame(&fr, nullptr);
    fr->Initialize(nullptr);
    UINT w = 0, h = 0;
    bmp->GetSize(&w, &h);
    fr->SetSize(w, h);
    WICPixelFormatGUID pf = GUID_WICPixelFormat32bppBGRA;
    fr->SetPixelFormat(&pf);
    fr->WriteSource(bmp.Get(), nullptr);
    fr->Commit();
    enc->Commit();
    st->Commit(STGC_DEFAULT);
    return true;
}

static void ensureDir(const std::wstring& dir) {
    std::wstring part;
    for (size_t i = 0; i <= dir.size(); i++) {
        if (i == dir.size() || dir[i] == L'\\' || dir[i] == L'/') {
            if (!part.empty() && part.back() != L':') CreateDirectoryW(part.c_str(), nullptr);
        }
        if (i < dir.size()) part += dir[i];
    }
}

// ---------------------------------------------------------------- thumbs

struct ThumbJob {
    std::wstring name;
    wgc::GraphicsCaptureItem item{ nullptr };
    wgc::Direct3D11CaptureFramePool pool{ nullptr };
    wgc::GraphicsCaptureSession sess{ nullptr };
    ComPtr<ID3D11Texture2D> staging;
    UINT W = 0, H = 0;
    std::atomic<bool> done{ false };
};

static int cmdThumbs(const std::wstring& out, UINT thumbW, bool doWin, bool doMon, bool icons) {
    ensureDir(out);
    Gpu g;
    if (!makeGpu(g)) { fputs("ERRO: D3D11\n", stderr); return 3; }
    std::vector<std::unique_ptr<ThumbJob>> jobs;
    std::mutex mtx;
    auto add = [&](const std::wstring& name, wgc::GraphicsCaptureItem item) {
        if (!item) return;
        auto sz = item.Size();
        if (sz.Width < 2 || sz.Height < 2) return;
        auto j = std::make_unique<ThumbJob>();
        j->name = name; j->item = item; j->W = sz.Width; j->H = sz.Height;
        j->staging = makeStaging(g, j->W, j->H);
        jobs.push_back(std::move(j));
    };
    if (doWin) {
        for (auto& w : listWindows()) {
            std::wstring id = std::to_wstring((unsigned long long)(uintptr_t)w.hwnd);
            if (!w.minimized) add(L"w" + id, makeItem(w.hwnd, -1));
            if (icons) saveIconPng(exePathOfPid(w.pid), out + L"\\i" + id + L".png");
        }
    }
    if (doMon) {
        auto ms = listMonitors();
        for (size_t i = 0; i < ms.size(); i++) add(L"m" + std::to_wstring(i), makeItem(nullptr, (int)i));
    }

    for (auto& jp : jobs) {
        ThumbJob* j = jp.get();
        j->pool = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(g.d3d, wdx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, j->item.Size());
        j->pool.FrameArrived([&, j](wgc::Direct3D11CaptureFramePool const& sender, winrt::Windows::Foundation::IInspectable const&) {
            auto frame = sender.TryGetNextFrame();
            if (!frame) return;
            std::lock_guard<std::mutex> lk(mtx);
            if (j->done) return;
            auto cs = frame.ContentSize();
            UINT cw = std::min<UINT>((UINT)cs.Width, j->W), ch = std::min<UINT>((UINT)cs.Height, j->H);
            if (cw < 2 || ch < 2) return;
            ComPtr<ID3D11Texture2D> tex;
            auto access = frame.Surface().as<IDirect3DDxgiInterfaceAccess>();
            if (FAILED(access->GetInterface(IID_PPV_ARGS(&tex)))) return;
            D3D11_BOX box{ 0, 0, 0, cw, ch, 1 };
            g.ctx->CopySubresourceRegion(j->staging.Get(), 0, 0, 0, 0, tex.Get(), 0, &box);
            D3D11_MAPPED_SUBRESOURCE m{};
            if (FAILED(g.ctx->Map(j->staging.Get(), 0, D3D11_MAP_READ, 0, &m))) return;
            UINT ow, oh;
            fitSize(cw, ch, thumbW, 0, ow, oh);
            std::vector<BYTE> jpg;
            bool ok = encodeJpeg((const BYTE*)m.pData, cw, ch, m.RowPitch, ow, oh, 0.7f, jpg);
            g.ctx->Unmap(j->staging.Get(), 0);
            if (ok) {
                FILE* f = nullptr;
                _wfopen_s(&f, (out + L"\\" + j->name + L".jpg").c_str(), L"wb");
                if (f) { fwrite(jpg.data(), 1, jpg.size(), f); fclose(f); }
            }
            j->done = true;
        });
        j->sess = j->pool.CreateCaptureSession(j->item);
        try { j->sess.IsCursorCaptureEnabled(false); } catch (...) {}
        try { j->sess.IsBorderRequired(false); } catch (...) {}
        j->sess.StartCapture();
    }
    double t0 = nowSec();
    while (nowSec() - t0 < 2.5) {
        bool all = true;
        for (auto& j : jobs) if (!j->done) { all = false; break; }
        if (all) break;
        Sleep(30);
    }
    int ok = 0;
    for (auto& j : jobs) {
        if (j->done) ok++;
        try { j->sess.Close(); } catch (...) {}
        try { j->pool.Close(); } catch (...) {}
    }
    fprintf(stdout, "{\"ok\":%d,\"total\":%zu}\n", ok, jobs.size());
    fflush(stdout);
    return 0;
}

// ---------------------------------------------------------------- GPU path: BGRA -> NV12 (video processor) -> H.264 (hardware MFT)
// Everything stays on the graphics card: capture texture, color conversion/scaling and encoding (NVENC/AMF/QSV).

struct GpuConverter {
    ComPtr<ID3D11VideoDevice> vdev;
    ComPtr<ID3D11VideoContext> vctx;
    ComPtr<ID3D11VideoProcessorEnumerator> en;
    ComPtr<ID3D11VideoProcessor> vp;
    ComPtr<ID3D11Texture2D> inTex;
    ComPtr<ID3D11VideoProcessorInputView> inView;
    std::vector<ComPtr<ID3D11Texture2D>> outTex;   // alvo do conversor (render target)
    std::vector<ComPtr<ID3D11Texture2D>> encTex;   // entregues ao codificador
    std::vector<ComPtr<ID3D11VideoProcessorOutputView>> outViews;
    UINT encBind = 0;
    size_t next = 0;
    UINT iw = 0, ih = 0, ow = 0, oh = 0, fps = 60;

    bool init(Gpu& g, UINT inW, UINT inH, UINT outW, UINT outH, UINT f, std::string& err) {
        iw = inW; ih = inH; ow = outW; oh = outH; fps = f;
        if (FAILED(g.dev.As(&vdev)) || FAILED(g.ctx.As(&vctx))) { err = "sem ID3D11VideoDevice"; return false; }
        D3D11_VIDEO_PROCESSOR_CONTENT_DESC cd{};
        cd.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
        cd.InputFrameRate = { fps, 1 };
        cd.InputWidth = iw; cd.InputHeight = ih;
        cd.OutputFrameRate = { fps, 1 };
        cd.OutputWidth = ow; cd.OutputHeight = oh;
        cd.Usage = D3D11_VIDEO_USAGE_OPTIMAL_SPEED;
        if (FAILED(vdev->CreateVideoProcessorEnumerator(&cd, &en))) { err = "CreateVideoProcessorEnumerator"; return false; }
        if (FAILED(vdev->CreateVideoProcessor(en.Get(), 0, &vp))) { err = "CreateVideoProcessor"; return false; }

        D3D11_TEXTURE2D_DESC td{};
        td.Width = iw; td.Height = ih; td.MipLevels = 1; td.ArraySize = 1;
        td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        td.SampleDesc.Count = 1;
        td.Usage = D3D11_USAGE_DEFAULT;
        td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
        if (FAILED(g.dev->CreateTexture2D(&td, nullptr, &inTex))) { err = "textura de entrada"; return false; }
        D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC ivd{};
        ivd.FourCC = 0;
        ivd.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
        if (FAILED(vdev->CreateVideoProcessorInputView(inTex.Get(), en.Get(), &ivd, &inView))) { err = "input view"; return false; }

        outTex.clear(); outViews.clear(); encTex.clear();
        {
            char* e = nullptr; size_t el = 0;
            if (_dupenv_s(&e, &el, "GLV_ENCBIND") == 0 && e) { encBind = (UINT)strtoul(e, nullptr, 0); free(e); }
        }
        for (int i = 0; i < 6; i++) {
            D3D11_TEXTURE2D_DESC od{};
            od.Width = ow; od.Height = oh; od.MipLevels = 1; od.ArraySize = 1;
            od.Format = DXGI_FORMAT_NV12;
            od.SampleDesc.Count = 1;
            od.Usage = D3D11_USAGE_DEFAULT;
            od.BindFlags = D3D11_BIND_RENDER_TARGET;
            ComPtr<ID3D11Texture2D> t;
            if (FAILED(g.dev->CreateTexture2D(&od, nullptr, &t))) { err = "textura NV12"; return false; }
            D3D11_TEXTURE2D_DESC ed = od;
            ed.BindFlags = encBind;
            ComPtr<ID3D11Texture2D> et;
            if (FAILED(g.dev->CreateTexture2D(&ed, nullptr, &et))) { err = "textura NV12 do codificador (bind " + std::to_string(encBind) + ")"; return false; }
            encTex.push_back(et);
            D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC ovd{};
            ovd.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
            ComPtr<ID3D11VideoProcessorOutputView> v;
            if (FAILED(vdev->CreateVideoProcessorOutputView(t.Get(), en.Get(), &ovd, &v))) { err = "output view"; return false; }
            outTex.push_back(t);
            outViews.push_back(v);
        }

        // RGB cheio -> YCbCr BT.709 em faixa de video (16-235), padrao de streaming
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE inCs{};
        inCs.RGB_Range = 0; // 0-255
        vctx->VideoProcessorSetStreamColorSpace(vp.Get(), 0, &inCs);
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE outCs{};
        outCs.YCbCr_Matrix = 1; // BT.709
        outCs.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
        vctx->VideoProcessorSetOutputColorSpace(vp.Get(), &outCs);
        vctx->VideoProcessorSetStreamFrameFormat(vp.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
        vctx->VideoProcessorSetStreamAutoProcessingMode(vp.Get(), 0, FALSE);
        D3D11_VIDEO_COLOR black{};
        black.YCbCr = { 0.0625f, 0.5f, 0.5f, 1.0f };
        vctx->VideoProcessorSetOutputBackgroundColor(vp.Get(), TRUE, &black);
        setRects(iw, ih);
        return true;
    }

    // mantem a proporcao: a imagem cabe inteira na saida, com barras pretas se precisar
    void setRects(UINT srcW, UINT srcH) {
        RECT src{ 0, 0, (LONG)srcW, (LONG)srcH };
        double sc = std::min((double)ow / srcW, (double)oh / srcH);
        LONG dw = (LONG)(srcW * sc), dh = (LONG)(srcH * sc);
        LONG dx = ((LONG)ow - dw) / 2, dy = ((LONG)oh - dh) / 2;
        RECT dst{ dx, dy, dx + dw, dy + dh };
        RECT full{ 0, 0, (LONG)ow, (LONG)oh };
        vctx->VideoProcessorSetStreamSourceRect(vp.Get(), 0, TRUE, &src);
        vctx->VideoProcessorSetStreamDestRect(vp.Get(), 0, TRUE, &dst);
        vctx->VideoProcessorSetOutputTargetRect(vp.Get(), TRUE, &full);
    }

    ID3D11Texture2D* convert(Gpu& g, ID3D11Texture2D* src, UINT srcW, UINT srcH) {
        D3D11_BOX box{ 0, 0, 0, std::min(srcW, iw), std::min(srcH, ih), 1 };
        g.ctx->CopySubresourceRegion(inTex.Get(), 0, 0, 0, 0, src, 0, &box);
        setRects(std::min(srcW, iw), std::min(srcH, ih));
        size_t i = next++ % outTex.size();
        D3D11_VIDEO_PROCESSOR_STREAM st{};
        st.Enable = TRUE;
        st.pInputSurface = inView.Get();
        if (FAILED(vctx->VideoProcessorBlt(vp.Get(), outViews[i].Get(), 0, 1, &st))) return nullptr;
        g.ctx->CopyResource(encTex[i].Get(), outTex[i].Get());
        return encTex[i].Get();
    }
};

static bool envOn(const char* name) {
    char* e = nullptr; size_t el = 0;
    bool on = false;
    if (_dupenv_s(&e, &el, name) == 0 && e) { on = e[0] == '1'; free(e); }
    return on;
}

struct HwH264 {
    ComPtr<IMFTransform> mft;
    ComPtr<IMFMediaEventGenerator> gen;
    ComPtr<ICodecAPI> api;
    ComPtr<IMFDXGIDeviceManager> dm;
    UINT token = 0;
    bool async = false, providesSamples = false;
    DWORD outSize = 0;
    UINT w = 0, h = 0, fps = 60, bitrate = 12000000;
    std::string name;
    std::vector<BYTE> seqHeader;
    std::mutex m;
    ComPtr<ID3D11Texture2D> pending;
    LONGLONG pendingTs = 0;
    int needInput = 0;
    std::atomic<bool> forceKey{ true };
    bool memMode = false;
    LONGLONG lastKeyTs = -100000000LL;                    // entrega quadros NV12 pela memoria (o NVENC comprime na placa do mesmo jeito)
    ComPtr<ID3D11Texture2D> readback;        // NV12 de leitura
    ID3D11DeviceContext* ctx = nullptr;
    std::atomic<uint64_t> outFrames{ 0 }, inFrames{ 0 }, submits{ 0 }, events{ 0 }, needEv{ 0 }, haveEv{ 0 }, evErrors{ 0 }, feedErrors{ 0 };
    std::atomic<long> lastErr{ 0 }, firstErr{ 0 };
    std::atomic<int> firstStage{ 0 };
    std::function<void(bool, LONGLONG, const BYTE*, DWORD)> onOutput;

    static void setU4(ICodecAPI* a, const GUID& k, ULONG v) { VARIANT x; VariantInit(&x); x.vt = VT_UI4; x.ulVal = v; a->SetValue(&k, &x); }
    static void setBool(ICodecAPI* a, const GUID& k, bool v) { VARIANT x; VariantInit(&x); x.vt = VT_BOOL; x.boolVal = v ? VARIANT_TRUE : VARIANT_FALSE; a->SetValue(&k, &x); }

    bool init(Gpu& g, UINT W, UINT H, UINT f, UINT br, std::string& err) {
        w = W; h = H; fps = f; bitrate = br;
        MFT_REGISTER_TYPE_INFO inInfo{ MFMediaType_Video, MFVideoFormat_NV12 };
        MFT_REGISTER_TYPE_INFO outInfo{ MFMediaType_Video, MFVideoFormat_H264 };
        IMFActivate** acts = nullptr;
        UINT32 n = 0;
        ComPtr<IMFAttributes> ea;
        MFCreateAttributes(&ea, 1);
        ea->SetBlob(MFT_ENUM_ADAPTER_LUID, (const UINT8*)&g.luid, sizeof(LUID));
        if (FAILED(MFTEnum2(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, &inInfo, &outInfo, ea.Get(), &acts, &n)) || n == 0) {
            if (FAILED(MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, &inInfo, &outInfo, &acts, &n)) || n == 0) {
                err = "nenhum codificador H.264 por hardware";
                return false;
            }
        }
        HRESULT hr = acts[0]->ActivateObject(IID_PPV_ARGS(&mft));
        WCHAR* fname = nullptr;
        UINT32 flen = 0;
        if (SUCCEEDED(acts[0]->GetAllocatedString(MFT_FRIENDLY_NAME_Attribute, &fname, &flen))) { name = toUtf8(fname); CoTaskMemFree(fname); }
        for (UINT32 i = 0; i < n; i++) acts[i]->Release();
        CoTaskMemFree(acts);
        if (FAILED(hr)) { err = "ActivateObject"; return false; }

        ComPtr<IMFAttributes> at;
        if (SUCCEEDED(mft->GetAttributes(&at))) {
            UINT32 isAsync = 0;
            if (SUCCEEDED(at->GetUINT32(MF_TRANSFORM_ASYNC, &isAsync)) && isAsync) {
                async = true;
                at->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE);
            }
            if (!envOn("GLV_NOLL")) at->SetUINT32(MF_LOW_LATENCY, TRUE);
        }
        ctx = g.ctx.Get();
        {
            char* e = nullptr; size_t el = 0;
            memMode = false;
            if (_dupenv_s(&e, &el, "GLV_MEMFEED") == 0 && e) { memMode = e[0] == '1'; free(e); }
        }
        if (!memMode) {
            if (FAILED(MFCreateDXGIDeviceManager(&token, &dm)) || FAILED(dm->ResetDevice(g.dev.Get(), token))) { err = "DXGI device manager"; return false; }
            if (FAILED(mft->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, (ULONG_PTR)dm.Get()))) { err = "o codificador nao aceita texturas da placa"; return false; }
        } else {
            D3D11_TEXTURE2D_DESC rd{};
            rd.Width = w; rd.Height = h; rd.MipLevels = 1; rd.ArraySize = 1;
            rd.Format = DXGI_FORMAT_NV12;
            rd.SampleDesc.Count = 1;
            rd.Usage = D3D11_USAGE_STAGING;
            rd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            if (FAILED(g.dev->CreateTexture2D(&rd, nullptr, &readback))) { err = "textura NV12 de leitura"; return false; }
        }

        if (SUCCEEDED(mft.As(&api)) && !envOn("GLV_NOCAPI")) {
            setU4(api.Get(), CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR);
            setU4(api.Get(), CODECAPI_AVEncCommonMeanBitRate, bitrate);
            setBool(api.Get(), CODECAPI_AVLowLatencyMode, true);
            setU4(api.Get(), CODECAPI_AVEncMPVGOPSize, fps * 2);
            setU4(api.Get(), CODECAPI_AVEncMPVDefaultBPictureCount, 0);
            setU4(api.Get(), CODECAPI_AVEncCommonQualityVsSpeed, 50);
        }

        ComPtr<IMFMediaType> ot;
        MFCreateMediaType(&ot);
        ot->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        ot->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
        ot->SetUINT32(MF_MT_AVG_BITRATE, bitrate);
        ot->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
        if (!envOn("GLV_NOPROF")) ot->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High);
        MFSetAttributeSize(ot.Get(), MF_MT_FRAME_SIZE, w, h);
        MFSetAttributeRatio(ot.Get(), MF_MT_FRAME_RATE, fps, 1);
        MFSetAttributeRatio(ot.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
        if (FAILED(hr = mft->SetOutputType(0, ot.Get(), 0))) { err = "SetOutputType hr=" + std::to_string((long)hr); return false; }

        // usa o formato de entrada que o PROPRIO codificador oferece (o NVENC valida o tipo contra a placa)
        ComPtr<IMFMediaType> it;
        std::string offered;
        for (DWORD i = 0;; i++) {
            ComPtr<IMFMediaType> t;
            if (FAILED(mft->GetInputAvailableType(0, i, &t))) break;
            GUID sub{};
            t->GetGUID(MF_MT_SUBTYPE, &sub);
            char fcc[5] = { (char)(sub.Data1 & 0xff), (char)((sub.Data1 >> 8) & 0xff), (char)((sub.Data1 >> 16) & 0xff), (char)((sub.Data1 >> 24) & 0xff), 0 };
            offered += fcc;
            offered += " ";
            if (!it && sub == MFVideoFormat_NV12) it = t;
        }
        fprintf(stderr, "h264: formatos de entrada oferecidos: %s\n", offered.c_str());
        if (!it) {
            MFCreateMediaType(&it);
            it->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
            it->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
        }
        it->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
        MFSetAttributeSize(it.Get(), MF_MT_FRAME_SIZE, w, h);
        MFSetAttributeRatio(it.Get(), MF_MT_FRAME_RATE, fps, 1);
        MFSetAttributeRatio(it.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
        if (FAILED(hr = mft->SetInputType(0, it.Get(), 0))) { err = "SetInputType hr=" + std::to_string((long)hr); return false; }

        MFT_OUTPUT_STREAM_INFO osi{};
        mft->GetOutputStreamInfo(0, &osi);
        providesSamples = (osi.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;
        outSize = std::max<DWORD>(osi.cbSize, w * h);
        readSeqHeader();

        if (async && FAILED(mft.As(&gen))) { err = "sem gerador de eventos"; return false; }
        if (!envOn("GLV_NOFLUSH")) mft->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
        mft->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
        mft->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
        return true;
    }

    void readSeqHeader() {
        ComPtr<IMFMediaType> cur;
        if (FAILED(mft->GetOutputCurrentType(0, &cur))) return;
        UINT32 sz = 0;
        if (SUCCEEDED(cur->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER, &sz)) && sz > 0) {
            seqHeader.resize(sz);
            cur->GetBlob(MF_MT_MPEG_SEQUENCE_HEADER, seqHeader.data(), sz, nullptr);
        }
    }

    HRESULT feed(ID3D11Texture2D* tex, LONGLONG ts) {
        ComPtr<IMFMediaBuffer> buf;
        HRESULT hr = S_OK;
        if (memMode) {
            // copia so o NV12 ja convertido e reduzido (1,5 byte por pixel) da placa para a memoria
            ctx->CopyResource(readback.Get(), tex);
            D3D11_MAPPED_SUBRESOURCE mp{};
            if (FAILED(hr = ctx->Map(readback.Get(), 0, D3D11_MAP_READ, 0, &mp))) { if (!firstErr) { firstErr = hr; firstStage = 3; } return hr; }
            const DWORD size = w * h * 3 / 2;
            hr = MFCreateMemoryBuffer(size, &buf);
            BYTE* dst = nullptr;
            if (SUCCEEDED(hr) && SUCCEEDED(buf->Lock(&dst, nullptr, nullptr))) {
                const BYTE* src = (const BYTE*)mp.pData;
                for (UINT y = 0; y < h; y++) memcpy(dst + (size_t)y * w, src + (size_t)y * mp.RowPitch, w);
                const BYTE* uv = src + (size_t)mp.RowPitch * h;
                for (UINT y = 0; y < h / 2; y++) memcpy(dst + (size_t)w * h + (size_t)y * w, uv + (size_t)y * mp.RowPitch, w);
                buf->Unlock();
                buf->SetCurrentLength(size);
            }
            ctx->Unmap(readback.Get(), 0);
            if (FAILED(hr)) return hr;
        } else {
            hr = MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D), tex, 0, FALSE, &buf);
            if (FAILED(hr)) { if (!firstErr) { firstErr = hr; firstStage = 1; } return hr; }
            ComPtr<IMF2DBuffer> b2;
            DWORD clen = 0;
            if (SUCCEEDED(buf.As(&b2))) { b2->GetContiguousLength(&clen); buf->SetCurrentLength(clen); }
        }
        ComPtr<IMFSample> s;
        MFCreateSample(&s);
        s->AddBuffer(buf.Get());
        s->SetSampleTime(ts);
        s->SetSampleDuration(10000000LL / fps);
        // o NVENC pode ignorar o tamanho de GOP pedido: forca um quadro-chave a cada 2 s (recuperacao rapida)
        bool periodic = ts - lastKeyTs >= 20000000LL;
        if ((forceKey.exchange(false) || periodic) && api) {
            setU4(api.Get(), CODECAPI_AVEncVideoForceKeyFrame, 1);
            lastKeyTs = ts;
        }
        hr = mft->ProcessInput(0, s.Get(), 0);
        if (SUCCEEDED(hr)) inFrames++;
        else { feedErrors++; lastErr = hr; if (!firstErr) { firstErr = hr; firstStage = 2; } }
        return hr;
    }

    // chamado pela captura: entrega o quadro mais novo (o codificador nunca acumula atraso)
    void submit(ID3D11Texture2D* tex, LONGLONG ts) {
        submits++;
        std::lock_guard<std::mutex> lk(m);
        if (async) {
            if (needInput > 0) {
                if (SUCCEEDED(feed(tex, ts))) needInput--;
            } else {
                pending = tex;
                pendingTs = ts;
            }
        } else {
            if (SUCCEEDED(feed(tex, ts))) while (drainOne()) {}
        }
    }

    bool drainOne() {
        MFT_OUTPUT_DATA_BUFFER ob{};
        ob.dwStreamID = 0;
        ComPtr<IMFSample> own;
        if (!providesSamples) {
            MFCreateSample(&own);
            ComPtr<IMFMediaBuffer> b;
            MFCreateMemoryBuffer(outSize, &b);
            own->AddBuffer(b.Get());
            ob.pSample = own.Get();
        }
        DWORD status = 0;
        HRESULT hr = mft->ProcessOutput(0, 1, &ob, &status);
        if (ob.pEvents) ob.pEvents->Release();
        if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
            ComPtr<IMFMediaType> t;
            if (SUCCEEDED(mft->GetOutputAvailableType(0, 0, &t))) mft->SetOutputType(0, t.Get(), 0);
            readSeqHeader();
            return true;
        }
        if (FAILED(hr)) return false;
        IMFSample* s = ob.pSample;
        if (!s) return false;
        ComPtr<IMFMediaBuffer> cb;
        if (SUCCEEDED(s->ConvertToContiguousBuffer(&cb))) {
            BYTE* p = nullptr;
            DWORD len = 0;
            if (SUCCEEDED(cb->Lock(&p, nullptr, &len))) {
                UINT32 clean = 0;
                s->GetUINT32(MFSampleExtension_CleanPoint, &clean);
                LONGLONG ts = 0;
                s->GetSampleTime(&ts);
                bool key = clean != 0;
                if (key && !seqHeader.empty() && !hasSps(p, len)) {
                    std::vector<BYTE> joined(seqHeader);
                    joined.insert(joined.end(), p, p + len);
                    onOutput(true, ts, joined.data(), (DWORD)joined.size());
                } else {
                    onOutput(key, ts, p, len);
                }
                outFrames++;
                cb->Unlock();
            }
        }
        if (providesSamples && ob.pSample) ob.pSample->Release();
        return true;
    }

    static bool hasSps(const BYTE* p, DWORD len) {
        for (DWORD i = 0; i + 4 < len && i < 256; i++) {
            if (p[i] == 0 && p[i + 1] == 0 && (p[i + 2] == 1 || (p[i + 2] == 0 && p[i + 3] == 1))) {
                DWORD k = p[i + 2] == 1 ? i + 3 : i + 4;
                if ((p[k] & 0x1F) == 7) return true;
            }
        }
        return false;
    }

    // laco de eventos do codificador assincrono (NVENC e afins)
    void pump(std::atomic<bool>& running) {
        while (running) {
            ComPtr<IMFMediaEvent> ev;
            HRESULT hr = gen->GetEvent(0, &ev);
            if (!running) break;
            if (FAILED(hr)) { evErrors++; lastErr = hr; if (hr == MF_E_SHUTDOWN) break; Sleep(5); continue; }
            MediaEventType t = MEUnknown;
            ev->GetType(&t);
            events++;
            if (t == METransformNeedInput) needEv++;
            if (t == METransformHaveOutput) haveEv++;
            std::lock_guard<std::mutex> lk(m);
            if (t == METransformNeedInput) {
                if (pending) {
                    if (SUCCEEDED(feed(pending.Get(), pendingTs))) pending.Reset();
                    else needInput++;
                } else needInput++;
            } else if (t == METransformHaveOutput) {
                drainOne();
            }
        }
    }

    /** Faz o codificador soltar um evento para o laco bloqueado poder terminar. */
    void wake() {
        if (mft) mft->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
    }

    void close() {
        if (mft) {
            mft->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            mft->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            if (!memMode) mft->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, 0);
        }
        gen.Reset(); api.Reset(); mft.Reset(); dm.Reset();
    }
};


// ---------------------------------------------------------------- stream (frames on stdout)
// Each packet: uint8 type, uint32 little-endian length, payload. Logs go to stderr.
//   type 0 = JPEG video frame
//   type 1 = audio PCM (signed 16-bit little-endian, stereo)
//   type 2 = audio format: uint32 sample rate
//   type 3 = H.264 frame: uint8 keyframe, f64 timestamp (microseconds), Annex B bytes
//   type 4 = H.264 config: JSON text {codec,w,h,fps,encoder}

struct StreamOpts {
    HWND hwnd = nullptr;
    int monitor = -1;
    int fps = 30;
    UINT maxW = 0, maxH = 0;
    float quality = 0.8f;
    std::string cursor = "follow";
    DWORD pid = 0;          // audio only from this process tree
    DWORD excludePid = 0;   // or audio from everything except this process tree
    int threads = 3;
    int testDrop = 0;           // so para teste: ignora os N primeiros quadros capturados
    int testSizeBias = 0;       // so para teste: finge que o tamanho inicial era maior (simula janela que muda de tamanho)
    bool testNoReuse = false;   // so para teste: desliga o reaproveitamento do quadro
    bool h264 = false;          // comprimir na placa de video (H.264) em vez de JPEG
    UINT bitrate = 12000000;
};

static std::mutex g_outMtx;

static bool writePacket(uint8_t type, const BYTE* data, uint32_t len) {
    std::lock_guard<std::mutex> lk(g_outMtx);
    if (fwrite(&type, 1, 1, stdout) != 1 || fwrite(&len, 4, 1, stdout) != 1) return false;
    if (len && fwrite(data, 1, len, stdout) != len) return false;
    return fflush(stdout) == 0;
}

struct EncJob {
    uint64_t seq = 0;
    UINT w = 0, h = 0, ow = 0, oh = 0;
    std::vector<BYTE> px; // tightly packed BGRA, w*4 per row
};

static int runStream(StreamOpts o) {
    _setmode(_fileno(stdout), _O_BINARY);
    MFStartup(MF_VERSION);
    Gpu g;
    if (!makeGpu(g)) { fputs("ERRO: D3D11\n", stderr); return 3; }
    auto item = makeItem(o.hwnd, o.monitor);
    if (!item) { fputs("ERRO: fonte nao pode ser capturada\n", stderr); return 3; }
    auto size = item.Size();
    UINT W = size.Width + (UINT)o.testSizeBias, H = size.Height;
    ComPtr<ID3D11Texture2D> staging = makeStaging(g, W, H);

    std::atomic<bool> running{ true };
    item.Closed([&](auto&&, auto&&) { running = false; });

    // ---- H.264 pela placa de video: captura, conversao de cor e compressao sem sair da GPU
    UINT OW = 0, OH = 0;
    fitSize(W, H, o.maxW, o.maxH, OW, OH);
    GpuConverter conv;
    HwH264 enc;
    std::thread pumpThread;
    bool gpuMode = false;
    std::atomic<uint64_t> h264Bytes{ 0 };
    LONGLONG firstTs = -1;
    if (o.h264) {
        std::string err;
        if (conv.init(g, W, H, OW, OH, (UINT)o.fps, err) && enc.init(g, OW, OH, (UINT)o.fps, o.bitrate, err)) {
            gpuMode = true;
            enc.onOutput = [&](bool key, LONGLONG ts, const BYTE* p, DWORD len) {
                std::vector<BYTE> pk(9 + (size_t)len);
                pk[0] = key ? 1 : 0;
                double tsUs = ts / 10.0;
                memcpy(pk.data() + 1, &tsUs, 8);
                memcpy(pk.data() + 9, p, len);
                h264Bytes += len;
                if (!writePacket(3, pk.data(), (uint32_t)pk.size())) running = false;
            };
            char cfg[300];
            snprintf(cfg, sizeof cfg, "{\"codec\":\"h264\",\"w\":%u,\"h\":%u,\"fps\":%d,\"encoder\":\"%s\"}", OW, OH, o.fps, jsonEscape(enc.name).c_str());
            writePacket(4, (const BYTE*)cfg, (uint32_t)strlen(cfg));
            if (enc.async) pumpThread = std::thread([&] { winrt::init_apartment(winrt::apartment_type::multi_threaded); enc.pump(running); });
            fprintf(stderr, "h264: placa de video %s, codificador %s, %ux%u %d fps %u bps async=%d entrada=%s\n", g.adapterName.c_str(), enc.name.c_str(), OW, OH, o.fps, o.bitrate, (int)enc.async, enc.memMode ? "memoria" : "textura");
        } else {
            fprintf(stderr, "h264 indisponivel (%s), usando JPEG\n", err.c_str());
            enc.close();
        }
    }

    // ---- JPEG encoder pool (ordered output)
    std::mutex qMtx;
    std::condition_variable qCv;
    std::deque<EncJob> queue;
    uint64_t nextSeq = 0, nextWrite = 0;
    std::mutex wMtx;
    std::condition_variable wCv;
    std::atomic<uint64_t> encMicros{ 0 }, encCount{ 0 }, dropped{ 0 }, sent{ 0 }, audioBytes{ 0 };
    const size_t maxQueue = (size_t)std::max(2, o.threads);
    std::vector<std::thread> workers;
    for (int i = 0; i < std::max(1, o.threads); i++) {
        workers.emplace_back([&] {
            winrt::init_apartment(winrt::apartment_type::multi_threaded);
            for (;;) {
                EncJob j;
                {
                    std::unique_lock<std::mutex> lk(qMtx);
                    qCv.wait(lk, [&] { return !queue.empty() || !running; });
                    if (queue.empty()) return;
                    j = std::move(queue.front());
                    queue.pop_front();
                }
                double t0 = nowSec();
                std::vector<BYTE> jpg;
                bool ok = encodeJpeg(j.px.data(), j.w, j.h, j.w * 4, j.ow, j.oh, o.quality, jpg);
                encMicros += (uint64_t)((nowSec() - t0) * 1e6);
                encCount++;
                std::unique_lock<std::mutex> lk(wMtx);
                wCv.wait(lk, [&] { return nextWrite == j.seq || !running; });
                if (!running) return;
                if (ok && !writePacket(0, jpg.data(), (uint32_t)jpg.size())) running = false;
                else sent++;
                nextWrite++;
                wCv.notify_all();
            }
        });
    }

    std::mutex mtx;
    double lastEmit = 0;
    // ultimo quadro entregue ao codificador (para reenviar quando a janela fica parada)
    ID3D11Texture2D* lastNv12 = nullptr; // aponta para lastFrameTex
    ComPtr<ID3D11Texture2D> lastFrameTex; // copia do ultimo quadro ja convertido (mesmo tamanho de saida, nao muda com a janela)
    LONGLONG lastNv12Ts = 0;
    double lastSubmitAt = 0;
    bool testNoReuse = o.testNoReuse; // so para teste: comportamento antigo (descartar o quadro quando o tamanho muda)
    int testDrop = o.testDrop; // so para teste: ignora os primeiros quadros, simulando uma captura que nao entrega
    const double minGap = 1.0 / o.fps - 0.002;
    wgc::Direct3D11CaptureFramePool pool = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(g.d3d, wdx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
    pool.FrameArrived([&](wgc::Direct3D11CaptureFramePool const& sender, winrt::Windows::Foundation::IInspectable const&) {
        auto frame = sender.TryGetNextFrame();
        if (!frame || !running) return;
        std::lock_guard<std::mutex> lk(mtx);
        auto cs = frame.ContentSize();
        if (testDrop > 0) { testDrop--; return; }
        if ((UINT)cs.Width != W || (UINT)cs.Height != H) {
            if (cs.Width < 2 || cs.Height < 2) return;
            fprintf(stderr, "tamanho mudou %ux%u -> %ux%u\n", W, H, (UINT)cs.Width, (UINT)cs.Height);
            // o conversor vai ser recriado, mas o ultimo quadro continua guardado em lastFrameTex e segue sendo reenviado
            W = cs.Width; H = cs.Height;
            staging = makeStaging(g, W, H);
            if (gpuMode) { std::string e; conv.init(g, W, H, OW, OH, (UINT)o.fps, e); }
            // Janela parada nao manda outro quadro depois desta mudanca; se descartasse este, a live ficaria sem imagem ate
            // a janela mexer. Entao, se o quadro atual ja cobre o novo tamanho, ele e usado (recortado pelo conversor).
            if (gpuMode && !testNoReuse) {
                ComPtr<ID3D11Texture2D> mt;
                auto ma = frame.Surface().as<IDirect3DDxgiInterfaceAccess>();
                D3D11_TEXTURE2D_DESC md{};
                if (SUCCEEDED(ma->GetInterface(IID_PPV_ARGS(&mt)))) {
                    mt->GetDesc(&md);
                    {
                        // janela que diminuiu: o quadro cobre tudo; que cresceu: so tem o conteudo antigo (melhor que ficar sem imagem)
                        UINT uw = std::min(md.Width, (UINT)cs.Width), uh = std::min(md.Height, (UINT)cs.Height);
                        LONGLONG mts = frame.SystemRelativeTime().count();
                        if (firstTs < 0) firstTs = mts;
                        ID3D11Texture2D* mnv = conv.convert(g, mt.Get(), uw, uh);
                        if (mnv) {
                            if (!lastFrameTex) { D3D11_TEXTURE2D_DESC ld{}; mnv->GetDesc(&ld); g.dev->CreateTexture2D(&ld, nullptr, &lastFrameTex); }
                            if (lastFrameTex) { g.ctx->CopyResource(lastFrameTex.Get(), mnv); lastNv12 = lastFrameTex.Get(); }
                            lastNv12Ts = mts - firstTs; lastSubmitAt = nowSec(); lastEmit = lastSubmitAt;
                            enc.submit(mnv, mts - firstTs);
                            fprintf(stderr, "quadro aproveitado apos mudar o tamanho\n");
                        }
                    }
                }
            }
            pool.Recreate(g.d3d, wdx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, cs);
            return;
        }
        double now = nowSec();
        if (now - lastEmit < minGap) return;
        if (gpuMode) {
            lastEmit = now;
            ComPtr<ID3D11Texture2D> gtex;
            auto gaccess = frame.Surface().as<IDirect3DDxgiInterfaceAccess>();
            if (FAILED(gaccess->GetInterface(IID_PPV_ARGS(&gtex)))) return;
            LONGLONG ts = frame.SystemRelativeTime().count();
            if (firstTs < 0) firstTs = ts;
            ID3D11Texture2D* nv12 = conv.convert(g, gtex.Get(), (UINT)cs.Width, (UINT)cs.Height);
            if (nv12) {
                if (!lastFrameTex) { D3D11_TEXTURE2D_DESC ld{}; nv12->GetDesc(&ld); g.dev->CreateTexture2D(&ld, nullptr, &lastFrameTex); }
                if (lastFrameTex) { g.ctx->CopyResource(lastFrameTex.Get(), nv12); lastNv12 = lastFrameTex.Get(); }
                lastNv12Ts = ts - firstTs; lastSubmitAt = now;
                enc.submit(nv12, ts - firstTs);
            }
            return;
        }
        {
            std::lock_guard<std::mutex> qk(qMtx);
            if (queue.size() >= maxQueue) { dropped++; return; }
        }
        lastEmit = now;
        ComPtr<ID3D11Texture2D> tex;
        auto access = frame.Surface().as<IDirect3DDxgiInterfaceAccess>();
        if (FAILED(access->GetInterface(IID_PPV_ARGS(&tex)))) return;
        D3D11_TEXTURE2D_DESC td{};
        tex->GetDesc(&td);
        if (td.Width != W || td.Height != H) return;
        g.ctx->CopyResource(staging.Get(), tex.Get());
        D3D11_MAPPED_SUBRESOURCE m{};
        if (FAILED(g.ctx->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &m))) return;
        EncJob j;
        j.w = W; j.h = H;
        fitSize(W, H, o.maxW, o.maxH, j.ow, j.oh);
        j.px.resize((size_t)W * H * 4);
        for (UINT y = 0; y < H; y++) memcpy(j.px.data() + (size_t)y * W * 4, (const BYTE*)m.pData + (size_t)y * m.RowPitch, (size_t)W * 4);
        g.ctx->Unmap(staging.Get(), 0);
        {
            std::lock_guard<std::mutex> qk(qMtx);
            j.seq = nextSeq++;
            queue.push_back(std::move(j));
        }
        qCv.notify_one();
    });

    auto session = pool.CreateCaptureSession(item);
    bool follow = (o.cursor == "follow") && o.hwnd;
    bool cursorOn = (o.cursor == "always") || (o.cursor == "follow" && !o.hwnd);
    if (follow) cursorOn = isTargetFocused(o.hwnd);
    try { session.IsCursorCaptureEnabled(cursorOn); } catch (...) {}
    try { session.IsBorderRequired(false); } catch (...) {}

    // exit when the parent closes our stdin
    std::thread watchStdin([&] {
        HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
        char b[64];
        DWORD n = 0;
        while (running && ReadFile(in, b, sizeof b, &n, nullptr) && n > 0) {
            for (DWORD i = 0; i < n; i++) if (b[i] == 'K') enc.forceKey = true;
        }
        running = false;
    });
    watchStdin.detach();

    std::thread ct;
    if (follow) {
        ct = std::thread([&] {
            bool cur = cursorOn;
            while (running) {
                bool f = isTargetFocused(o.hwnd);
                if (f != cur) {
                    cur = f;
                    try { session.IsCursorCaptureEnabled(cur); } catch (...) {}
                }
                Sleep(30);
            }
        });
    }

    // ---- audio: only from the captured window's process tree (or everything except one process)
    std::thread at;
    if (o.pid || o.excludePid) {
        at = std::thread([&] {
            winrt::init_apartment(winrt::apartment_type::multi_threaded);
            ComPtr<IAudioClient> client;
            HRESULT hr = S_OK;
            uint32_t rate = 0;
            HANDLE evt = CreateEventW(nullptr, FALSE, FALSE, nullptr);
            for (uint32_t tryRate : { 48000u, 44100u }) {
                client = activateProcessLoopback(o.pid ? o.pid : o.excludePid, hr, o.pid == 0);
                if (!client) { fprintf(stderr, "audio: falha ao ativar (hr=0x%08lx)\n", (unsigned long)hr); continue; }
                WAVEFORMATEX fmt{ WAVE_FORMAT_PCM, 2, tryRate, tryRate * 4, 4, 16, 0 };
                hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 2000000, 0, &fmt, nullptr);
                if (SUCCEEDED(hr)) { rate = tryRate; break; }
                client.Reset();
            }
            ComPtr<IAudioCaptureClient> cap;
            if (!client || FAILED(client->GetService(IID_PPV_ARGS(&cap)))) { CloseHandle(evt); return; }
            client->SetEventHandle(evt);
            uint32_t r = rate;
            writePacket(2, (const BYTE*)&r, 4);
            client->Start();
            fprintf(stderr, "audio: %u Hz, %s\n", rate, o.pid ? "so o processo da janela" : "tudo menos o Discord");
            while (running) {
                WaitForSingleObject(evt, 100);
                UINT32 n = 0;
                while (SUCCEEDED(cap->GetNextPacketSize(&n)) && n > 0) {
                    BYTE* data = nullptr;
                    UINT32 frames = 0;
                    DWORD flags = 0;
                    if (FAILED(cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
                    size_t sz = (size_t)frames * 4;
                    if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                        std::vector<BYTE> z(sz, 0);
                        writePacket(1, z.data(), (uint32_t)sz);
                    } else {
                        writePacket(1, data, (uint32_t)sz);
                    }
                    audioBytes += sz;
                    cap->ReleaseBuffer(frames);
                }
            }
            client->Stop();
            CloseHandle(evt);
        });
    }

    // O Windows so entrega quadro quando a janela muda. Janela parada = nenhum quadro novo, e quem acabou de entrar
    // (ou pediu um quadro-chave) ficaria com a tela preta para sempre. Entao o ultimo quadro e reenviado: a cada 1 s
    // enquanto parada, ou em ~120 ms quando alguem pediu um quadro-chave.
    std::thread idleThread;
    if (gpuMode) {
        idleThread = std::thread([&] {
            while (running) {
                Sleep(60);
                {
                    std::lock_guard<std::mutex> lk(mtx);
                    if (!running) break;
                    double now = nowSec();
                    if (lastNv12) {
                        double idle = now - lastSubmitAt;
                        if (idle >= (enc.forceKey.load() ? 0.12 : 1.0)) {
                            lastNv12Ts += (LONGLONG)(idle * 1e7);
                            lastSubmitAt = now;
                            enc.submit(lastNv12, lastNv12Ts);
                        }
                    }
                }
            }
        });
    }

    session.StartCapture();
    fprintf(stderr, "stream iniciado %ux%u fps=%d threads=%d\n", W, H, o.fps, o.threads);
    double lastStat = nowSec();
    uint64_t lastSent = 0, lastEnc = 0, lastEncUs = 0;
    while (running) {
        Sleep(50);
        double now = nowSec();
        if (now - lastStat >= 2.0) {
            uint64_t s = sent, e = encCount, us = encMicros;
            if (gpuMode) fprintf(stderr, "stat h264 sub=%llu ev=%llu need=%llu have=%llu everr=%llu feederr=%llu first=0x%08lx@%d hr=0x%08lx in=%llu out=%llu kB=%llu\n", (unsigned long long)enc.submits.load(), (unsigned long long)enc.events.load(), (unsigned long long)enc.needEv.load(), (unsigned long long)enc.haveEv.load(), (unsigned long long)enc.evErrors.load(), (unsigned long long)enc.feedErrors.load(), (unsigned long)enc.firstErr.load(), enc.firstStage.load(), (unsigned long)enc.lastErr.load(), (unsigned long long)enc.inFrames.load(), (unsigned long long)enc.outFrames.load(), (unsigned long long)(h264Bytes.load() / 1024));
            fprintf(stderr, "stat fps=%.1f enc=%.1fms dropped=%llu audioKB=%llu\n",
                (s - lastSent) / (now - lastStat), e > lastEnc ? (double)(us - lastEncUs) / (e - lastEnc) / 1000.0 : 0.0,
                (unsigned long long)dropped.load(), (unsigned long long)(audioBytes.load() / 1024));
            lastStat = now; lastSent = s; lastEnc = e; lastEncUs = us;
        }
    }
    qCv.notify_all();
    wCv.notify_all();
    try { session.Close(); } catch (...) {}
    try { pool.Close(); } catch (...) {}
    if (ct.joinable()) ct.join();
    if (at.joinable()) at.join();
    if (idleThread.joinable()) idleThread.join();
    if (pumpThread.joinable()) {
        enc.wake();
        // se mesmo assim nao houver evento, nao trava o encerramento
        for (int i = 0; i < 100 && pumpThread.joinable(); i++) {
            DWORD rc = WaitForSingleObject(pumpThread.native_handle(), 20);
            if (rc == WAIT_OBJECT_0) { pumpThread.join(); break; }
            enc.wake();
        }
        if (pumpThread.joinable()) pumpThread.detach();
    }
    enc.close();
    for (auto& w : workers) if (w.joinable()) w.join();
    return 0;
}


static int cmdGpus() {
    ComPtr<IDXGIFactory1> fac;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&fac)))) return 1;
    ComPtr<IDXGIAdapter1> a;
    for (UINT i = 0; fac->EnumAdapters1(i, &a) != DXGI_ERROR_NOT_FOUND; i++, a.Reset()) {
        DXGI_ADAPTER_DESC1 d{};
        a->GetDesc1(&d);
        int outs = 0;
        ComPtr<IDXGIOutput> o;
        for (UINT k = 0; a->EnumOutputs(k, &o) != DXGI_ERROR_NOT_FOUND; k++, o.Reset()) outs++;
        printf("%u: %s | vendor %04x | VRAM %llu MB | saidas %d | software %d\n", i, toUtf8(d.Description).c_str(), d.VendorId, (unsigned long long)(d.DedicatedVideoMemory >> 20), outs, (int)((d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0));
    }
    return 0;
}


// Teste: o Windows (SinkWriter) configura sozinho o codificador por hardware. Diz se o NVENC funciona neste PC.
static int cmdHwTest(const std::wstring& path) {
    MFStartup(MF_VERSION);
    ComPtr<IMFAttributes> at;
    MFCreateAttributes(&at, 3);
    at->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
    at->SetUINT32(MF_SINK_WRITER_DISABLE_THROTTLING, TRUE);
    at->SetUINT32(MF_LOW_LATENCY, TRUE);
    ComPtr<IMFSinkWriter> sw;
    HRESULT hr = MFCreateSinkWriterFromURL(path.c_str(), nullptr, at.Get(), &sw);
    if (FAILED(hr)) { printf("ERRO SinkWriter 0x%08lx\n", (unsigned long)hr); return 2; }
    const UINT W = 1920, H = 1080, F = 60;
    ComPtr<IMFMediaType> out;
    MFCreateMediaType(&out);
    out->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    out->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
    out->SetUINT32(MF_MT_AVG_BITRATE, 12000000);
    out->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    MFSetAttributeSize(out.Get(), MF_MT_FRAME_SIZE, W, H);
    MFSetAttributeRatio(out.Get(), MF_MT_FRAME_RATE, F, 1);
    MFSetAttributeRatio(out.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    DWORD stream = 0;
    if (FAILED(hr = sw->AddStream(out.Get(), &stream))) { printf("ERRO AddStream 0x%08lx\n", (unsigned long)hr); return 2; }
    ComPtr<IMFMediaType> in;
    MFCreateMediaType(&in);
    in->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    in->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    in->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    MFSetAttributeSize(in.Get(), MF_MT_FRAME_SIZE, W, H);
    MFSetAttributeRatio(in.Get(), MF_MT_FRAME_RATE, F, 1);
    MFSetAttributeRatio(in.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    if (FAILED(hr = sw->SetInputMediaType(stream, in.Get(), nullptr))) { printf("ERRO SetInputMediaType 0x%08lx\n", (unsigned long)hr); return 2; }
    if (FAILED(hr = sw->BeginWriting())) { printf("ERRO BeginWriting 0x%08lx\n", (unsigned long)hr); return 2; }
    std::string name = "?";
    ComPtr<IMFSinkWriterEx> swx;
    if (SUCCEEDED(sw.As(&swx))) {
        for (DWORD i = 0;; i++) {
            GUID cat{};
            ComPtr<IMFTransform> t;
            if (FAILED(swx->GetTransformForStream(stream, i, &cat, &t))) break;
            ComPtr<IMFAttributes> ta;
            WCHAR* fn = nullptr;
            UINT32 fl = 0;
            if (t && SUCCEEDED(t->GetAttributes(&ta)) && SUCCEEDED(ta->GetAllocatedString(MFT_FRIENDLY_NAME_Attribute, &fn, &fl))) { name = toUtf8(fn); CoTaskMemFree(fn); }
            else name = (cat == MFT_CATEGORY_VIDEO_ENCODER) ? "codificador sem nome (provavelmente software)" : name;
        }
    }
    std::vector<BYTE> frame((size_t)W * H * 3 / 2, 128);
    double t0 = nowSec();
    int ok = 0;
    HRESULT firstFail = S_OK;
    for (int n = 0; n < 240; n++) {
        for (UINT y = 0; y < H; y++) memset(frame.data() + (size_t)y * W, (int)((y + n * 7) & 255), W);
        ComPtr<IMFMediaBuffer> b;
        MFCreateMemoryBuffer((DWORD)frame.size(), &b);
        BYTE* p = nullptr;
        b->Lock(&p, nullptr, nullptr);
        memcpy(p, frame.data(), frame.size());
        b->Unlock();
        b->SetCurrentLength((DWORD)frame.size());
        ComPtr<IMFSample> smp;
        MFCreateSample(&smp);
        smp->AddBuffer(b.Get());
        smp->SetSampleTime((LONGLONG)n * 10000000 / F);
        smp->SetSampleDuration(10000000 / F);
        hr = sw->WriteSample(stream, smp.Get());
        if (SUCCEEDED(hr)) ok++;
        else if (firstFail == S_OK) firstFail = hr;
    }
    hr = sw->Finalize();
    double el = nowSec() - t0;
    printf("codificador: %s\nquadros aceitos: %d de 240, erro inicial 0x%08lx, finalize 0x%08lx\nvelocidade: %.0f quadros/s (1080p)\n", name.c_str(), ok, (unsigned long)firstFail, (unsigned long)hr, 240 / el);
    MFShutdown();
    return 0;
}

// ---------------------------------------------------------------- main

static std::wstring timestampDir() {
    SYSTEMTIME t;
    GetLocalTime(&t);
    wchar_t b[MAX_PATH];
    swprintf_s(b, L"captures\\%04d-%02d-%02d_%02d-%02d-%02d", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond);
    return b;
}

static int cmdInteractive() {
    cmdList(false);
    say("\nDigite o numero da janela (ex: 3) ou do monitor (ex: m1) e Enter: ");
    char line[64] = {};
    if (!fgets(line, sizeof line, stdin)) return 1;
    Options o;
    o.out = timestampDir();
    if (line[0] == 'm' || line[0] == 'M') {
        o.monitor = atoi(line + 1) - 1;
    } else {
        int idx = atoi(line) - 1;
        auto ws = listWindows();
        if (idx < 0 || idx >= (int)ws.size()) { say("Numero invalido.\n"); return 1; }
        o.hwnd = ws[idx].hwnd;
    }
    say("Quantos segundos gravar? (Enter = 10): ");
    if (fgets(line, sizeof line, stdin) && atoi(line) > 0) o.seconds = atoi(line); else o.seconds = 10;
    say("Para testar o cursor: depois de dar Enter, troque de janela (Alt+Tab) algumas vezes.\n");
    say("Comecando em 3 segundos...\n");
    Sleep(3000);
    return runCapture(o);
}

// Informa onde a janela (ou tela) transmitida esta, em pixels fisicos, uma linha JSON a cada mudanca.
// A janela transparente de marcacoes usa isso para ficar exatamente sobre a imagem que os espectadores veem.
static int cmdRect(HWND hwnd, int monitor) {
    std::thread([] { char b[64]; while (fread(b, 1, sizeof b, stdin) > 0) {} ExitProcess(0); }).detach();
    std::string last;
    for (;;) {
        char b[160];
        bool gone = false;
        if (hwnd) {
            if (!IsWindow(hwnd)) gone = true;
            else {
                RECT rc{};
                int cloaked = 0;
                DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof cloaked);
                // jogos em tela cheia as vezes nao devolvem os limites do DWM: cai para o retangulo normal da janela
                bool gotRect = SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &rc, sizeof rc)) || GetWindowRect(hwnd, &rc);
                if (IsIconic(hwnd) || !IsWindowVisible(hwnd) || cloaked || !gotRect || rc.right - rc.left < 2)
                    snprintf(b, sizeof b, "{\"hidden\":1}\n");
                else
                    snprintf(b, sizeof b, "{\"x\":%ld,\"y\":%ld,\"w\":%ld,\"h\":%ld}\n", rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top);
            }
        } else {
            auto ms = listMonitors();
            if (monitor < 0 || monitor >= (int)ms.size()) gone = true;
            else {
                const RECT& rc = ms[monitor].rc;
                snprintf(b, sizeof b, "{\"x\":%ld,\"y\":%ld,\"w\":%ld,\"h\":%ld}\n", rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top);
            }
        }
        if (gone) { fputs("{\"gone\":1}\n", stdout); fflush(stdout); return 0; }
        if (last != b) { last = b; fputs(b, stdout); fflush(stdout); }
        Sleep(hwnd ? 50 : 1000);
    }
}

int wmain(int argc, wchar_t** argv) {
    SetConsoleOutputCP(CP_UTF8);
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    if (argc < 2) { say("uso: golive-helper list | capture ... | interactive\n"); return 1; }
    std::wstring cmd = argv[1];
    if (cmd == L"list") {
        bool json = false, all = false;
        for (int i = 2; i < argc; i++) { std::wstring a = argv[i]; if (a == L"--json") json = true; else if (a == L"--all") all = true; }
        return cmdList(json, all), 0;
    }
    if (cmd == L"thumbs") {
        std::wstring out = L"thumbs";
        UINT tw = 320;
        std::wstring only = L"";
        bool icons = true;
        for (int i = 2; i < argc; i++) {
            std::wstring a = argv[i];
            if (a == L"--out" && i + 1 < argc) out = argv[++i];
            else if (a == L"--w" && i + 1 < argc) tw = (UINT)_wtoi(argv[++i]);
            else if (a == L"--only" && i + 1 < argc) only = argv[++i];
            else if (a == L"--icons" && i + 1 < argc) icons = _wtoi(argv[++i]) != 0;
        }
        return cmdThumbs(out, tw, only != L"m", only != L"w", icons);
    }
    if (cmd == L"stream") {
        StreamOpts o;
        for (int i = 2; i < argc; i++) {
            std::wstring a = argv[i];
            auto next = [&]() -> std::wstring { return i + 1 < argc ? argv[++i] : L""; };
            if (a == L"--hwnd") o.hwnd = (HWND)(uintptr_t)_wtoi64(next().c_str());
            else if (a == L"--monitor") o.monitor = _wtoi(next().c_str());
            else if (a == L"--fps") o.fps = std::max(1, std::min(120, _wtoi(next().c_str())));
            else if (a == L"--maxw") o.maxW = (UINT)_wtoi(next().c_str());
            else if (a == L"--maxh") o.maxH = (UINT)_wtoi(next().c_str());
            else if (a == L"--quality") o.quality = (float)_wtoi(next().c_str()) / 100.0f;
            else if (a == L"--pid") o.pid = (DWORD)_wtoi(next().c_str());
            else if (a == L"--exclude-pid") o.excludePid = (DWORD)_wtoi(next().c_str());
            else if (a == L"--threads") o.threads = std::max(1, std::min(8, _wtoi(next().c_str())));
            else if (a == L"--codec") o.h264 = next() == L"h264";
            else if (a == L"--bitrate") o.bitrate = (UINT)_wtoi(next().c_str());
            else if (a == L"--cursor") o.cursor = toUtf8(next());
            else if (a == L"--test-drop") o.testDrop = _wtoi(next().c_str());
            else if (a == L"--test-size-bias") o.testSizeBias = _wtoi(next().c_str());
            else if (a == L"--test-no-reuse") o.testNoReuse = true;
        }
        return runStream(o);
    }
    if (cmd == L"rect") {
        HWND hw = nullptr;
        int mon = 0;
        for (int i = 2; i < argc; i++) {
            std::wstring a = argv[i];
            if (a == L"--hwnd" && i + 1 < argc) hw = (HWND)(uintptr_t)_wtoi64(argv[++i]);
            else if (a == L"--monitor" && i + 1 < argc) mon = _wtoi(argv[++i]);
        }
        return cmdRect(hw, mon);
    }
    if (cmd == L"audio-sessions") {
        DWORD root = 0;
        for (int i = 2; i < argc; i++) { std::wstring a = argv[i]; if (a == L"--root" && i + 1 < argc) root = (DWORD)_wtoi(argv[++i]); }
        return cmdAudioSessions(root);
    }
    if (cmd == L"gpus") return cmdGpus();
    if (cmd == L"hwtest") return cmdHwTest(argc > 2 ? argv[2] : L"hwtest.mp4");
    if (cmd == L"interactive") return cmdInteractive();
    if (cmd == L"capture") {
        Options o;
        o.out = timestampDir();
        for (int i = 2; i < argc; i++) {
            std::wstring a = argv[i];
            auto next = [&]() -> std::wstring { return i + 1 < argc ? argv[++i] : L""; };
            if (a == L"--hwnd") o.hwnd = (HWND)(uintptr_t)_wtoi64(next().c_str());
            else if (a == L"--title") o.title = next();
            else if (a == L"--monitor") o.monitor = _wtoi(next().c_str());
            else if (a == L"--pid") o.pid = (DWORD)_wtoi(next().c_str());
            else if (a == L"--seconds") o.seconds = _wtoi(next().c_str());
            else if (a == L"--fps") o.fps = std::max(1, std::min(120, _wtoi(next().c_str())));
            else if (a == L"--cursor") o.cursor = toUtf8(next());
            else if (a == L"--out") o.out = next();
        }
        return runCapture(o);
    }
    say("comando desconhecido\n");
    return 1;
}
