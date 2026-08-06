// Password hashing (argon2id) and constant-time verification.
import argon2 from 'argon2';

const options: argon2.Options = { type: argon2.argon2id };

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
