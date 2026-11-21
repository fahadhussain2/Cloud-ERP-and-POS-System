import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

// Every back-office screen draws with the theme's colour tokens (W2-07 plan, PLT-13, D-066): a fixed white, black or
// hex colour in a class name would not change with the theme. Paper styles (labels, print) live in styles.css, which
// this does not read.

const ROOT = __dirname;
const FIXED = /\b(?:text|bg|border|fill|stroke|ring)-(?:white|black)\b|\[#[0-9a-fA-F]{3,8}\]/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('colours', () => {
  it('come from the theme tokens in every screen', () => {
    const found = sources(ROOT).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (FIXED.test(line) ? [`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(found).toEqual([]);
  });
});
