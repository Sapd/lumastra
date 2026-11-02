// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Broad genre-family cues; unknown genres get a neutral music symbol. */
export function musicGenreIcon(genre: string): string {
    const name = genre.toLowerCase().replace(/[-_]/g, ' ');
    if (/\b(jazz|swing|bebop)\b/.test(name)) return '🎷';
    if (/\b(classical|orchestral|symphony|opera|chamber)\b/.test(name)) return '🎻';
    if (/\b(hip hop|hiphop|rap|trap)\b/.test(name)) return '🎤';
    if (/\b(disco|dance|funk)\b/.test(name)) return '🪩';
    if (/\b(electronic|electronica|techno|house|trance|synth|edm|dubstep)\b/.test(name))
        return '🎹';
    if (/\b(rock|metal|punk|grunge|blues)\b/.test(name)) return '🎸';
    if (/\b(country|bluegrass|folk)\b/.test(name)) return '🪕';
    if (/\b(ambient|chill|lo fi|downtempo)\b/.test(name)) return '🌌';
    if (/\b(latin|salsa|samba|reggae|reggaeton)\b/.test(name)) return '🪘';
    if (/\b(pop|soul|r&b|gospel)\b/.test(name)) return '🎙️';
    return '🎵';
}
