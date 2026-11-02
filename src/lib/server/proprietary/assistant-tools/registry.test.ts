// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Tests for the capability gating in `buildAssistantTools`.
 *
 * The write tools are gated by ABSENCE — a tool the model is never shown cannot
 * be called, however a prompt steers it. That property is only worth anything
 * if the default really is "off", so it is asserted here rather than assumed.
 */
import { describe, it, expect } from 'vitest';
import { buildAssistantTools } from './registry.js';
import { buildToolParameters } from './to-openai-schema.js';
import { ASSISTANT_TOOL_NAMES } from '../../../schemas/assistant-tools.js';

const WRITE_TOOLS: string[] = [
    ASSISTANT_TOOL_NAMES.ADD_TO_WATCHLIST,
    ASSISTANT_TOOL_NAMES.REMOVE_FROM_WATCHLIST,
    ASSISTANT_TOOL_NAMES.SET_RATING,
    ASSISTANT_TOOL_NAMES.MARK_WATCHED,
    ASSISTANT_TOOL_NAMES.CREATE_REQUEST,
];

const names = (opts: Parameters<typeof buildAssistantTools>[0] = {}): string[] =>
    buildAssistantTools(opts).map((t) => t.name);

describe('buildAssistantTools — write-action gating', () => {
    it('offers NO write tool by default', () => {
        const defaults = names();
        for (const tool of WRITE_TOOLS) expect(defaults).not.toContain(tool);
        // …while the read tools are still there, i.e. the default is not empty.
        expect(defaults).toContain(ASSISTANT_TOOL_NAMES.SEARCH_LIBRARY);
    });

    it('adds the four own-data writes when writes are enabled', () => {
        const enabled = names({ writeActionsEnabled: true });
        expect(enabled).toContain(ASSISTANT_TOOL_NAMES.ADD_TO_WATCHLIST);
        expect(enabled).toContain(ASSISTANT_TOOL_NAMES.REMOVE_FROM_WATCHLIST);
        expect(enabled).toContain(ASSISTANT_TOOL_NAMES.SET_RATING);
        expect(enabled).toContain(ASSISTANT_TOOL_NAMES.MARK_WATCHED);
        // …but not the one that orders a download.
        expect(enabled).not.toContain(ASSISTANT_TOOL_NAMES.CREATE_REQUEST);
    });

    it('never offers create_request without the write flag, even with permission', () => {
        expect(names({ requestWritesEnabled: true })).not.toContain(
            ASSISTANT_TOOL_NAMES.CREATE_REQUEST,
        );
    });

    it('offers create_request only when both gates are open', () => {
        expect(names({ writeActionsEnabled: true, requestWritesEnabled: true })).toContain(
            ASSISTANT_TOOL_NAMES.CREATE_REQUEST,
        );
    });

    it('produces a flat, provider-safe parameter schema for every write tool', () => {
        const writeTools = buildAssistantTools({
            writeActionsEnabled: true,
            requestWritesEnabled: true,
        }).filter((t) => WRITE_TOOLS.includes(t.name));
        expect(writeTools).toHaveLength(WRITE_TOOLS.length);

        for (const tool of writeTools) {
            const params = buildToolParameters(tool);
            expect(params.type).toBe('object');
            expect(params).not.toHaveProperty('$defs');
            expect(params).not.toHaveProperty('$schema');
            // The write schemas are strict: an extra key (a hallucinated
            // `mediaId`) must be rejected, not silently ignored.
            expect(params.additionalProperties).toBe(false);
            expect(Object.keys(params.properties as object)).toContain('title');
        }
    });

    it('registers every tool name exactly once', () => {
        const all = names({
            liveTvAllowed: true,
            audiobooksEnabled: true,
            booksEnabled: true,
            streamsViewable: true,
            socialWatchHistoryViewable: true,
            personalStatsEnabled: true,
            textToSoundEnabled: true,
            writeActionsEnabled: true,
            requestWritesEnabled: true,
        });
        expect(new Set(all).size).toBe(all.length);
    });
});
