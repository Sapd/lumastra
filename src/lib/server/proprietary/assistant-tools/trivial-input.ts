// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Detect trivial assistant inputs (greetings, thanks, "what can you do") that
 * need no reasoning. The caller suppresses model thinking for these to save
 * output tokens — thinking on "hi" is pure waste.
 *
 * High-precision by design: only SHORT messages matching a known greeting /
 * capability pattern qualify. Anything longer or unrecognised falls through to
 * normal handling (thinking stays on), so a real query is never mistaken for a
 * greeting. Covers English + German (the app's primary locales).
 *
 * @module server/proprietary/assistant-tools/trivial-input
 */

// Anchored to the WHOLE message (with small optional trailing filler) so a
// greeting *followed by a real request* ("hello, recommend a thriller") does
// NOT match — only a bare greeting/meta input does.
const TRIVIAL_PATTERNS: readonly RegExp[] = [
    // Greetings (en) — optional "there"/"assistant"
    /^(hi|hey+|hello|yo|hiya|howdy|sup|gm|good\s+(morning|afternoon|evening|day))(\s+(there|assistant))?$/,
    // Greetings (de)
    /^(hallo|hey+|servus|moin|tach|na|guten\s+(morgen|tag|abend))$/,
    // Thanks (en/de/fr) — optional intensifier
    /^(thanks?|thank\s+you|thx|ty|cheers|danke(\s+(dir|schön))?|merci)(\s+(so\s+much|a\s+lot|very\s+much))?$/,
    // Capability / meta questions
    /^(what\s+can\s+you\s+do|what\s+do\s+you\s+do|who\s+are\s+you|help|how\s+does\s+this\s+work)$/,
    /^(was\s+kannst\s+du|wer\s+bist\s+du|hilfe|wie\s+funktioniert\s+das)$/,
];

/** Whether a message is a trivial greeting/meta input that needs no reasoning. */
export function isTrivialAssistantInput(message: string): boolean {
    const m = message
        .trim()
        .toLowerCase()
        .replace(/[!.?,…]+$/u, '')
        .trim();
    if (!m) return true;
    return TRIVIAL_PATTERNS.some((re) => re.test(m));
}
