import dns from 'dns';
import { errorCode, errorMessage } from '../../lib/errors';
import net from 'net';

const dnsPromises = dns.promises;

export interface DnsCheck {
  name: string;
  target: string;
  ok: boolean;
  message: string;
}

export class DiagnosticsService {
  constructor(private cfg: { domainSuffix: string; mode: 'dev' | 'prod' }) {}

  async consoleDns(host?: string): Promise<DnsCheck[]> {
    const cleanHost = (host || '').split(':')[0] || (this.cfg.mode === 'dev' ? 'localhost' : this.cfg.domainSuffix);
    const checks = [await this.lookup('console host', cleanHost)];

    if (this.cfg.mode === 'prod' && this.cfg.domainSuffix) {
      checks.push(await this.lookup('wildcard project DNS', `motherbase-check.${this.cfg.domainSuffix}`));
    }

    return checks;
  }

  async projectDns(project: { name: string; domain: string; storageDomain?: string }): Promise<DnsCheck[]> {
    return [
      await this.lookup('api domain', project.domain),
      ...(project.storageDomain ? [await this.lookup('storage domain', project.storageDomain)] : []),
      await this.tcp('http', project.domain, this.cfg.mode === 'dev' ? 80 : 443),
    ];
  }

  private async lookup(name: string, target: string): Promise<DnsCheck> {
    if (!target) return { name, target, ok: false, message: 'missing target' };
    if (target === 'localhost' || target.endsWith('.localhost')) {
      return { name, target, ok: true, message: 'localhost resolves locally' };
    }
    try {
      const records = await dnsPromises.lookup(target, { all: true });
      return { name, target, ok: records.length > 0, message: records.map(r => r.address).join(', ') || 'no records' };
    } catch (err) {
      return { name, target, ok: false, message: errorCode(err) || errorMessage(err) || 'lookup failed' };
    }
  }

  private tcp(name: string, host: string, port: number): Promise<DnsCheck> {
    if (!host) return Promise.resolve({ name, target: `${host}:${port}`, ok: false, message: 'missing host' });
    if (this.cfg.mode === 'dev' && (host === 'localhost' || host.endsWith('.localhost'))) {
      return Promise.resolve({ name, target: `${host}:${port}`, ok: true, message: 'dev localhost routing' });
    }
    return new Promise(resolve => {
      const socket = net.connect({ host, port, timeout: 2500 });
      const done = (ok: boolean, message: string) => {
        socket.destroy();
        resolve({ name, target: `${host}:${port}`, ok, message });
      };
      socket.once('connect', () => done(true, 'reachable'));
      socket.once('timeout', () => done(false, 'timeout'));
      socket.once('error', err => done(false, (err as any)?.code || err.message));
    });
  }
}
