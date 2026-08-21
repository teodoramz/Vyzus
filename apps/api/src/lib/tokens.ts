// JWT access + refresh token issuance/verification (jose, HS256) and refresh
// token hashing. Access tokens are short-lived (15 min) and carry role/email so
// the role guard needs no DB hit. Refresh tokens are opaque-ish JWTs with a
// random jti; only a SHA-256 hash is stored so a stolen DB can't mint sessions,
// and rotation invalidates the previous token.
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import { USER_ROLES, type UserRole } from '@vyzus/shared';

export interface AccessTokenClaims {
  sub: string;
  role: UserRole;
  email: string;
}

/** What `verifyAccessToken` returns: the claims plus when the token dies. */
export interface VerifiedAccessClaims extends AccessTokenClaims {
  expiresAt: Date;
}

export interface RefreshTokenClaims {
  sub: string;
  jti: string;
}

export class TokenService {
  private readonly secret: Uint8Array;

  constructor(
    jwtSecret: string,
    private readonly accessTtl: string = '15m',
    private readonly refreshTtlDays: number = 7,
  ) {
    this.secret = new TextEncoder().encode(jwtSecret);
  }

  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ role: claims.role, email: claims.email })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(this.accessTtl)
      .sign(this.secret);
  }

  async verifyAccessToken(token: string): Promise<VerifiedAccessClaims> {
    const { payload } = await jwtVerify(token, this.secret);
    return payloadToAccessClaims(payload);
  }

  /** Returns the signed refresh token and its storable SHA-256 hash. */
  async issueRefreshToken(userId: string): Promise<{ token: string; hash: string }> {
    const jti = randomUUID();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime(`${this.refreshTtlDays}d`)
      .sign(this.secret);
    return { token, hash: hashToken(token) };
  }

  async verifyRefreshToken(token: string): Promise<RefreshTokenClaims> {
    const { payload } = await jwtVerify(token, this.secret);
    if (!payload.sub || !payload.jti) throw new Error('Invalid refresh token');
    return { sub: payload.sub, jti: payload.jti };
  }

  get refreshCookieMaxAgeSeconds(): number {
    return this.refreshTtlDays * 24 * 60 * 60;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

function payloadToAccessClaims(payload: JWTPayload): VerifiedAccessClaims {
  const role = payload.role;
  const email = payload.email;
  // `exp` is required, not optional: every token this service signs has one,
  // and a caller that acts on the expiry (see plugins/ws.ts) must not silently
  // treat a missing one as "never expires".
  if (!payload.sub || !isUserRole(role) || typeof email !== 'string' || typeof payload.exp !== 'number') {
    throw new Error('Invalid access token claims');
  }
  return { sub: payload.sub, role, email, expiresAt: new Date(payload.exp * 1000) };
}
