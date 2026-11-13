// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import ts from 'typescript';

const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'fallback']);

export function exportedMethods(source: string): string[] {
    const file = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
    const names: string[] = [];
    for (const statement of file.statements) {
        if (
            ts.isFunctionDeclaration(statement) &&
            statement.name &&
            statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        )
            names.push(statement.name.text);
        if (
            ts.isExportDeclaration(statement) &&
            statement.exportClause &&
            ts.isNamedExports(statement.exportClause)
        ) {
            names.push(...statement.exportClause.elements.map((element) => element.name.text));
        }
        if (
            ts.isVariableStatement(statement) &&
            statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        ) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
                if (ts.isObjectBindingPattern(declaration.name))
                    names.push(
                        ...declaration.name.elements.map((element) => element.name.getText(file)),
                    );
            }
        }
    }
    return names.filter((name) => methods.has(name)).sort();
}
