import { CogWheel } from "@components/Icons";
import { copyWithToast } from "@utils/discord";
import { ModalRoot, ModalSize, openModal } from "@utils/modal";
import { showNotice } from "@api/Notices";
import definePlugin, { PluginNative } from "@utils/types";
import { ContextMenuApi, Menu, ScrollerThin, SelectedChannelStore, useEffect, useRef, useState } from "@webpack/common";

import { getWatchUrl, startManager, stopManager } from "./manager";
import { getLiveEntry } from "./nativeUi";
import { CursorMode, getLive, listCameras, LiveSource, PRESETS, Preset, sourcesApi } from "./live";

const Native = VencordNative.pluginHelpers.GoLiveP2P as PluginNative<typeof import("./native")>;
let updateTimer: ReturnType<typeof setInterval> | undefined;
let updateShown = "";

// avisa uma vez quando uma versao nova ja foi baixada (ela entra em uso quando o Discord abrir de novo)
async function checkUpdateReady() {
    const u = await Native.updateStatus().catch(() => null);
    if (!u?.ready || u.ready === updateShown) return;
    updateShown = u.ready;
    showNotice(`GoLive P2P ${u.ready} foi baixado. Ele passa a valer da proxima vez que voce fechar e abrir o Discord.`, "OK", () => { });
}

type Tab = "apps" | "screens" | "devices";

interface Sources {
    windows: { hwnd: number; pid: number; title: string; exe: string; w: number; h: number; thumb: string | null; icon: string | null; }[];
    monitors: { index: number; w: number; h: number; primary: boolean; thumb: string | null; }[];
}

const c = {
    strong: "var(--text-strong, #ffffff)",
    text: "var(--text-default, #dbdee1)",
    muted: "var(--text-muted, #949ba4)",
    brand: "var(--brand-500, #5865f2)",
    bar: "var(--background-base-lowest, #1e1f22)",
    card: "var(--background-modifier-hover, #2b2d31)",
    sel: "var(--background-modifier-selected, #35373c)"
};

const PRESET_LABEL: Record<Preset, string> = {
    games: "Jogos",
    screen: "Compartilhamento de tela",
    custom: "Personalizada"
};

const RES_OPTIONS = [
    { label: "480p", value: 480 },
    { label: "720p", value: 720 },
    { label: "1080p", value: 1080 },
    { label: "1440p", value: 1440 },
    { label: "Fonte", value: 0 }
];
const FPS_OPTIONS = [15, 30, 60];
const CURSOR_OPTIONS: { label: string; value: CursorMode; }[] = [
    { label: "Aparecer só com a janela em foco", value: "follow" },
    { label: "Sempre visível", value: "always" },
    { label: "Nunca", value: "never" }
];

function useLive() {
    const live = getLive();
    const [, force] = useState(0);
    useEffect(() => live.subscribe(() => force(n => n + 1)), []);
    return live;
}

const svgProps = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "currentColor" } as const;
const WindowIcon = () => <svg {...svgProps}><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 3v2h14V6H5Z" /></svg>;
const MonitorIcon = () => <svg {...svgProps}><path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6v2h3v2H7v-2h3v-2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" /></svg>;
const CameraIcon = () => <svg {...svgProps}><path d="M4 6h10a2 2 0 0 1 2 2v1.5l5-3v11l-5-3V16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" /></svg>;

function Preview() {
    const live = getLive();
    const box = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = box.current;
        if (!el) return;
        live.canvas.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;background:#000";
        el.appendChild(live.canvas);
        return () => { if (live.canvas.parentElement === el) el.removeChild(live.canvas); };
    }, []);
    return <div ref={box} style={{ height: 120, background: "#000", borderRadius: 8, overflow: "hidden", flexShrink: 0 }} />;
}

