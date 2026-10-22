import { describe, expect, it } from 'vitest';

import { DomainError } from '../errors';

// Golden cases: one JSON file per rule in packages/domain/golden/ (architecture §12, D-079).
// Each case gives an input and either the expected result or the DomainError code it must raise.

export interface GoldenCase<I> {
  name: string;
  input: I;
  expected?: unknown;
  error?: string;
}

export interface GoldenFile<I> {
  description: string;
  cases: GoldenCase<I>[];
}

export function runGolden<I>(file: GoldenFile<I>, fn: (input: I) => unknown): void {
  describe(file.description, () => {
    for (const c of file.cases) {
      it(c.name, () => {
        if (c.error !== undefined) {
          let thrown: unknown;
          try {
            fn(c.input);
          } catch (err) {
            thrown = err;
          }
          expect(thrown, 'expected a DomainError').toBeInstanceOf(DomainError);
          expect((thrown as DomainError).code).toBe(c.error);
        } else {
          expect(fn(c.input)).toStrictEqual(c.expected);
        }
      });
    }
  });
}
