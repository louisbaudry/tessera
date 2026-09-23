/**
 * Notification (portal-v0-spec.md §5).
 *
 * One interface, one v0 implementation that just logs — a real email
 * adapter (SMTP, a provider API) implements the same interface later;
 * nothing calling `NotificationService` changes.
 */

export interface OrderSubmittedNotice {
  readonly kind: 'order_submitted';
  readonly orderId: number;
  readonly clientName: string;
}

export interface OrderDeliveredNotice {
  readonly kind: 'order_delivered';
  readonly orderId: number;
  readonly clientEmail: string;
}

export type Notice = OrderSubmittedNotice | OrderDeliveredNotice;

export interface NotificationService {
  notifyAdmin(notice: OrderSubmittedNotice): Promise<void> | void;
  notifyClient(notice: OrderDeliveredNotice): Promise<void> | void;
}

/** v0 placeholder: logs what would be sent instead of actually sending it. */
export class ConsoleNotificationService implements NotificationService {
  notifyAdmin(notice: OrderSubmittedNotice): void {
    console.log(
      `[notify] order #${notice.orderId} submitted by ${notice.clientName} — admin notified`,
    );
  }

  notifyClient(notice: OrderDeliveredNotice): void {
    console.log(
      `[notify] order #${notice.orderId} delivered — would email ${notice.clientEmail}`,
    );
  }
}
