// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dependency-free password strength heuristic shared by the client (live
 * feedback on the create-admin / change-password forms) and the server (policy
 * enforcement), so both judge a password identically.
 *
 * This is a deliberately lightweight estimator (not zxcvbn) — it rewards length
 * and character-class variety and penalizes a few common weak patterns. It is a
 * UX nudge plus a minimum-bar gate, NOT a substitute for the rate-limiting and
 * lockout that actually defend the login endpoint.
 */

export const PASSWORD_MIN_LENGTH = 10;

/**
 * Upper bound on an accepted password. scrypt cost does not grow with the
 * input, but a 256 KB body hashed per attempt is still a cheap CPU/memory
 * sink; `hashPassword()` refuses longer inputs, and the policy says so
 * before any hashing happens (admin/users review 2026-10-07, item 8d).
 */
export const PASSWORD_MAX_LENGTH = 1024;

export type PasswordStrengthScore = 0 | 1 | 2 | 3 | 4;

export interface PasswordStrength {
    /** 0 (very weak) … 4 (strong). */
    score: PasswordStrengthScore;
    /** Short label for the meter. */
    label: 'very weak' | 'weak' | 'fair' | 'good' | 'strong';
    /** Whether the password clears the minimum policy bar (length + score). */
    acceptable: boolean;
    /** Human-readable reasons it could be stronger / why it was rejected. */
    warnings: string[];
}

const COMMON_WEAK = new Set([
    'password',
    'passw0rd',
    'password1',
    '12345678',
    '123456789',
    '1234567890',
    'qwertyuiop',
    'letmein',
    'admin',
    'administrator',
    'welcome',
    'changeme',
    'lumastra',
    'jellyfin',
    'iloveyou',
]);

/**
 * Weak base words that remain guessable even with trivial decoration
 * (digits/symbols appended). Matched as a case-insensitive substring.
 */
const COMMON_WEAK_BASES = [
    'password',
    'passw0rd',
    'qwerty',
    'admin',
    'letmein',
    'welcome',
    'changeme',
    'lumastra',
    'jellyfin',
    'iloveyou',
] as const;

const LABELS = ['very weak', 'weak', 'fair', 'good', 'strong'] as const;

/** Minimum score required (in addition to length) for a password to be accepted. */
export const PASSWORD_MIN_SCORE: PasswordStrengthScore = 2;

export function estimatePasswordStrength(password: string): PasswordStrength {
    const warnings: string[] = [];
    const len = password.length;

    const lower = /[a-z]/.test(password);
    const upper = /[A-Z]/.test(password);
    const digit = /\d/.test(password);
    const symbol = /[^A-Za-z0-9]/.test(password);
    const classes = [lower, upper, digit, symbol].filter(Boolean).length;

    let points = 0;
    if (len >= PASSWORD_MIN_LENGTH) points += 1;
    if (len >= 14) points += 1;
    if (len >= 20) points += 1;
    if (classes >= 2) points += 1;
    if (classes >= 3) points += 1;

    // Penalties for low-entropy shapes.
    const normalized = password.toLowerCase();
    if (COMMON_WEAK.has(normalized)) {
        points = 0;
        warnings.push('This is a commonly used password.');
    } else if (COMMON_WEAK_BASES.some((base) => normalized.includes(base))) {
        // Catches "password1234", "admin2024!", "jellyfin99" — a common weak
        // base word with trivial decoration is still guessable.
        points = Math.min(points, 1);
        warnings.push('Avoid building a password around a common word.');
    }
    if (/^(.)\1+$/.test(password)) {
        points = Math.min(points, 1);
        warnings.push('Avoid repeating a single character.');
    }
    if (/^(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf)/i.test(password)) {
        points = Math.min(points, 1);
        warnings.push('Avoid simple sequences like "1234" or "qwer".');
    }

    if (len < PASSWORD_MIN_LENGTH) {
        warnings.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
    } else if (classes < 2) {
        warnings.push('Mix letters with numbers or symbols.');
    } else if (len < 14) {
        warnings.push('Longer passwords are stronger — aim for 14+ characters.');
    }

    const score = Math.max(0, Math.min(4, points)) as PasswordStrengthScore;
    const acceptable = len >= PASSWORD_MIN_LENGTH && score >= PASSWORD_MIN_SCORE;

    return {
        score,
        label: LABELS[score],
        acceptable,
        warnings,
    };
}

/**
 * Server-side gate. Returns an error message if the password is unacceptable, or
 * null if it passes policy. Keep the message generic enough not to leak the exact
 * scoring internals but specific enough to guide the operator.
 */
export function validatePasswordPolicy(password: string): string | null {
    if (password.length < PASSWORD_MIN_LENGTH) {
        return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
        return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
    }
    const { acceptable, warnings } = estimatePasswordStrength(password);
    if (!acceptable) {
        return warnings[0] ?? 'Password is too weak. Add length and a mix of character types.';
    }
    return null;
}
