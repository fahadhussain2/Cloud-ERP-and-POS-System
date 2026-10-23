import { describe, expect, it } from 'vitest';

import { DumpError } from '../errors';

// Golden cases for the importer (tools/legacy-import/golden/*.json), like packages/domain's (D-079).
// A case gives an input and either the expected result or the error it must raise: a DumpError code
// (a string) or the line it must point at ({ line }).

export interface GoldenFile<I> {
  description: string;
  cases: { name: string; input: I; expected?: unknown; error?: string | { line: number } }[];
}

export function runGolden<I>(file: GoldenFile<I>, fn: (input: I) => unknown): void {
  describe(file.description, () => {
    for (const c of file.cases) {
      it(c.name, () => {
        if (c.error === undefined) {
          expect(fn(c.input)).toStrictEqual(c.expected);
          return;
        }
        let thrown: unknown;
        try {
          fn(c.input);
        } catch (err) {
          thrown = err;
        }
        expect(thrown, 'expected a DumpError').toBeInstanceOf(DumpError);
        if (typeof c.error === 'string') expect((thrown as DumpError).code).toBe(c.error);
        else expect((thrown as DumpError).line).toBe(c.error.line);
      });
    }
  });
}
