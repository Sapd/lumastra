// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { isTrivialAssistantInput } from './trivial-input.js';

describe('isTrivialAssistantInput', () => {
    it('flags greetings / thanks / capability questions (en + de)', () => {
        for (const m of [
            'hi',
            'Hey!',
            'hello there',
            'good morning',
            'hallo',
            'moin',
            'guten abend',
            'danke',
            'thank you',
            'thanks!',
            'what can you do?',
            'was kannst du',
            'who are you',
            'help',
        ]) {
            expect(isTrivialAssistantInput(m)).toBe(true);
        }
    });

    it('does NOT flag real requests', () => {
        for (const m of [
            'recommend a sci-fi movie for tonight',
            'do we have Dawn?',
            "what's on KWF right now",
            'something like Drifting Clouds',
            'hi, can you recommend a thriller with tom hanks', // greeting prefix but a real ask
            'hello world documentary about coding',
        ]) {
            expect(isTrivialAssistantInput(m)).toBe(false);
        }
    });

    it('treats empty input as trivial', () => {
        expect(isTrivialAssistantInput('   ')).toBe(true);
    });
});
