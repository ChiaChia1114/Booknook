import type { Db } from '../db/database';
import { nowIso, uuid } from './util';

export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}

interface Logger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * Gives up on an unreachable or silent mail server within seconds (nodemailer reads options from
 * the URL's query; values set there are kept).
 */
export function withTimeouts(smtpUrl: string): string {
  try {
    const u = new URL(smtpUrl);
    for (const [k, v] of [
      ['connectionTimeout', '10000'],
      ['greetingTimeout', '10000'],
      ['socketTimeout', '20000'],
    ] as const) {
      if (!u.searchParams.has(k)) u.searchParams.set(k, v);
    }
    return u.toString();
  } catch {
    return smtpUrl;
  }
}

/**
 * Sends e-mail through SMTP when SMTP_URL is configured. Without SMTP (development / demo),
 * messages are written to the `outbox` table and the server log so links can be retrieved.
 */
export function createMailer(db: Db, smtpUrl: string | null, from: string, log: Logger): Mailer {
  if (smtpUrl) {
    let transport: { sendMail(o: Record<string, unknown>): Promise<unknown> } | null = null;
    return {
      async send(to, subject, body) {
        if (!transport) {
          const nodemailer = await import('nodemailer');
          transport = nodemailer.createTransport(withTimeouts(smtpUrl));
        }
        try {
          await transport.sendMail({ from, to, subject, text: body });
        } catch (err) {
          log.error({ err, to, subject }, 'failed to send e-mail');
          throw err;
        }
      },
    };
  }
  return {
    async send(to, subject, body) {
      db.run('INSERT INTO outbox (id, to_addr, subject, body, created_at) VALUES (?, ?, ?, ?, ?)', uuid(), to, subject, body, nowIso());
      log.info({ to, subject, body }, 'e-mail (no SMTP configured, stored in outbox)');
    },
  };
}
