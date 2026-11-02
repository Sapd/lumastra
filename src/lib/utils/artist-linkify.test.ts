// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { linkifyArtists } from './artist-linkify';

describe('linkifyArtists', () => {
    it('links each artist in a comma-joined string, keeping the separator', () => {
        expect(
            linkifyArtists('DJ Fenwick, Milo Sebastian', [
                { id: 'a', title: 'DJ Fenwick' },
                { id: 'b', title: 'Milo Sebastian' },
            ]),
        ).toEqual([
            { text: 'DJ Fenwick', id: 'a' },
            { text: ', ' },
            { text: 'Milo Sebastian', id: 'b' },
        ]);
    });

    it('preserves "feat." wording verbatim', () => {
        expect(
            linkifyArtists('Megalanterns feat. Sarah', [
                { id: 'a', title: 'Megalanterns' },
                { id: 'b', title: 'Sarah' },
            ]),
        ).toEqual([
            { text: 'Megalanterns', id: 'a' },
            { text: ' feat. ' },
            { text: 'Sarah', id: 'b' },
        ]);
    });

    it('preserves "&" wording verbatim', () => {
        expect(
            linkifyArtists('Alice & Bob', [
                { id: 'a', title: 'Alice' },
                { id: 'b', title: 'Bob' },
            ]),
        ).toEqual([{ text: 'Alice', id: 'a' }, { text: ' & ' }, { text: 'Bob', id: 'b' }]);
    });

    it('prefers the longest title so a shorter artist cannot steal the span', () => {
        expect(
            linkifyArtists('DJ Fenwick', [
                { id: 'short', title: 'Fenwick' },
                { id: 'long', title: 'DJ Fenwick' },
            ]),
        ).toEqual([{ text: 'DJ Fenwick', id: 'long' }]);
    });

    it('does not match inside a word', () => {
        expect(linkifyArtists('Sara Vale', [{ id: 'a', title: 'Sara' }])).toEqual([
            { text: 'Sara Vale' },
        ]);
    });

    it('leaves unknown names unlinked rather than guessing', () => {
        expect(linkifyArtists('Someone Else', [{ id: 'a', title: 'DJ Fenwick' }])).toEqual([
            { text: 'Someone Else' },
        ]);
    });

    it('returns a single linked segment when the artist is the whole string', () => {
        expect(linkifyArtists('DJ Fenwick', [{ id: 'a', title: 'DJ Fenwick' }])).toEqual([
            { text: 'DJ Fenwick', id: 'a' },
        ]);
    });

    it('preserves the original casing of the raw string', () => {
        expect(linkifyArtists('dj fenwick', [{ id: 'a', title: 'DJ Fenwick' }])).toEqual([
            { text: 'dj fenwick', id: 'a' },
        ]);
    });

    it('links only the first occurrence of a duplicated name', () => {
        expect(linkifyArtists('Bob & Bob', [{ id: 'a', title: 'Bob' }])).toEqual([
            { text: 'Bob', id: 'a' },
            { text: ' & Bob' },
        ]);
    });

    it('handles names containing regex metacharacters', () => {
        expect(
            linkifyArtists('A$AP Rowan & !!!', [
                { id: 'a', title: 'A$AP Rowan' },
                { id: 'b', title: '!!!' },
            ]),
        ).toEqual([{ text: 'A$AP Rowan', id: 'a' }, { text: ' & ' }, { text: '!!!', id: 'b' }]);
    });

    it('ignores artists without an id', () => {
        expect(linkifyArtists('DJ Fenwick', [{ title: 'DJ Fenwick' }])).toEqual([
            { text: 'DJ Fenwick' },
        ]);
    });

    it('ignores artists with a blank title', () => {
        expect(
            linkifyArtists('DJ Fenwick', [
                { id: 'a', title: '   ' },
                { id: 'b', title: 'DJ Fenwick' },
            ]),
        ).toEqual([{ text: 'DJ Fenwick', id: 'b' }]);
    });

    it('returns an empty array for an empty raw string', () => {
        expect(linkifyArtists('', [{ id: 'a', title: 'DJ Fenwick' }])).toEqual([]);
    });

    it('returns the raw string unlinked when there are no artists', () => {
        expect(linkifyArtists('DJ Fenwick')).toEqual([{ text: 'DJ Fenwick' }]);
    });

    it('matches a name at a string edge without surrounding separators', () => {
        expect(
            linkifyArtists('Bob', [
                { id: 'a', title: 'Bob' },
                { id: 'b', title: 'Alice' },
            ]),
        ).toEqual([{ text: 'Bob', id: 'a' }]);
    });

    it('does not overlap two artists claiming the same span', () => {
        // "Bob Linden" wins the span; "Linden" must not also claim part of it.
        expect(
            linkifyArtists('Bob Linden, Alice', [
                { id: 'linden', title: 'Linden' },
                { id: 'bob', title: 'Bob Linden' },
                { id: 'alice', title: 'Alice' },
            ]),
        ).toEqual([
            { text: 'Bob Linden', id: 'bob' },
            { text: ', ' },
            { text: 'Alice', id: 'alice' },
        ]);
    });

    it('trims surrounding whitespace on artist titles when matching', () => {
        expect(linkifyArtists('DJ Fenwick', [{ id: 'a', title: '  DJ Fenwick  ' }])).toEqual([
            { text: 'DJ Fenwick', id: 'a' },
        ]);
    });

    it('positions by where each name occurs, not by the order artists[] arrives in', () => {
        // Anonymized production row: the raw tag reads "Darin Vale & Jon Fenwick" but
        // additional_artist_ids resolves to [Jon Fenwick, Darin Vale] — reversed.
        // The DB orders by the ids in custom_metadata, which need not match the
        // order the names appear in the string. Zipping artists[] to segments by
        // index would label "Darin Vale" as Jon Fenwick and link the wrong person.
        expect(
            linkifyArtists('Darin Vale & Jon Fenwick', [
                { id: 'oates', title: 'Jon Fenwick' },
                { id: 'hall', title: 'Darin Vale' },
            ]),
        ).toEqual([
            { text: 'Darin Vale', id: 'hall' },
            { text: ' & ' },
            { text: 'Jon Fenwick', id: 'oates' },
        ]);
    });

    it('links each artist across an " x " collab separator, kept verbatim', () => {
        // Anonymized production shape (Moi Liora): the "x" separator now links all three.
        expect(
            linkifyArtists('Liora Vale x Lantern Pitch x Lanternlovers United', [
                { id: 'a', title: 'Liora Vale' },
                { id: 'b', title: 'Lantern Pitch' },
                { id: 'c', title: 'Lanternlovers United' },
            ]),
        ).toEqual([
            { text: 'Liora Vale', id: 'a' },
            { text: ' x ' },
            { text: 'Lantern Pitch', id: 'b' },
            { text: ' x ' },
            { text: 'Lanternlovers United', id: 'c' },
        ]);
    });

    it('does not link an artist absent from the display string', () => {
        // Also a real prod shape: additional_artist_ids can name more artists
        // than the tag string does. We render the tag, so the extra artist has
        // nowhere to attach — it must not be appended or substituted.
        expect(
            linkifyArtists('Digital Harbor', [
                { id: 'du', title: 'Digital Harbor' },
                { id: 'pac', title: '2Vale' },
            ]),
        ).toEqual([{ text: 'Digital Harbor', id: 'du' }]);
    });
});
