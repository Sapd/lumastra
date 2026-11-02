// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Section help texts in the config schema use `**bold**` for emphasis. They
 * rendered as literal asterisks; this splits them into plain/bold runs so the
 * template can emit `<strong>` without `{@html}`. Only `**…**` is recognised —
 * the help texts are plain prose otherwise.
 */
export interface HelpTextSegment {
    text: string;
    bold: boolean;
}

export function helpTextSegments(text: string): HelpTextSegment[] {
    const out: HelpTextSegment[] = [];
    const re = /\*\*(.+?)\*\*/gs;
    let last = 0;
    for (const match of text.matchAll(re)) {
        const index = match.index ?? 0;
        if (index > last) out.push({ text: text.slice(last, index), bold: false });
        out.push({ text: match[1], bold: true });
        last = index + match[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last), bold: false });
    return out;
}
