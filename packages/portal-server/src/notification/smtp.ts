/**
 * Real email delivery for `NotificationService` (portal-v0-spec.md §5).
 *
 * Lives in `portal-server`, not `portal-core` — nodemailer/SMTP is an I/O
 * dependency, and `portal-core` stays the same pure, headless layer the
 * root `CLAUDE.md` requires of `@cat-tool/core` for the same reason: the
 * interface and its console stand-in are provable without a network in
 * the loop, and only the shell wires in a transport.
 */
import type {
  NotificationService,
  OrderDeliveredNotice,
  OrderSubmittedNotice,
} from '@cat-tool/portal-core';
import nodemailer, { type Transporter } from 'nodemailer';

import type { SmtpConfig } from '../config.js';

export class SmtpNotificationService implements NotificationService {
  private readonly transporter: Transporter;

  constructor(private readonly config: SmtpConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth:
        config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
    });
  }

  async notifyAdmin(notice: OrderSubmittedNotice): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.from,
      to: this.config.adminEmail,
      subject: `New order #${notice.orderId} submitted — ${notice.clientName}`,
      text:
        `${notice.clientName} submitted order #${notice.orderId}.\n\n` +
        `Review it in the admin portal.`,
    });
  }

  async notifyClient(notice: OrderDeliveredNotice): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.from,
      to: notice.clientEmail,
      subject: `Order #${notice.orderId} delivered`,
      text:
        `Your order #${notice.orderId} has been delivered.\n\n` +
        `Sign in to the client portal to download the final files.`,
    });
  }
}
