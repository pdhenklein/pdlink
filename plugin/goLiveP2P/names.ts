// Nome mostrado junto das marcacoes: o mesmo que o Discord mostra para a pessoa naquela chamada
// (apelido do servidor, apelido de amigo, apelido do grupo), so a primeira palavra.

export function firstName(name: string) {
    return (name.trim().split(/\s+/)[0] ?? "").slice(0, 24);
}

export interface NameSources {
    guildNick?: string | null; // apelido no servidor da chamada
    groupNick?: string | null; // apelido na chamada em grupo
    friendNick?: string | null; // apelido que voce deu ao amigo
    globalName?: string | null;
    username?: string | null;
}

export function pickName(s: NameSources, inGuild: boolean) {
    const n = inGuild
        ? s.guildNick || s.globalName || s.username
        : s.groupNick || s.friendNick || s.globalName || s.username;
    return firstName(String(n ?? ""));
}

/** Nome completo (para listas): o mesmo que o Discord mostra naquela chamada. */
export function pickFullName(s: NameSources, inGuild: boolean) {
    const n = inGuild
        ? s.guildNick || s.globalName || s.username
        : s.groupNick || s.friendNick || s.globalName || s.username;
    return String(n ?? "").trim().slice(0, 40);
}
