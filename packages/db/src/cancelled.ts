/**
 * Thrown by a bulk operation that was asked to stop and did, at a point
 * where stopping is clean (backlog #16a). Inside a transaction it rolls
 * the transaction back, so "stopped" and "nothing written" are the same
 * thing. Not an error in the sense of something having gone wrong:
 * the job runner reports it as a cancellation, not a failure.
 */
export class Cancelled extends Error {
  constructor(message = 'the operation was cancelled') {
    super(message);
    this.name = 'Cancelled';
  }
}
