import { definePluginSettings } from "@api/Settings";
import { makeRange, OptionType } from "@utils/types";

import { VersionInfo } from "./versionInfo";

// Preferencias do mod. O Vencord grava isto no arquivo settings.json dentro da pasta de dados
// (no instalado: %LOCALAPPDATA%\GoLiveP2P\data\settings; a pasta mantem o nome antigo para nao quebrar quem ja instalou), que NAO e mexida nas atualizacoes do mod.
// Sao opcoes ocultas: nao aparecem na tela de plugins, so guardam o que a pessoa escolheu.
export const settings = definePluginSettings({
    version: { type: OptionType.COMPONENT, component: VersionInfo },
    ytBrowser: {
        type: OptionType.SELECT,
        description: "Musica do YouTube com a sua conta: o pdLink usa o login do YouTube deste navegador quando o YouTube pedir para confirmar que voce nao e um robo (o Firefox funciona melhor; Chrome e Edge podem nao deixar)",
        options: [
            { label: "Desligado (sem conta)", value: "", default: true },
            { label: "Firefox", value: "firefox" },
            { label: "Microsoft Edge", value: "edge" },
            { label: "Google Chrome", value: "chrome" },
            { label: "Brave", value: "brave" },
            { label: "Opera", value: "opera" },
            { label: "Opera GX", value: "operagx" }
        ],
        onChange: (v: string) => { (VencordNative.pluginHelpers.pdLink as any)?.musicSetBrowser?.(v).catch?.(() => { }); }
    },
    chatVolume: {
        type: OptionType.SLIDER,
        description: "Volume inicial de audios e videos mandados no chat (o Discord toca no maximo). 100 = deixar como o Discord faz",
        markers: makeRange(0, 100, 10),
        stickToMarkers: false,
        default: 30
    },
    musicNotify: { type: OptionType.BOOLEAN, description: "Avisar quando alguem colocar uma musica na chamada e quando a musica mudar", default: true },
    markColor: { type: OptionType.STRING, description: "Cor do ping e do desenho", default: "#3b82f6", hidden: true },
    markWidth: { type: OptionType.NUMBER, description: "Espessura do traco", default: 6, hidden: true },
    preset: { type: OptionType.STRING, description: "Modo de transmissao", default: "custom", hidden: true },
    maxH: { type: OptionType.NUMBER, description: "Resolucao da live", default: 1080, hidden: true },
    fps: { type: OptionType.NUMBER, description: "Taxa de quadros da live", default: 60, hidden: true },
    muteAudio: { type: OptionType.BOOLEAN, description: "Silenciar o som da live", default: false, hidden: true },
    cursor: { type: OptionType.STRING, description: "Cursor na live", default: "follow", hidden: true },
    migrated: { type: OptionType.BOOLEAN, description: "Ja trouxe as escolhas do nome antigo (GoLiveP2P)", default: false, hidden: true },
    marksInCapture: { type: OptionType.BOOLEAN, description: "Ping e desenho aparecem em prints e gravacoes", default: false, hidden: true },
    allowMarks: { type: OptionType.BOOLEAN, description: "Aceitar ping e desenho dos espectadores", default: true, hidden: true },
    viewFilter: { type: OptionType.STRING, description: "Limpeza e nitidez das lives que eu assisto (off, low, mid, high)", default: "mid", hidden: true },
    viewFg: { type: OptionType.NUMBER, description: "Geracao de quadros nas lives que eu assisto (1 = desligada, 2, 3 ou 4x)", default: 1, hidden: true },
    liveOutputDefault: { type: OptionType.BOOLEAN, description: "Som das lives na saida padrao do Windows (e nao na do Discord)", default: false, hidden: true }
});
