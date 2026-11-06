import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

// Preferencias do mod. O Vencord grava isto no arquivo settings.json dentro da pasta de dados
// (no instalado: %LOCALAPPDATA%\GoLiveP2P\data\settings; a pasta mantem o nome antigo para nao quebrar quem ja instalou), que NAO e mexida nas atualizacoes do mod.
// Sao opcoes ocultas: nao aparecem na tela de plugins, so guardam o que a pessoa escolheu.
export const settings = definePluginSettings({
    markColor: { type: OptionType.STRING, description: "Cor do ping e do desenho", default: "#3b82f6", hidden: true },
    markWidth: { type: OptionType.NUMBER, description: "Espessura do traco", default: 6, hidden: true },
    preset: { type: OptionType.STRING, description: "Modo de transmissao", default: "custom", hidden: true },
    maxH: { type: OptionType.NUMBER, description: "Resolucao da live", default: 1080, hidden: true },
    fps: { type: OptionType.NUMBER, description: "Taxa de quadros da live", default: 60, hidden: true },
    muteAudio: { type: OptionType.BOOLEAN, description: "Silenciar o som da live", default: false, hidden: true },
    cursor: { type: OptionType.STRING, description: "Cursor na live", default: "follow", hidden: true },
    migrated: { type: OptionType.BOOLEAN, description: "Ja trouxe as escolhas do nome antigo (GoLiveP2P)", default: false, hidden: true },
    marksInCapture: { type: OptionType.BOOLEAN, description: "Ping e desenho aparecem em prints e gravacoes", default: false, hidden: true },
    allowMarks: { type: OptionType.BOOLEAN, description: "Aceitar ping e desenho dos espectadores", default: true, hidden: true }
});
