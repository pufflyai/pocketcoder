export class ManagerError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409,
    readonly code: string,
  ) {
    super(code);
  }
}
