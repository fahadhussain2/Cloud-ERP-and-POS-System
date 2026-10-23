import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { binaryDateTime, textDateTime } from './datetime';
import { DumpError } from './errors';

// SSMS "Generate Scripts" output (importer spec §3, D-084). Values are kept as the source wrote them, with only
// the encoding undone; nothing is computed in floating point (CLAUDE.md rule 1).

export interface InsertStatement {
  /** The table name without schema or brackets, e.g. `INV_Item`. */
  table: string;
  columns: string[];
  rows: (string | null)[][];
  /** The line the INSERT starts on (1-based). */
  line: number;
}

const DATETIME_TYPES = new Set(['datetime', 'datetime2', 'smalldatetime']);
/** One-line statements, skipped: batch ends, settings and SSMS progress messages (`print 'Processed 100…'`). */
const LINES = new Set(['GO', 'SET', 'USE', 'PRINT']);
/**
 * Schema and settings batches, skipped up to the next GO. An INSERT hidden in one would still be counted by
 * the line scan, so the count check catches it (D-084).
 */
const BATCHES = new Set(['CREATE', 'ALTER', 'IF', 'EXEC']);
const DATE_TYPES = new Set([...DATETIME_TYPES, 'date', 'time', 'datetimeoffset']);

class Scanner {
  pos = 0;
  private readonly newlines: number[] = [];

  constructor(
    private readonly text: string,
    private readonly file: string,
  ) {
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) this.newlines.push(i);
  }

  lineAt(pos: number): number {
    let lo = 0;
    let hi = this.newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.newlines[mid]! < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  }

  error(message: string, pos = this.pos, code: 'syntax' | 'bad_datetime' = 'syntax'): DumpError {
    return new DumpError(code, message, this.file, this.lineAt(pos));
  }

  done(): boolean {
    return this.pos >= this.text.length;
  }

  /** Matches `re` (sticky) at the current position and moves past it. */
  take(re: RegExp): string | null {
    re.lastIndex = this.pos;
    const m = re.exec(this.text);
    if (!m) return null;
    this.pos = re.lastIndex;
    return m[0];
  }

  skipSpace(): void {
    for (;;) {
      this.take(/\s+/y);
      if (this.take(/--[^\n]*/y) !== null) continue;
      if (this.text.startsWith('/*', this.pos)) {
        const end = this.text.indexOf('*/', this.pos + 2);
        this.pos = end === -1 ? this.text.length : end + 2;
        continue;
      }
      return;
    }
  }

  peekWord(): string {
    const re = /[A-Za-z_]+/y;
    re.lastIndex = this.pos;
    return re.exec(this.text)?.[0].toUpperCase() ?? '';
  }

  expect(re: RegExp, what: string): string {
    this.skipSpace();
    const got = this.take(re);
    if (got === null) throw this.error(`expected ${what}`);
    return got;
  }

  skipLine(): void {
    const end = this.text.indexOf('\n', this.pos);
    this.pos = end === -1 ? this.text.length : end + 1;
  }

  /** A skipped batch: everything up to the next `GO` line. */
  skipBatch(): void {
    const re = /^[ \t]*GO[ \t]*\r?$/gim;
    re.lastIndex = this.pos;
    const m = re.exec(this.text);
    this.pos = m ? re.lastIndex : this.text.length;
  }

  /** `[dbo].[INV_Item]`, `dbo.T` or `[T]`: the last part, without brackets. */
  name(): string {
    let last: string;
    do {
      last = this.expect(/\[[^\]\r\n]+\]|[A-Za-z_][A-Za-z0-9_]*/y, 'a name').replace(/^\[|\]$/g, '');
    } while (this.take(/\./y) !== null);
    return last;
  }

  string(): string {
    const start = this.pos;
    this.take(/N?'/y);
    let out = '';
    for (;;) {
      const q = this.text.indexOf("'", this.pos);
      if (q === -1) throw this.error('unterminated string', start);
      out += this.text.slice(this.pos, q);
      this.pos = q + 1;
      if (this.text[this.pos] !== "'") return out;
      out += "'";
      this.pos += 1;
    }
  }

  value(): string | null {
    this.skipSpace();
    const start = this.pos;
    const c = this.text[this.pos];
    if (c === "'" || (c === 'N' && this.text[this.pos + 1] === "'")) return this.string();
    const word = this.peekWord();
    if (word === 'NULL') {
      this.pos += 4;
      return null;
    }
    if (word === 'CAST') return this.cast();
    const hex = this.take(/0x[0-9A-Fa-f]*/y);
    if (hex !== null) return hex.toLowerCase();
    const num = this.take(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/y);
    if (num !== null) return num;
    throw this.error('unknown value', start);
  }

  /** `CAST(x AS T)`: a DateTime becomes ISO text; anything else keeps x's text (decimals digit for digit). */
  cast(): string | null {
    const start = this.pos;
    this.pos += 4;
    this.expect(/\(/y, '(');
    this.skipSpace();
    const binary = this.take(/0x[0-9A-Fa-f]*/y);
    const inner = binary ?? this.value();
    this.expect(/AS\b/iy, 'AS');
    const type = this.expect(/[A-Za-z_][A-Za-z0-9_]*/y, 'a type').toLowerCase();
    this.skipSpace();
    if (this.take(/\(/y) !== null) this.expect(/[^)]*\)/y, ')');
    this.expect(/\)/y, ')');
    if (inner === null) return null;
    if (binary !== null) {
      if (type === 'datetime') {
        try {
          return binaryDateTime(binary.slice(2));
        } catch {
          throw this.error('bad DateTime', start, 'bad_datetime');
        }
      }
      // Other binary date encodings aren't decoded: refuse rather than stage them as hex.
      if (DATE_TYPES.has(type)) throw this.error(`unsupported binary ${type}`, start);
      return binary.toLowerCase();
    }
    if (!DATETIME_TYPES.has(type)) return inner;
    const text = textDateTime(inner);
    if (text === null) throw this.error('bad DateTime', start, 'bad_datetime');
    return text;
  }

  insert(): InsertStatement {
    const line = this.lineAt(this.pos);
    this.pos += 'INSERT'.length;
    this.skipSpace();
    if (this.peekWord() === 'INTO') this.pos += 4;
    const table = this.name();
    this.expect(/\(/y, '(');
    const columns: string[] = [];
    do columns.push(this.name());
    while (this.expect(/[,)]/y, ', or )') === ',');
    this.expect(/VALUES\b/iy, 'VALUES');
    const rows: (string | null)[][] = [];
    do {
      const rowStart = this.pos;
      this.expect(/\(/y, '(');
      const row: (string | null)[] = [];
      do row.push(this.value());
      while (this.expect(/[,)]/y, ', or )') === ',');
      if (row.length !== columns.length)
        throw this.error(`a row has ${row.length} values for ${columns.length} columns`, rowStart);
      rows.push(row);
      this.skipSpace();
    } while (this.take(/,/y) !== null);
    this.take(/;/y);
    return { table, columns, rows, line };
  }
}

