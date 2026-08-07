// Password hashing (argon2id) and constant-time verification.
import argon2 from 'argon2';
// argon2 0.45 renamed `Options` to `HashOptions` and split `hash` into two
// overloads keyed on `raw`; the type is a named export rather than a member of
// the default export, so it has to be imported explicitly.
import type { HashOptions } from 'argon2';

// No `raw`, so the string overload applies and the result is the encoded
// digest (which is what `verify` expects and what the users table stores).
const options: HashOptions = { type: argon2.argon2id };

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, options);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
