// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

interface AssociationFields {
    id: string;
    media_item_id: string;
    file_label?: string | null;
    is_default?: boolean;
    file_sort_order?: number;
    part_number?: number | null;
}
const ASSOCIATION_FIELDS = ['file_label', 'is_default', 'file_sort_order', 'part_number'] as const;
/** Keep physical data once, and association metadata either leaf-specific or unanimous. */
export function groupPhysicalFiles<T extends AssociationFields>(
    rows: T[],
    currentMediaId?: string,
): Array<T & { associations: T[]; mixedAssociationFields: string[] }> {
    const groups = new Map<string, T[]>();
    for (const row of rows) groups.set(row.id, [...(groups.get(row.id) ?? []), row]);
    return [...groups.values()].map((associations) => {
        const leaf = associations.find((row) => row.media_item_id === currentMediaId);
        const representative = { ...(leaf ?? associations[0]) };
        const mixedAssociationFields: string[] = [];
        for (const key of ASSOCIATION_FIELDS) {
            if (!associations.every((row) => row[key] === associations[0][key])) {
                mixedAssociationFields.push(key);
                if (!leaf) delete representative[key];
            }
        }
        return { ...representative, associations, mixedAssociationFields };
    });
}