/** The INSERT statements of one script, in order. Stops at the first statement it doesn't know. */
export function* parseScript(text: string, file: string): Generator<InsertStatement> {
  const s = new Scanner(text, file);
  for (;;) {
    s.skipSpace();
    if (s.done()) return;
    const word = s.peekWord();
    if (LINES.has(word)) s.skipLine();
    else if (BATCHES.has(word)) s.skipBatch();
    else if (word === 'INSERT') yield s.insert();
    else throw s.error(word ? `unexpected statement ${word}` : 'unexpected text');
  }
}

/**
 * Data rows as SSMS writes them, `INSERT [` at the start of a line, found without the parser: the independent
 * count (D-084). INSERTs in procedure code are indented or use INTO, so they don't count.
 */
export const countInsertLines = (text: string): number => text.match(/^INSERT \[/gm)?.length ?? 0;

/** Reads a dump file as SSMS writes it: UTF-16 LE, usually with a byte-order mark. */
export async function readDumpFile(path: string): Promise<{ text: string; sha256: string }> {
  const buf = await readFile(path);
  const bom = buf[0] === 0xff && buf[1] === 0xfe;
  // Without a BOM, ASCII text in UTF-16 LE has a zero in every second byte.
  if (!bom && !(buf.length >= 2 && buf[1] === 0 && buf[0] !== 0))
    throw new DumpError('not_utf16', 'not a UTF-16 LE file', path);
  return {
    text: new TextDecoder('utf-16le').decode(buf),
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}
