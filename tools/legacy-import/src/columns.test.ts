import { describe, expect, it } from 'vitest';

import { isCredentialColumn, looksLikeCnic } from './columns';

// Credentials and CNICs are never stored (CLAUDE.md rule 11, D-084).
describe('credential columns', () => {
  it.each([
    'UserPassword',
    'Password',
    'PWD',
    'user_pwd',
    'PassWord',
    'PIN',
    'StaffPin',
    'CNIC',
    'CNICNo',
    'NIC_No',
    'Passwd',
  ])('%s is dropped', (name) => expect(isCredentialColumn(name)).toBe(true));

  it.each(['Nickname', 'Pincushion', 'ItemName', 'Passage', 'Mechanic', 'Phone', 'CompanyID', 'Spinner'])(
    '%s is kept',
    (name) => expect(isCredentialColumn(name)).toBe(false),
  );
});

describe('CNIC-shaped values', () => {
  it.each(['42101-1234567-1', '4210112345671', ' 42101-1234567-1 '])('%s looks like a CNIC', (v) =>
    expect(looksLikeCnic(v)).toBe(true),
  );

  it.each([
    '0300-1234567',
    '03001234567',
    '42101-1234567',
    '421011234567',
    '42101123456712',
    'OIL 42101-1234567-1 X',
  ])('%s does not', (v) => expect(looksLikeCnic(v)).toBe(false));
});
