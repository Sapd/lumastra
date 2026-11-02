// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChapterInput, DetectedSegment } from './types.js';

export interface ChapterAnalyzerConfig {
    introPattern: string;
    creditsPattern: string;
    recapPattern: string;
    previewPattern: string;
    commercialPattern: string;
    minDuration: number;
    maxIntroDuration: number;
    maxCreditsDuration: number;
    /**
     * Smallest `lastMarkStart / duration` at which the final chapter boundary
     * may be read as a credits start (see findLastMarkOutro). Optional so the
     * per-run config builder can adopt it independently; callers that omit it
     * get DEFAULT_OUTRO_MIN_START_FRACTION.
     */
    outroMinStartFraction?: number;
}

/**
 * 0.80 is the same bound the plausibility rule uses for an Outro: a segment
 * starting before 80 % of runtime would be longer than 20 % of the episode,
 * which is not credits.
 */
export const DEFAULT_OUTRO_MIN_START_FRACTION = 0.8;

/**
 * A trailing chapter boundary says where the last authored section begins, not
 * what is in it. That is real but weaker evidence than a title match, so the
 * detector reports middling trust and loses to chapter-title/chromaprint.
 */
const CHAPTER_MARK_CONFIDENCE = 0.6;

// Starting template for chapter analyzer; live config is built per-run from
// EffectiveConfig (see buildChapterConfig()). Kept for fallback when settings
// haven't been read (defensive only — execute() reads settings first).
export const DEFAULT_CHAPTER_CONFIG: ChapterAnalyzerConfig = {
    introPattern:
        '(^|\\b)(intro(duction)?|opening|op(ening)?\\s*(theme|song|credits)?|cold open)($|\\b)',
    creditsPattern:
        '(^|\\b)(credits?|end(ing)?\\s*(credits?|theme|song)?|outro|ed(\\s|$)|closing)($|\\b)',
    recapPattern: '(^|\\b)(recap|previously|last\\s+time)($|\\b)',
    previewPattern: '(^|\\b)(preview|next\\s+(time|episode)|coming\\s+up)($|\\b)',
    commercialPattern: '(^|\\b)(commercial|advert(isement)?|ad\\s*break|sponsored?)($|\\b)',
    minDuration: 15,
    maxIntroDuration: 120,
    maxCreditsDuration: 600,
};

type AnalysisMode = 'Intro' | 'Outro' | 'Recap' | 'Preview' | 'Commercial';

interface ModeConfig {
    type: AnalysisMode;
    pattern: string;
    minDuration: number;
    maxDuration: number;
    reversed: boolean;
}

export function findMatchingChapter(
    chapters: ChapterInput[],
    durationMs: number,
    mode: ModeConfig,
): DetectedSegment | null {
    let regex: RegExp;
    try {
        regex = new RegExp(mode.pattern, 'i');
    } catch {
        return null;
    }
    const ordered = mode.reversed ? [...chapters].reverse() : [...chapters];

    for (const chapter of ordered) {
        if (!chapter.title || !regex.test(chapter.title)) continue;
        const startSec = chapter.startTimeMs / 1000;
        const endSec = Math.min(
            chapter.endTimeMs > 0 ? chapter.endTimeMs / 1000 : durationMs / 1000,
            durationMs / 1000,
        );
        const durationSec = endSec - startSec;
        if (durationSec < mode.minDuration || durationSec > mode.maxDuration) continue;
        return {
            type: mode.type,
            startTime: startSec,
            endTime: endSec,
            method: 'chapter-title',
        };
    }
    return null;
}

/**
 * Untitled-chapter-mark Outro detector.
 *
 * findMatchingChapter needs a title that matches a mode pattern. A Bluray rip
 * that titles its chapters with timecodes ("00:40:13.036") — or not at all —
 * therefore contributes nothing, even though the authored mark itself IS the
 * credits boundary, frame-exact and already read out of the file header.
 * Drifting Clouds S03E12 is the motivating case: chapter detection returned [],
 * so blackframe ran, walked backwards from EOF through five minutes of night
 * exterior, hit the end of its search window at 2632.672 and reported that
 * truncation as a detection. The mkv carried the real boundary at 2789.412.
 *
 * A generic label such as "Chapter 07" adds no semantic claim, so it is treated
 * like an untitled mark. A meaningful final title ("Preview", for example) is
 * different evidence and must not be silently relabelled as credits just
 * because it happens to be last.
 */
