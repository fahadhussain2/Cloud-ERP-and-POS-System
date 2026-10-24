import { isCredentialColumn } from '../columns';
import { cleanText } from './rules';
import type { Row } from './masters';

// The shop's own details for the bill header (owner answer 2, W0-13): from Admin_Company and the Admin_Parameter
// rows that look like company details. Never a credential: those rows are skipped whatever else they say.

const DETAIL =
  /address|phone|mobile|cell|tel|fax|e-?mail|ntn|strn|gst|sales ?tax|web|header|footer|slogan|title|company/i;
const SECRET = /secret|token|key|smtp/i;

export function companyDetails(company: Row[], parameters: Row[]): { field: string; value: string }[] {
  const out: { field: string; value: string }[] = [];
  const c = company[0];
  if (c) {
    for (const [column, field] of [
      ['companyname', 'Company name'],
      ['ntnnumber', 'NTN'],
      ['salestaxnumber', 'Sales-tax number'],
    ] as const) {
      const value = cleanText(c[column]);
      if (value !== null) out.push({ field, value });
    }
  }
  for (const p of parameters) {
    const names = [p['fieldname'] ?? '', p['fielddescription'] ?? ''];
    if (names.some((n) => isCredentialColumn(n) || SECRET.test(n)) || !names.some((n) => DETAIL.test(n)))
      continue;
    const value = [cleanText(p['fieldvalue1']), cleanText(p['fieldvalue2'])]
      .filter((v) => v !== null)
      .join(' / ');
    if (value !== '')
      out.push({ field: cleanText(p['fielddescription']) ?? cleanText(p['fieldname'])!, value });
  }
  return out;
}
