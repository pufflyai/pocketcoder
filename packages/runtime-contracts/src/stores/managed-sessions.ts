// Principal is derived from authentication, never from the public request body.
export interface ManagedSessionIdentity {
  principalId: string;
  sessionId: string;
}
export interface ManagedRequestIdentity extends ManagedSessionIdentity {
  requestId: string;
}
