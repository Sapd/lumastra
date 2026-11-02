// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** One CJK character is meaningful in the audiobook substring-search lane. */
export function isSingleCjkAudiobookQuery(query: string): boolean {
    const trimmed = query.trim();
    return (
        [...trimmed].length === 1 &&
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(trimmed)
    );
}