function SourceCard({ title, icon, thumb, fallback, onShare }: { title: string; icon?: string | null; thumb: string | null; fallback?: React.ReactNode; onShare: () => void; }) {
    const [hover, setHover] = useState(false);
    return (
        <div
            onClick={onShare}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            style={{ cursor: "pointer", minWidth: 0 }}
        >
            <div
                style={{
                    position: "relative", aspectRatio: "16 / 9", background: "#000", borderRadius: 8, overflow: "hidden",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    boxShadow: hover ? `inset 0 0 0 2px ${c.sel}` : "none"
                }}
            >
                {thumb
                    ? <img src={thumb} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                    : <span style={{ color: c.muted }}>{fallback ?? "sem miniatura"}</span>}
                {hover && (
                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.35)" }}>
                        <div style={{ background: "#fff", color: "#060607", fontWeight: 500, fontSize: 14, padding: "9px 18px", borderRadius: 4 }}>
                            Compartilhar tela
                        </div>
                    </div>
                )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, color: c.strong, fontSize: 14, fontWeight: 600, minWidth: 0 }}>
                {icon && <img src={icon} style={{ width: 20, height: 20, borderRadius: 4, flexShrink: 0 }} />}
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={title}>{title}</span>
            </div>
        </div>
    );
}

function GearMenu() {
    const live = useLive();
    const p = live.prefs;
    return (
        <Menu.Menu navId="golive-p2p-quality" onClose={ContextMenuApi.closeContextMenu} aria-label="Modo de transmissão">
            <Menu.MenuGroup label="Modo de transmissão">
                <Menu.MenuRadioItem
                    group="golive-mode" id="mode-games" label="Jogos" subtext="Vídeo mais suave (1440p, 60fps)"
                    checked={p.preset === "games"}
                    action={() => live.setPrefs({ preset: "games", ...PRESETS.games })}
                />
                <Menu.MenuRadioItem
                    group="golive-mode" id="mode-screen" label="Compartilhamento de tela" subtext="Texto mais claro (Fonte, 15fps)"
                    checked={p.preset === "screen"}
                    action={() => live.setPrefs({ preset: "screen", ...PRESETS.screen })}
                />
                <Menu.MenuRadioItem
                    group="golive-mode" id="mode-custom" label="Personalizada"
                    checked={p.preset === "custom"}
                    action={() => live.setPrefs({ preset: "custom" })}
                />
            </Menu.MenuGroup>
            <Menu.MenuSeparator />
            <Menu.MenuGroup>
                <Menu.MenuItem id="golive-res" label="Resolução da tela">
                    {RES_OPTIONS.map(o => (
                        <Menu.MenuRadioItem
                            key={o.value} group="golive-res-g" id={"res-" + o.value} label={o.label}
                            checked={p.maxH === o.value}
                            action={() => live.setPrefs({ preset: "custom", maxH: o.value })}
                        />
                    ))}
                </Menu.MenuItem>
                <Menu.MenuItem id="golive-fps" label="Taxa de quadros">
                    {FPS_OPTIONS.map(f => (
                        <Menu.MenuRadioItem
                            key={f} group="golive-fps-g" id={"fps-" + f} label={f + "fps"}
                            checked={p.fps === f}
                            action={() => live.setPrefs({ preset: "custom", fps: f })}
                        />
                    ))}
                </Menu.MenuItem>
            </Menu.MenuGroup>
            {live.running && (
                <>
                    <Menu.MenuSeparator />
                    <Menu.MenuItem
                        id="golive-copy-link"
                        label="Copiar link para assistir no navegador"
                        action={() => copyWithToast(getWatchUrl() || "Link ainda nao disponivel", "Link copiado!")}
                    />
                </>
            )}
            <Menu.MenuSeparator />
            <Menu.MenuGroup>
                <Menu.MenuCheckboxItem
                    id="golive-mute" label="Silenciar áudio da transmissão"
                    checked={p.muteAudio}
                    action={() => live.setPrefs({ muteAudio: !p.muteAudio })}
                />
                <Menu.MenuCheckboxItem
                    id="golive-marks" label="Permitir ping e desenho dos espectadores"
                    checked={p.allowMarks}
                    action={() => live.setPrefs({ allowMarks: !p.allowMarks })}
                />
                <Menu.MenuItem id="golive-advanced" label="Avançado">
                    <Menu.MenuGroup label="Cursor na transmissão">
                        {CURSOR_OPTIONS.map(o => (
                            <Menu.MenuRadioItem
                                key={o.value} group="golive-cursor" id={"cursor-" + o.value} label={o.label}
                                checked={p.cursor === o.value}
                                action={() => live.setPrefs({ cursor: o.value })}
                            />
                        ))}
                    </Menu.MenuGroup>
                </Menu.MenuItem>
            </Menu.MenuGroup>
        </Menu.Menu>
    );
}

