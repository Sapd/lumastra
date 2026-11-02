// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Section header title → render chunks.
 *
 * A section `title` is an HTML string for the i18n messages that highlight a
 * word ("Because you watched <span class=…>{title}</span>"); the highlighted
 * word is library data. The server also sends the same title as structured
 * `meta.titleParts` (text-only), which is preferred: nothing to parse, so
 * nothing to inject. The HTML path remains for sections that only carry
 * `title` (client-built rows) and keeps just a closed set of class tokens.
 */
import type { TitlePart } from '$lib/schemas/api-responses';

export type TitleChunk = {
    text: string;
    className?: string;
    tag?: 'strong' | 'em';
};

/**
 * The only classes the i18n title messages use (`messages/*.json` span
 * classes). Any other token is dropped rather than rendered: a free class is a
 * full-screen overlay.
 */
export const TITLE_CLASS_TOKENS: ReadonlySet<string> = new Set([
    'text-purple-400',
    'font-heading',
    'text-cyan-400',
]);

/** Closed colour → class map for structured title parts. */
const TITLE_PART_CLASSES: Readonly<Record<string, string>> = {
    purple: 'text-purple-400 font-heading',
    cyan: 'text-cyan-400',
    primary: 'text-primary-400',
    accent: 'text-accent-400',
    success: 'text-success-400',
    warning: 'text-warning-400',
    orange: 'text-orange-400',
};

export function keepKnownTitleClasses(value: string): string {
    return value
        .split(/\s+/)
        .filter((token) => TITLE_CLASS_TOKENS.has(token))
        .join(' ');
}

/** Undo `escapeHtml`, for the tag-stripped text of a title (no DOM available). */
export function decodeEscapedText(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&');
}

/** Chunks from structured parts: plain text, class chosen from a closed map. */
export function titleChunksFromParts(parts: readonly TitlePart[]): TitleChunk[] {
    return parts
        .filter((part) => part.text !== '')
        .map((part) => ({
            text: part.text,
            className: part.highlight && part.color ? TITLE_PART_CLASSES[part.color] : undefined,
        }));
}

/**
 * Chunks from already-sanitised title HTML (needs a DOM). Text nodes carry
 * decoded text (so `&amp;` shows as `&` once); only known class tokens survive.
 */
export function titleChunksFromHtml(sanitized: string): TitleChunk[] {
    const plain = (): TitleChunk[] => [{ text: sanitized.replace(/<[^>]+>/g, '') }];
    const doc = new DOMParser().parseFromString(`<div>${sanitized}</div>`, 'text/html');
    const container = doc.body.firstElementChild;
    if (!container) return plain();

    const chunks: TitleChunk[] = [];
    const walk = (node: ChildNode, inheritedClass = '', inheritedTag?: 'strong' | 'em'): void => {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent ?? '';
            if (text) {
                chunks.push({
                    text,
                    className: inheritedClass || undefined,
                    tag: inheritedTag,
                });
            }
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const element = node as Element;
        let className = inheritedClass;
        if (element.tagName === 'SPAN') {
            const elementClass = keepKnownTitleClasses(element.getAttribute('class') ?? '');
            className = elementClass ? `${inheritedClass} ${elementClass}`.trim() : inheritedClass;
        }
        let tag = inheritedTag;
        if (element.tagName === 'STRONG') tag = 'strong';
        if (element.tagName === 'EM') tag = 'em';

        element.childNodes.forEach((child) => walk(child, className, tag));
    };
    container.childNodes.forEach((child) => walk(child));

    return chunks.length > 0 ? chunks : plain();
}
