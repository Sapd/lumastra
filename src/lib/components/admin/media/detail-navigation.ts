// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Navigate within an item without discarding its collection return state. */
export function detailTabPath(
    id: string,
    source: URLSearchParams,
    tab: string,
    section?: string,
    edit = false,
): string {
    const params = new URLSearchParams(source);
    params.set('tab', tab);
    params.delete('edit');
    params.delete('section');
    if (section) params.set('section', section);
    if (edit) params.set('edit', '1');
    return `/admin/library/media/${id}?${params.toString()}`;
}
