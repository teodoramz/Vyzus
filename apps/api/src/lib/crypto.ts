// Re-export of the shared AES-256-GCM helper (moved to @vyzus/shared/crypto
// in Phase 3 so the worker can decrypt app credentials at run time).
export { encryptJson, decryptJson } from '@vyzus/shared/crypto';
