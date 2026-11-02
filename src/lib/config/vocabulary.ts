// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Do two operator-facing names for the same thing share any vocabulary?
 *
 * One task legitimately carries different names on different surfaces: the
 * pipeline is a metro map and needs "Artwork" where the catalog says "Image
 * Sync". That is good design, not drift. What strands an operator is a name
 * with NO word in common with the others — reading "Quick scan failed" and
 * finding no "Quick scan" anywhere in the catalog, because the task is called
 * "Media File Probe".
 *
 * So this is the test for "would a reader connect these?", not "are these
 * equal?". Prefix matching (min 4 chars) is what makes it usable in practice:
 * poster/posters, art/artwork and embedding/embeddings all read as the same
 * word to a human, and a rule that called them different would fire on
 * perfectly good copy — which it did, on the first attempt, before this.
 */

/** Content words, lowercased. Glue words (<= 2 chars) carry no meaning here. */
function contentWords(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2);
}

/** True when one word is the other, or a prefix of it (>= 4 chars). */
function wordsRelated(a: string, b: string): boolean {
    if (a === b) return true;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return short.length >= 4 && long.startsWith(short);
}

/**
 * True when `a` and `b` share at least one recognisable word.
 *
 * Used both to decide whether a pipeline step needs to name its owning task,
 * and by the vocabulary ratchet. One implementation on purpose: a second copy
 * in the test could not fail when this one changed.
 */
export function sharesVocabulary(a: string, b: string): boolean {
    const wordsB = contentWords(b);
    for (const wa of contentWords(a)) {
        for (const wb of wordsB) if (wordsRelated(wa, wb)) return true;
    }
    return false;
}
