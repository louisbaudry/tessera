export class VendorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VendorError';
  }
}
