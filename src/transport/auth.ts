import type { Principal } from '../session/contracts';
import { fields, identifier, object } from '../session/commands';

export class AuthenticationError extends Error {
  constructor(readonly code: 'unauthenticated' | 'identity_unavailable') { super(code); }
}
export interface IdentityAdapter {
  verify(authorization: string): Promise<Principal>;
}
/** An adapter result is still runtime data; copy only the bounded identity fields we actually use. */
export function verifiedPrincipal(value: unknown): Principal {
  try {
    const data = object(value); fields(data, ['accountId', 'clientId', 'connectionId']);
    return { accountId: identifier(data.accountId), clientId: identifier(data.clientId), connectionId: identifier(data.connectionId) };
  } catch { throw new AuthenticationError('identity_unavailable'); }
}
export const unavailableIdentity: IdentityAdapter = {
  async verify() { throw new AuthenticationError('identity_unavailable'); },
};