function LiveModal({ modalProps }: { modalProps: any; }) {
    const live = useLive();
    const [tab, setTab] = useState<Tab>("apps");
    const [sources, setSources] = useState<Sources | null>(null);
    const [cameras, setCameras] = useState<{ deviceId: string; label: string; }[]>([]);
    const [loadError, setLoadError] = useState("");

    const busy = useRef(false);
    const needIcons = useRef(false);

    useEffect(() => {
        sourcesApi.get().then(s => setSources(s as Sources)).catch(e => setLoadError(String(e)));
        listCameras().then(setCameras);
    }, []);

    // Miniaturas ao vivo: a cada 2 s, so da aba visivel e so com a janela de selecao aberta
    useEffect(() => {
        if (tab === "devices") return;
        const only = tab === "apps" ? "w" : "m";
        const id = setInterval(async () => {
            if (busy.current || document.hidden) return;
            busy.current = true;
            try {
                const icons = needIcons.current;
                needIcons.current = false;
                const s = await sourcesApi.get({ only, icons }) as Sources;
                setSources(prev => {
                    if (!prev) return s;
                    if (only === "m") return { ...prev, monitors: s.monitors };
                    const known = new Map(prev.windows.map(w => [w.hwnd, w.icon]));
                    return {
                        ...prev,
                        windows: s.windows.map(w => {
                            if (!known.has(w.hwnd) && !icons) needIcons.current = true;
                            return { ...w, icon: w.icon ?? known.get(w.hwnd) ?? null };
                        })
                    };
                });
            } catch { } finally {
                busy.current = false;
            }
        }, 2000);
        return () => clearInterval(id);
    }, [tab]);

    const share = (src: LiveSource) => {
        live.start(src);
        modalProps.onClose();
    };

    const p = live.prefs;
    const resLabel = RES_OPTIONS.find(r => r.value === p.maxH)?.label ?? "";

    const tabEl = (id: Tab, label: string, icon: React.ReactNode) => (
        <div
            onClick={() => setTab(id)}
            style={{
                flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 0",
                cursor: "pointer", borderRadius: 6, fontWeight: 500,
                background: tab === id ? c.sel : "transparent", color: tab === id ? c.strong : c.muted
            }}
        >
            {icon}{label}
        </div>
    );

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "min(720px, 86vh)", padding: "16px 16px 12px" }}>
                    {live.running && (
                        <div>
                            <Preview />
                            <div style={{ color: c.muted, fontSize: 12, marginTop: 6 }}>
                                {live.source?.label} · {live.canvas.width}x{live.canvas.height} · {live.realFps} quadros/s
                            </div>
                        </div>
                    )}
                    {live.error && <div style={{ color: "#f23f43" }}>Erro: {live.error}</div>}

                    <div style={{ display: "flex", gap: 4, background: c.bar, padding: 4, borderRadius: 8 }}>
                        {tabEl("apps", "Aplicativos", <WindowIcon />)}
                        {tabEl("screens", "Tela Inteira", <MonitorIcon />)}
                        {tabEl("devices", "Dispositivos", <CameraIcon />)}
                    </div>

                    {tab !== "devices" && !sources && !loadError && <div style={{ color: c.muted }}>Carregando janelas e miniaturas...</div>}
                    {loadError && <div style={{ color: "#f23f43" }}>Não consegui listar as fontes: {loadError}</div>}

                    <ScrollerThin style={{ flex: 1, minHeight: 0 }} fade orientation="vertical">
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gridAutoRows: "max-content", gap: 20, paddingRight: 12 }}>
                        {tab === "apps" && sources?.windows.map(w => (
                            <SourceCard
                                key={w.hwnd} title={w.title} icon={w.icon} thumb={w.thumb}
                                onShare={() => share({ kind: "window", hwnd: w.hwnd, pid: w.pid, label: w.title })}
                            />
                        ))}
                        {tab === "screens" && sources?.monitors.map(m => (
                            <SourceCard
                                key={m.index} title={`Tela ${m.index + 1}${m.primary ? " (principal)" : ""}`} thumb={m.thumb}
                                icon={null}
                                onShare={() => share({ kind: "monitor", monitor: m.index, label: `Tela ${m.index + 1}` })}
                            />
                        ))}
                        {tab === "devices" && cameras.map(d => (
                            <SourceCard
                                key={d.deviceId} title={d.label} thumb={null} fallback={<CameraIcon />}
                                onShare={() => share({ kind: "camera", deviceId: d.deviceId, label: d.label })}
                            />
                        ))}
                    </div>
                    {tab === "devices" && cameras.length === 0 && <div style={{ color: c.muted }}>Nenhuma câmera encontrada.</div>}
                    </ScrollerThin>

                    <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ color: c.strong, fontSize: 16, fontWeight: 700 }}>{PRESET_LABEL[p.preset]}</div>
                            <div style={{ color: c.muted, fontSize: 12 }}>· {resLabel} · {p.fps}fps</div>
                        </div>
                        {live.running && (
                            <div
                                onClick={() => { live.stop(); modalProps.onClose(); }}
                                style={{ cursor: "pointer", background: "#da373c", color: "#fff", fontWeight: 500, padding: "9px 16px", borderRadius: 4, marginRight: 10 }}
                            >
                                Parar de transmitir
                            </div>
                        )}
                        <div
                            onClick={e => ContextMenuApi.openContextMenu(e, () => <GearMenu />)}
                            style={{ cursor: "pointer", width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", background: c.card, color: c.strong, borderRadius: 8 }}
                            title="Qualidade da transmissão"
                        >
                            <CogWheel width={22} height={22} />
                        </div>
                    </div>
            </div>
        </ModalRoot>
    );
}

