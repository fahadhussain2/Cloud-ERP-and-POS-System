import { describe, expect, it } from 'vitest';

// Golden cases: one JSON file per rule in packages/posting/golden/ (architecture §12), like packages/domain's.

export interface GoldenCase<I> {
  name: string;
  input: I;
  expected: unknown;
}

export interface GoldenFile<I> {
  description: string;
  /** What the cases assume, for the reader. */
  notes?: string;
  cases: GoldenCase<I>[];
}

export function runGolden<I>(file: GoldenFile<I>, fn: (input: I) => unknown): void {
  describe(file.description, () => {
    for (const c of file.cases) it(c.name, () => expect(fn(c.input)).toStrictEqual(c.expected));
  });
}
