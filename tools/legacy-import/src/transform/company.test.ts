import { describe, expect, it } from 'vitest';

import { companyDetails } from './company';

// The shop's own details for the bill header (owner answer 2, W0-13): company fields and the parameter rows that
// look like company details, never a credential.
describe('company details', () => {
  const company = [
    {
      companyid: '1',
      companyname: ' DELUX  AUTOS ',
      ntnnumber: '1234567-8',
      salestaxnumber: '',
      zipcode: null,
      status: '1',
    },
  ];
  const parameters = [
    {
      fielddescription: 'Company Address',
      fieldname: 'CompanyAddress',
      fieldvalue1: 'Shop 1, Plaza',
      fieldvalue2: null,
    },
    {
      fielddescription: 'Phone No',
      fieldname: 'Phone',
      fieldvalue1: '021-1234567',
      fieldvalue2: '0300-7654321',
    },
    {
      fielddescription: 'Report Footer',
      fieldname: 'RptFooter',
      fieldvalue1: 'No return without bill',
      fieldvalue2: '',
    },
    {
      fielddescription: 'Email Password',
      fieldname: 'EmailPassword',
      fieldvalue1: 'secret-1',
      fieldvalue2: null,
    },
    { fielddescription: 'SMTP PWD', fieldname: 'SmtpPwd', fieldvalue1: 'secret-2', fieldvalue2: null },
    { fielddescription: 'Default Printer', fieldname: 'Printer', fieldvalue1: 'EPSON LQ', fieldvalue2: null },
    { fielddescription: 'Company Email', fieldname: 'Email', fieldvalue1: '  ', fieldvalue2: null },
  ];

  it('takes the name, NTN and sales-tax number, and the address, phone and header lines', () => {
    expect(companyDetails(company, parameters)).toEqual([
      { field: 'Company name', value: 'DELUX AUTOS' },
      { field: 'NTN', value: '1234567-8' },
      { field: 'Company Address', value: 'Shop 1, Plaza' },
      { field: 'Phone No', value: '021-1234567 / 0300-7654321' },
      { field: 'Report Footer', value: 'No return without bill' },
    ]);
  });

  it('never shows a credential, even when its name looks like a company detail', () => {
    const shown = JSON.stringify(companyDetails(company, parameters));
    expect(shown).not.toContain('secret');
    expect(shown).not.toContain('EPSON');
  });

  it('is empty without the tables', () => {
    expect(companyDetails([], [])).toEqual([]);
  });
});
