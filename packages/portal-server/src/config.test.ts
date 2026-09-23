import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('omits smtp config when PORTAL_SMTP_HOST is unset — falls back to console notifications', () => {
    const config = loadConfig({});
    expect(config.smtp).toBeUndefined();
  });

  it('builds smtp config from env when PORTAL_SMTP_HOST is set', () => {
    const config = loadConfig({
      PORTAL_SMTP_HOST: 'smtp.example.com',
      PORTAL_SMTP_PORT: '2525',
      PORTAL_SMTP_SECURE: 'true',
      PORTAL_SMTP_USER: 'user',
      PORTAL_SMTP_PASS: 'pass',
      PORTAL_SMTP_FROM: 'Portal <portal@example.com>',
      PORTAL_ADMIN_EMAIL: 'admin@example.com',
    });
    expect(config.smtp).toEqual({
      host: 'smtp.example.com',
      port: 2525,
      secure: true,
      user: 'user',
      pass: 'pass',
      from: 'Portal <portal@example.com>',
      adminEmail: 'admin@example.com',
    });
  });

  it('rejects PORTAL_SMTP_HOST without PORTAL_ADMIN_EMAIL', () => {
    expect(() => loadConfig({ PORTAL_SMTP_HOST: 'smtp.example.com' })).toThrow(
      /PORTAL_ADMIN_EMAIL/,
    );
  });
});
