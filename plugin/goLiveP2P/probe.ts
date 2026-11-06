import type { PluginNative } from "@utils/types";
import { wreq } from "@webpack";

import type * as NativeTypes from "./native";

const Native = VencordNative.pluginHelpers.pdLink as PluginNative<typeof NativeTypes>;

const KEYWORDS = /getAllActiveStreams|getActiveStreamForUser|getStreamForUser|ParticipantType|participants|VideoTile|StreamTile|RTCStream|streamKey|STREAM_KEY/;

let runs = 0;
let done = false;

async function scan() {
    if (done || runs++ >= 40) return;
    const entries = new Map<string, string>();
    for (const id of Object.keys(wreq.c)) {
        try { entries.set(id, wreq.m[id].toString()); } catch { }
    }
    let mainId = "";
    for (const [id, src] of entries) {
        if (src.includes("IDLE_TIMEOUT") && src.includes("CALL_TILE_POPOUT")) { mainId = id; break; }
    }
    if (!mainId) return;

    const out: any = { mainId, imports: [], title: entries.get("681281") ?? null };
    const mainSrc = entries.get(mainId)!;
    const ids = [...new Set([...mainSrc.matchAll(/\bn\((\d+)\)/g)].map(m => m[1]))];
    const scored: any[] = [];
    for (const id of ids) {
        const src = entries.get(id);
        if (!src) continue;
        const km = KEYWORDS.exec(src);
        if (!km) continue;
        scored.push({
            id, len: src.length, keyword: km[0], head: src.slice(0, 200),
            ctx: src.slice(Math.max(0, km.index - 800), km.index + 1400)
        });
    }
    scored.sort((a, b) => a.len - b.len);
    out.imports = scored.slice(0, 8);
    out.importCount = ids.length;
    done = true;
    await Native.saveProbe("grade3.json", JSON.stringify(out, null, 1));
}

export function startProbe() {
    for (let i = 1; i <= 40; i++) setTimeout(scan, 30000 * i);
}