function isGenericChapterMark(title: string | null): boolean {
    if (!title || !title.trim()) return true;
    const normalized = title.trim();
    return (
        // Authoring tools emit the same "<word> <n>" shape in whatever language
        // the disc was mastered in. Restricting this to English and German made
        // every French, Spanish, Italian, Portuguese, Dutch or Nordic release
        // read as "semantically named", so their final mark was rejected and the
        // episode silently fell through to the luma heuristic.
        /^(?:chapter|chapitre|kapitel|kapittel|kapitolo|capitolo|cap[ií]tulo|hoofdstuk|rozdzia[łl]|glava|bölüm|scene|sc[eè]ne|szene|escena|scena)\s*(?:\d+|[ivxlcdm]+)?$/i.test(
            normalized,
        ) ||
        // A bare ordinal ("07", "7.") carries no semantic claim either — some
        // rippers emit only the number.
        /^\d{1,3}\.?$/.test(normalized) ||
        /^\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized)
    );
}

export function findLastMarkOutro(
    chapters: ChapterInput[],
    durationMs: number,
    config: ChapterAnalyzerConfig = DEFAULT_CHAPTER_CONFIG,
): DetectedSegment | null {
    if (durationMs <= 0) return null;

    const durationSec = durationMs / 1000;
    const minStartFraction = config.outroMinStartFraction ?? DEFAULT_OUTRO_MIN_START_FRACTION;

    // Sort descending rather than taking a single largest start: probe order is
    // not a contract, AND the last mark is frequently not the credits boundary.
    // Real discs routinely carry a trailing sub-second end-of-file marker, and
    // some carry a named tail segment ("Preview") after the credits. Considering
    // only the final mark meant one of those vetoed the real boundary and the
    // episode shipped with no Outro at all — observed on A Keeper of the Seven
    // Lanterns S01E01, whose "Kapitel 07" sits 0.3s before EOF.
    //
    // Walking back is bounded and cannot reach mid-file: every candidate must
    // still clear minStartFraction (>= 80% of runtime) and maxCreditsDuration.
    const marks = chapters
        .filter((chapter) => Number.isFinite(chapter.startTimeMs) && chapter.startTimeMs > 0)
        .sort((a, b) => b.startTimeMs - a.startTimeMs);

    let startSec = -1;
    for (const mark of marks) {
        // A titled mark is a claim about what that segment IS, so it is never
        // relabelled as credits — but it also must not stop the search: the
        // credits can legitimately precede a named tail.
        if (!isGenericChapterMark(mark.title)) continue;

        const candidateSec = mark.startTimeMs / 1000;
        if (candidateSec >= durationSec) continue;

        const creditsSec = durationSec - candidateSec;
        if (creditsSec < config.minDuration) continue;
        // Past the plausible credits length, every earlier mark is further away
        // still — nothing later can qualify.
        if (creditsSec > config.maxCreditsDuration) break;
        if (candidateSec / durationSec < minStartFraction) break;

        startSec = candidateSec;
        break;
    }

    if (startSec < 0) return null;

    return {
        type: 'Outro',
        startTime: startSec,
        endTime: durationSec,
        method: 'chapter-mark',
        confidence: CHAPTER_MARK_CONFIDENCE,
    };
}

export function analyzeChapters(
    chapters: ChapterInput[],
    durationMs: number,
    config: ChapterAnalyzerConfig = DEFAULT_CHAPTER_CONFIG,
): DetectedSegment[] {
    if (chapters.length === 0 || durationMs <= 0) return [];

    const modes: ModeConfig[] = [
        {
            type: 'Intro',
            pattern: config.introPattern,
            minDuration: config.minDuration,
            maxDuration: config.maxIntroDuration,
            reversed: false,
        },
        {
            type: 'Outro',
            pattern: config.creditsPattern,
            minDuration: config.minDuration,
            maxDuration: config.maxCreditsDuration,
            reversed: true,
        },
        {
            type: 'Recap',
            pattern: config.recapPattern,
            minDuration: config.minDuration,
            maxDuration: config.maxIntroDuration,
            reversed: false,
        },
        {
            type: 'Preview',
            pattern: config.previewPattern,
            minDuration: config.minDuration,
            maxDuration: config.maxIntroDuration,
            reversed: true,
        },
        {
            type: 'Commercial',
            pattern: config.commercialPattern,
            minDuration: config.minDuration,
            maxDuration: config.maxIntroDuration,
            reversed: false,
        },
    ];

    const results: DetectedSegment[] = [];
    for (const mode of modes) {
        if (!mode.pattern) continue;
        const segment = findMatchingChapter(chapters, durationMs, mode);
        if (segment) results.push(segment);
    }

    // The mark detector is a fallback, not a peer. It is also emitted into
    // this same array on purpose: the caller keys its blackframe suppression
    // off `segments.find(s => s.type === 'Outro')`, and upsertSegments is
    // last-write-wins per type, so a mark Outro returned through any other
    // channel would simply be overwritten by the blackframe answer it exists
    // to displace.
    if (!results.some((s) => s.type === 'Outro')) {
        const markOutro = findLastMarkOutro(chapters, durationMs, config);
        if (markOutro) results.push(markOutro);
    }

    return results;
}
