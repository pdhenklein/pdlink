// Escolhe em qual saida de som a live de outra pessoa deve tocar: a MESMA que esta nas configuracoes de voz do Discord
// (ex.: quem usa VoiceMeeter manda o Discord para o AUX e ouve o resto do PC pelo canal normal).

export interface DiscordOutputDevice { id?: string; name?: string; }
export interface SinkDevice { deviceId: string; label: string; kind?: string; }

const PREFIX = /^(default|padr[aã]o|communications|comunica[cç][oõ]es)\s*-\s*/i;
const clean = (s: string) => s.replace(PREFIX, "").trim().toLowerCase();

/**
 * Devolve o deviceId do navegador que corresponde ao dispositivo escolhido no Discord, ou "" para usar a saida padrao do Windows.
 * Os ids do Discord (motor nativo) nao sao os do navegador; o que une os dois e o nome do dispositivo.
 */
export function pickSink(selectedId: string | undefined, devices: Record<string, DiscordOutputDevice> | undefined, list: SinkDevice[]): string {
    if (!selectedId || selectedId === "default") return "";
    const name = devices?.[selectedId]?.name;
    if (!name) return "";
    const want = clean(name);
    const outs = list.filter(d => !d.kind || d.kind === "audiooutput");
    // os itens "Padrao - ..." e "Comunicacoes - ..." do navegador so repetem outro dispositivo: prefere o item real
    const real = outs.filter(d => !PREFIX.test(d.label));
    const pool = real.length ? real : outs;
    const found = pool.find(d => clean(d.label) === want)
        ?? pool.find(d => clean(d.label).includes(want) || want.includes(clean(d.label)));
    return found?.deviceId ?? "";
}
