import type { TestItem } from '@erp/db/testing';

// Test-only values for the throwaway E2E database (erp_e2e on the local or CI PostgreSQL); never used on a server.

export const SHOP = 'e2e';
export const OWNER = { username: 'owner', fullName: 'Test Owner' };
/** What setup gives the owner; the back office makes them change it at first sign-in (D-083). */
export const OWNER_FIRST_PASSWORD = 'e2e first password';
export const OWNER_PASSWORD = 'e2e second password';
export const SALESMAN = { username: 'asif', fullName: 'Asif Khan', shortCode: '12' };
export const TEMPORARY_PIN = '4831';
export const OWN_PIN = '7395';
/** Added by the owner in the back office (W1-04): a manager with a back-office password, and a counter-only salesman. */
export const MANAGER = {
  username: 'bilqees',
  fullName: 'Bilqees Manager',
  shortCode: '77',
  temporaryPassword: 'e2e manager temporary',
  password: 'e2e manager own password',
  temporaryPin: '2468',
  pin: '5826',
};
export const NEWCOMER = {
  username: 'bilal',
  fullName: 'Bilal Ahmed',
  shortCode: '34',
  temporaryPin: '3916',
  pin: '6071',
};

/** Added by the owner for the cash desk (W1-10): a cashier with a temporary PIN they replace at the desk. */
export const CASHIER = {
  username: 'ayesha',
  fullName: 'Ayesha Cashier',
  shortCode: '56',
  temporaryPin: '3719',
  pin: '6284',
};

export const API_PORT = 3100;
export const POS_PORT = 4173;
export const BACKOFFICE_PORT = 4174;

/**
 * A small catalog in Delux's shape (W1-03): codes, OEM numbers, vehicle tags, three tiers, an inactive item. W1-05: a
 * floor on the brake pads, none elsewhere (the list price is the floor, D-092), and a hose sold by the metre.
 */
export const CATALOG: TestItem[] = [
  {
    code: 'BRPD001',
    name: 'BRAKE PADS FRONT COROLLA',
    category: 'BRPD',
    brand: 'KASHIYAMA',
    origin: 'JAPAN',
    variant: 'FRONT',
    bin: 'R3-B2',
    floor: 400000,
    oem: ['04465-02220'],
    vehicles: [{ make: 'TOYOTA', model: 'COROLLA', from: 2009, to: 2014 }],
    prices: { RETAIL: 450000, MECHANIC: 427500, WHOLESALE: 405000 },
  },
  {
    code: 'BRPD003',
    name: 'BRAKE PADS REAR COROLLA',
    category: 'BRPD',
    variant: 'REAR',
    status: 'dormant',
    oem: ['04466-02200'],
    vehicles: [{ make: 'TOYOTA', model: 'COROLLA', from: 2015 }],
    prices: { RETAIL: 380000 },
  },
  {
    code: 'FNBL001',
    name: 'FAN BELT CULTUS 4PK-855',
    category: 'FNBL',
    spec: '4PK-855',
    oem: ['17521-77E00'],
    vehicles: [{ make: 'SUZUKI', model: 'CULTUS', from: 2017 }],
    prices: { RETAIL: 130000 },
  },
  {
    code: 'FNBL002',
    name: 'FAN BELT MEHRAN',
    category: 'FNBL',
    oem: ['17521-80000'],
    vehicles: [{ make: 'SUZUKI', model: 'MEHRAN', from: 1989, to: 2019 }],
    prices: { RETAIL: 90000 },
  },
  {
    code: 'AFLT001',
    name: 'AIR FILTER COROLLA',
    category: 'AFLT',
    oem: ['17801-0D060'],
    vehicles: [{ make: 'TOYOTA', model: 'COROLLA', from: 2009, to: 2014 }],
    prices: { RETAIL: 140000 },
  },
  {
    code: 'ENOL001',
    name: 'ENGINE OIL 10W-40 4L',
    category: 'ENOL',
    origin: 'JAPAN',
    prices: { RETAIL: 690000 },
  },
  {
    code: 'HOSE001',
    name: 'FUEL HOSE 8MM',
    category: 'HOSE',
    unit: 'METER',
    fractional: true,
    floor: 18000,
    prices: { RETAIL: 20000 },
  },
];

/**
 * Credit customers (W1-09): Khan Motors on the Mechanic tier with a Rs 10,000 limit and a Rs 5,000 offline cap;
 * Rehman Autos on Retail with no limit and a Rs 2,000 offline cap. Money in paisa.
 */
export const CUSTOMERS = [
  {
    code: 'C0042',
    name: 'Khan Motors',
    phones: ['0300-1234567'],
    city: 'Karachi',
    tier: 'MECHANIC',
    creditLimit: 1_000_000,
    offlineDailyCap: 500_000,
  },
  {
    code: 'C0077',
    name: 'Rehman Autos',
    phones: ['0321-7654321'],
    city: 'Karachi',
    tier: 'RETAIL',
    creditLimit: null,
    offlineDailyCap: 200_000,
  },
];
