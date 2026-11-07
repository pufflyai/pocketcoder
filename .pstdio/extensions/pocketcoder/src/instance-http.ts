export class InstanceHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`PocketCoder HTTP ${status}: ${body}`);
    this.name = "InstanceHttpError";
  }
}
