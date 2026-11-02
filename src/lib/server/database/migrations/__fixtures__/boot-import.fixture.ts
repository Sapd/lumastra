// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Run by migrations-boot-import.test.ts under tsx, the way containers boot.
const schema = await import('../../migrate-schema.js');
if (typeof schema.migrateSchema !== 'function') throw new Error('migrateSchema missing');
if (!Array.isArray(schema.MIGRATIONS)) throw new Error('MIGRATIONS missing');
console.log('boot-import-ok');
process.exit(0);

export {};
