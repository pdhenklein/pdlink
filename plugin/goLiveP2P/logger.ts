// Log da sessao (arquivo logs/pdlink.log, recomecado quando o Discord abre). As linhas sao juntadas e enviadas em lotes
// para a parte de fundo, que grava no arquivo. Fora do Discord (testes), so vai para o console.

const t0 = performance.now();
let queue: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
    timer = null;
    const lines = queue;
    queue = [];
    try { (globalThis as any).VencordNative?.pluginHelpers?.pdLink?.log?.(lines)?.catch?.(() => { }); } catch { }
}

export function plog(text: string) {
    const line = `[${((performance.now() - t0) / 1000).toFixed(1)}s] ${text}`;
    try { console.log("[pdLink]", line); } catch { }
    queue.push(line);
    if (queue.length > 400) queue.splice(0, queue.length - 400);
    if (!timer) timer = setTimeout(flush, 500);
}

/** Tempo desde um instante, para o log ("+1234 ms"). */
export const since = (t: number) => `+${Math.round(performance.now() - t)} ms`;
