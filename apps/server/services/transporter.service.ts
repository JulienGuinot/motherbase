import * as nodemailer from 'nodemailer';
import crypto from 'crypto';
import Mail from 'nodemailer/lib/mailer';
import BaseContext from '../context/base-context';
import { APP_NAME } from '../constants/app.constants';

interface IMailOptions {
  to: string;
  subject: string;
  html?: string;
  attachments?: Mail.Attachment[];
  text?: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  secure: boolean;
}

export class TransporterService extends BaseContext {
  private transport?: nodemailer.Transporter;
  private fingerprint = '';
  private from = '';

  private async transporter(): Promise<nodemailer.Transporter> {
    const cfg = await this.di.SettingsService.get<SmtpConfig>('email.smtp');
    const fp = crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex');
    if (!this.transport || fp !== this.fingerprint) {
      // Implicit TLS is only ever port 465. On 587/25/2525 a `secure: true` here
      // speaks TLS at a plaintext listener and openssl reports
      // "wrong version number"; those ports upgrade with STARTTLS instead.
      const secure = cfg.port === 465 ? cfg.secure !== false : false;
      this.transport = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure,
        requireTLS: !secure,
        auth: { user: cfg.username, pass: cfg.password },
      });
      this.fingerprint = fp;
      this.from = cfg.from || cfg.username;
    }
    return this.transport;
  }

  async sendMail(options: IMailOptions) {
    const t = await this.transporter();
    return t.sendMail({ from: this.from, ...options });
  }

  async sendTestEmail(to: string): Promise<{ ok: true; ms: number }> {
    const started = Date.now();
    await this.sendMail({
      to,
      subject: `${APP_NAME}: SMTP test`,
      html: `<p>Your ${APP_NAME} SMTP configuration works. 🎉</p>`,
    });
    return { ok: true, ms: Date.now() - started };
  }
}
