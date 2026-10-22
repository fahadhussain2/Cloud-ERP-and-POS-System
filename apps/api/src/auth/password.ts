import { hash, verify } from '@node-rs/argon2';

// Argon2id with the OWASP parameters (D-081). @node-rs/argon2 uses Argon2id by default. The parameters are
// stored in the hash string, so they can be raised later and old hashes upgraded at the next login.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const CURRENT = `m=${OPTIONS.memoryCost},t=${OPTIONS.timeCost},p=${OPTIONS.parallelism}`;

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

let dummy: Promise<string> | undefined;
/** A real hash to verify against when there is no user, so an unknown username takes as long as a wrong password. */
const dummyHash = () => (dummy ??= hashPassword('no such user: constant-time dummy'));

export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  try {
    const ok = await verify(stored ?? (await dummyHash()), password);
    return ok && stored !== null;
  } catch {
    return false;
  }
}

/** True when the hash was made with older parameters (or another algorithm) and should be replaced. */
export const needsRehash = (stored: string): boolean => !stored.startsWith(`$argon2id$v=19$${CURRENT}$`);

export type PasswordProblem = 'too_short' | 'too_long' | 'contains_username';

/** At least 10 characters, no composition rules, not containing the username (NIST guidance, D-081). */
export function passwordProblem(password: string, username: string): PasswordProblem | null {
  if ([...password].length < 10) return 'too_short';
  if (password.length > 256) return 'too_long';
  if (username.length >= 3 && password.toLowerCase().includes(username.toLowerCase()))
    return 'contains_username';
  return null;
}
