import type { Principal } from '../session/contracts';

export class AuthenticationError extends Error {
  constructor(readonly code: 'unauthenticated' | 'identity_unavailable') { super(code); }
}
export interface IdentityAdapter {
  verify(authorization: string): Promise<Principal>;
}
export const unavailableIdentity: IdentityAdapter = {
  async verify() { throw new AuthenticationError('identity_unavailable'); },
};
