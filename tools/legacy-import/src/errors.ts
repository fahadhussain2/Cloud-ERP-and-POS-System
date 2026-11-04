// Importer errors (D-084). A message names the file, line, table or column, never a value: values can be
// personal data (CLAUDE.md rule 11).

export type DumpErrorCode =
  | 'syntax'
  | 'bad_datetime'
  | 'not_utf16'
  | 'personal_data'
  | 'count_mismatch'
  | 'columns_changed'
  | 'bad_label'
  | 'no_files'
  | 'bad_amount'
  | 'bad_quantity'
  | 'bad_date'
  | 'unknown_doc_type';

export class DumpError extends Error {
  constructor(
    readonly code: DumpErrorCode,
    message: string,
    readonly file?: string,
    readonly line?: number,
  ) {
    super(file === undefined ? message : `${file}${line === undefined ? '' : ` line ${line}`}: ${message}`);
    this.name = 'DumpError';
  }
}