// Aviso "AO VIVO" sempre visivel enquanto a live esta ativa (sera substituido pelo HUD nativo na proxima etapa)
let pill: HTMLDivElement | null = null;
let unsub: (() => void) | null = null;

function updatePill() {
    const live = getLive();
    if (!pill) return;
    // dentro de uma chamada o proprio Discord mostra o selo e o quadro; o aviso so aparece fora dela
    if (!live.running || SelectedChannelStore.getVoiceChannelId()) { pill.style.display = "none"; return; }
    pill.style.display = "flex";
    (pill.children[1] as HTMLElement).textContent = live.source?.label ?? "";
}

function createPill() {
    pill = document.createElement("div");
    pill.style.cssText = "position:fixed;top:36px;left:50%;transform:translateX(-50%);z-index:99999;display:none;align-items:center;gap:8px;background:var(--background-base-lowest,#1e1f22);color:var(--text-default,#dbdee1);font:500 13px var(--font-primary,sans-serif);padding:4px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.5);cursor:pointer;max-width:50vw";
    const badge = document.createElement("span");
    badge.textContent = "AO VIVO";
    badge.style.cssText = "background:#ed4245;color:#fff;font-size:11px;font-weight:700;letter-spacing:.03em;padding:2px 6px;border-radius:4px";
    const label = document.createElement("span");
    label.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:30vw";
    const stop = document.createElement("span");
    stop.textContent = "Parar";
    stop.style.cssText = "background:var(--background-modifier-hover,#2b2d31);padding:3px 8px;border-radius:4px;font-weight:600";
    stop.onclick = e => { e.stopPropagation(); getLive().stop(); };
    pill.append(badge, label, stop);
    pill.onclick = () => openModal(props => <LiveModal modalProps={props} />);
    document.body.appendChild(pill);
    unsub = getLive().subscribe(updatePill);
    updatePill();
}

