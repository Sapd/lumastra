// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { escapeHtml } from './escape-html';

const HIGHLIGHT_START = '<mark class="bg-primary-500/40 text-white px-0.5 rounded">';

/** Treat producer snippets as text; rebuild only the two supported highlight markers. */
export function safeHighlightedSnippet(snippet: string): string {
    return escapeHtml(snippet)
        .replaceAll(escapeHtml(HIGHLIGHT_START), HIGHLIGHT_START)
        .replaceAll('&lt;mark&gt;', HIGHLIGHT_START)
        .replaceAll('&lt;/mark&gt;', '</mark>');
}
