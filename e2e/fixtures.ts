// Test-only values for the throwaway E2E database (erp_e2e on the local or CI PostgreSQL); never used on a server.

export const SHOP = 'e2e';
export const OWNER = { username: 'owner', fullName: 'Test Owner' };
/** What setup gives the owner; the back office makes them change it at first sign-in (D-083). */
export const OWNER_FIRST_PASSWORD = 'e2e first password';
export const OWNER_PASSWORD = 'e2e second password';
export const SALESMAN = { username: 'asif', fullName: 'Asif Khan', shortCode: '12' };
export const TEMPORARY_PIN = '4831';
export const OWN_PIN = '7395';

export const API_PORT = 3100;
export const POS_PORT = 4173;
export const BACKOFFICE_PORT = 4174;
