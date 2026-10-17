/**
 * A fresh signing key pair for Convex Auth (docs/runbook-cutover.md §1). Prints
 * the two environment variables to set on the deployment; nothing is stored.
 *
 *   bun scripts/convex-cutover/auth-keys.ts
 */
import { exportJWK, exportPKCS8, generateKeyPair } from 'jose';

const keys = await generateKeyPair('RS256', { extractable: true });
const privateKey = (await exportPKCS8(keys.privateKey)).trimEnd().replace(/\n/g, ' ');
const jwks = JSON.stringify({ keys: [{ use: 'sig', ...(await exportJWK(keys.publicKey)) }] });
console.log(`JWT_PRIVATE_KEY="${privateKey}"`);
console.log(`JWKS=${jwks}`);
