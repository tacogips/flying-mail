/** Symmetric encryption for stored third-party credentials -- today only
 * CalDAV app-specific passwords.
 *
 * `available` is `false` when the deployment has no key configured. Callers
 * check it and fail with `SERVICE_UNAVAILABLE` before doing any work, rather
 * than discovering the problem halfway through a sync. */
export interface CredentialCipher {
  readonly available: boolean;
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}
