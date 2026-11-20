import { viewFg, viewFilter } from "./hwvideo";
import { settings } from "./settings";

// Limpeza (filtro que preserva bordas) e nitidez (CAS) aplicadas na placa de video em cada quadro das lives que eu assisto
export const VIEW_FILTERS = [
    { id: "off", label: "Desligada", clean: 0, sharp: 0, amount: 0 },
    { id: "low", label: "Leve", clean: 0.3, sharp: 0.6, amount: 1.5 },
    { id: "mid", label: "Média", clean: 0.5, sharp: 1, amount: 2.5 },
    { id: "high", label: "Forte", clean: 0.6, sharp: 1, amount: 4 }
];

export const FG_MULTS = [
    { m: 1, label: "Desligada" },
    { m: 2, label: "2x" },
    { m: 3, label: "3x" },
    { m: 4, label: "4x" }
];

export function applyViewFilter() {
    const f = VIEW_FILTERS.find(v => v.id === settings.store.viewFilter) ?? VIEW_FILTERS[2];
    viewFilter.clean = f.clean;
    viewFilter.sharp = f.sharp;
    viewFilter.amount = f.amount;
    viewFg.mult = [1, 2, 3, 4].includes(settings.store.viewFg) ? settings.store.viewFg : 1;
}