export default definePlugin({
    name: "GoLiveP2P",
    description: "Troca o botao de Go Live por uma live P2P propria",
    authors: [{ name: "local", id: 0n }],
    enabledByDefault: true,

    patches: [
        {
            // Menu nativo "Qualidade da transmissao" (botao verde, painel de baixo, engrenagem do quadro).
            // Sem fonte nativa ele nao fazia nada, e opcoes de Nitro abriam a tela de assinatura: com a nossa live
            // ligada, a escolha vai direto para ela.
            find: "useStreamSettingsItems",
            all: true,
            replacement: {
                match: /useCallback\(\((\i),(\i),(\i),(\i)\)=>\{if\(\1\)\{if\(null!=(\i)\)\{(?=let \i=\{qualityOptions)/,
                replace: "useCallback(($1,$2,$3,$4)=>{if($self.onNativeQuality($2,$3))return;if($1){if(null!=$5){"
            }
        },
        {
            // Modulo do seletor de Go Live (exporta "default" e usa GO_LIVE_MODAL_SETTINGS_SELECTION).
            // Trocamos o componente exportado pelo nosso: todo botao que abre o seletor abre a nossa janela.
            find: "GO_LIVE_MODAL_SETTINGS_SELECTION",
            all: true,
            replacement: {
                match: /(\i\.d\(\i,\{default:\(\)=>)\i(\}\)(?=.{0,300000}?GO_LIVE_MODAL_SETTINGS_SELECTION))/s,
                replace: "$1$self.WrappedModal$2"
            }
        },

        // Bloqueio regional (experimento "2026-08-video-guard"): o Discord desliga o proprio video da conta.
        // A nossa live nao usa o video do Discord, entao so ela e liberada; camera e Go Live oficial continuam bloqueados.
        {
            // pode abrir o seletor de live (que e o nosso)
            find: ".DESKTOP_CAPTURE)}",
            replacement: {
                match: /return (\i)\.supportsInApp\((\i\.\i)\.VIDEO\)&&\1\.supportsInApp\(\2\.DESKTOP_CAPTURE\)/,
                replace: "return $1.supportsInApp($2.DESKTOP_CAPTURE)"
            }
        },
        {
            // botao de transmitir na barra da call: aparece e sem o icone de bloqueado
            find: "isSelfStream:!0,onPopoutClick",
            replacement: [
                {
                    match: /if\(!\(0,\i\.\i\)\(\[(\i\.\i)\],\(\)=>\1\.supports\(\i\.\i\.VIDEO\)\)\)return null;(?=function \i\(\)\{\(\(0,\i\.\i\)\(\i,\i\.\i\.STREAM,!0\))/,
                    replace: ""
                },
                {
                    match: /videoBlocked:\i,isSelfStream:!0/,
                    replace: "videoBlocked:!1,isSelfStream:!0"
                }
            ]
        },
        {
            // botao de transmitir no painel de baixo
            find: 'location:"RTCConnection"',
            all: true,
            noWarn: true,
            replacement: {
                match: /(\i)=!\i\.\i\.useConfig\(\{location:"RTCConnection"\}\)\.videoEnabled,(?=\i=\i\.useCallback\(\(\)=>\{\(0,\i\.\i\)\(\i,\i\.id,\i\)\})/,
                replace: "$1=!1,"
            }
        },
        {
            // quadro da nossa live entra na grade da call
            find: "getActiveStreamForUser(e,d);if(",
            replacement: {
                match: /if\((\i\.\i)\.supports\((\i\.\i)\.VIDEO\)&&null!=(\i)&&\3\.channelId===this\.channelId\)/,
                replace: "if(($self.isOurStream($3)||$1.supports($2.VIDEO))&&null!=$3&&$3.channelId===this.channelId)"
            }
        },
        {
            // e mostra o video nele
            find: "Stream Tile State",
            replacement: {
                match: /null!=(\i)&&!(\i)&&null!=(\i)&&(\i\.\i)\.supports\((\i\.\i)\.VIDEO\)\)return/,
                replace: "null!=$1&&!$2&&null!=$3&&($self.isOurStream($1)||$4.supports($5.VIDEO)))return"
            }
        },
        {
            // conta como participante com video (layout da grade)
            find: ".voiceState?.selfVideo??!1)}",
            replacement: {
                match: /!!(\i\.\i)\.supports\((\i\.\i)\.VIDEO\)&&\(\(0,(\i\.\i)\)\((\i)\)\?null!=\4\.streamId/,
                replace: "($self.isOurParticipant($4)||!!$1.supports($2.VIDEO))&&((0,$3)($4)?null!=$4.streamId"
            }
        }
    ],

    isOurStream(s: any) {
        return !!s?.ownerId && !!getLiveEntry(s.ownerId);
    },

    isOurParticipant(p: any) {
        // o resto da condicao ja confere se e um quadro de live (tipo STREAM = 0)
        return !!p?.user?.id && !!getLiveEntry(p.user.id);
    },

    onNativeQuality(resolution: number, fps: number) {
        const live = getLive();
        if (!live.running) return false;
        live.setPrefs({ preset: "custom", maxH: resolution, fps });
        return true;
    },

    WrappedModal(props: any) {
        return <LiveModal modalProps={props} />;
    },

    // Para a Fase 4: faixa de video estavel que alimenta o WebRTC
    getVideoTrack() {
        return getLive().getVideoTrack();
    },

    start() {
        createPill();
        startManager();
        updateTimer = setInterval(checkUpdateReady, 10 * 60_000);
        setTimeout(checkUpdateReady, 60_000);
    },

    stop() {
        stopManager();
        clearInterval(updateTimer);
        unsub?.();
        pill?.remove();
        pill = null;
        getLive().stop();
    }
});
