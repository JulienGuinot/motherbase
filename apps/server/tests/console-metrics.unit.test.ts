import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { PlatformMetricsService, parseVolumeUsage } from '../console/services/metrics.service';
import { PlatformSettingsService } from '../console/services/settings.service';

describe('PlatformMetricsService', () => {
  it('groups docker volume sizes by project and labels the known volumes', () => {
    const projects = parseVolumeUsage('acme_db_data\t1.5GB\nacme_minio_data\t500MB\nother-p_db_data\t2kB\n\njunk\n');
    expect(projects.map(p => p.project)).toEqual(['acme', 'other-p']);
    expect(projects[0].size).toBe(2e9);
    expect(projects[0].volumes[0]).toEqual({ name: 'db_data', label: 'Database', size: 1.5e9 });
    expect(projects[0].volumes[1].label).toBe('Storage files');
  });

  it('caches volume sizes between disk() calls and reports the host filesystem', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'acme_db_data\t1MB\n', stderr: '' });
    const svc = new PlatformMetricsService(exec as any, process.cwd());
    const first = await svc.disk();
    const second = await svc.disk();
    expect(exec).toHaveBeenCalledOnce();
    expect(second.projects).toEqual(first.projects);
    expect(first.host!.total).toBeGreaterThan(0);
    expect(first.host!.used + first.host!.free).toBeLessThanOrEqual(first.host!.total);
  });

  it('parses docker stats and aggregates per project', async () => {
    const stdout = [
      JSON.stringify({ Name: 'acme-api-1', CPUPerc: '12.50%', MemPerc: '3.10%', MemUsage: '120MiB / 2GiB', NetIO: '1.2MB / 800kB' }),
      JSON.stringify({ Name: 'acme-db-1', CPUPerc: '5.00%', MemPerc: '8.00%', MemUsage: '300MiB / 2GiB', NetIO: '0B / 0B' }),
      JSON.stringify({ Name: 'other-api-1', CPUPerc: '1.00%', MemPerc: '1.00%', MemUsage: '50MiB / 2GiB', NetIO: '0B / 0B' }),
      JSON.stringify({ Name: 'acme-edge-runtime-1', CPUPerc: '0.50%', MemPerc: '1.00%', MemUsage: '40MiB / 2GiB', NetIO: '0B / 0B' }),
      JSON.stringify({ Name: 'shop-api-1', CPUPerc: '0.10%', MemPerc: '1.00%', MemUsage: '40MiB / 2GiB', NetIO: '0B / 0B' }),
      'garbage-not-json',
    ].join('\n');
    const exec = vi.fn().mockResolvedValue({ stdout, stderr: '' });
    const svc = new PlatformMetricsService(exec as any);

    const { containers, projects } = await svc.perProject();
    expect(containers).toHaveLength(5); // garbage row skipped
    expect(containers[0]).toMatchObject({ project: 'acme', service: 'api' });
    expect(containers[0].memUsed).toBe(Math.round(120 * 1024 ** 2));
    // A hyphenated service stays with its project; a hyphenated project keeps its name.
    expect(containers[3]).toMatchObject({ project: 'acme', service: 'edge-runtime' });
    expect(containers[4]).toMatchObject({ project: 'shop', service: 'api' });

    const acme = projects.find(p => p.project === 'acme')!;
    expect(acme.containers).toBe(3);
    expect(acme.cpuPercent).toBeCloseTo(18, 1);
    expect(projects[0].project).toBe('acme'); // sorted by cpu desc
  });

  it("keeps a project's edge runtime inside that project, for real docker stats rows", async () => {
    // Every field `docker stats --no-stream --format '{{json .}}'` prints.
    const row = (name: string, cpu: string, mem: string) => JSON.stringify({
      BlockIO: '0B / 0B', CPUPerc: cpu, Container: name, ID: 'f0e1d2c3b4a5', MemPerc: '1.00%',
      MemUsage: `${mem} / 7.6GiB`, Name: name, NetIO: '1.2kB / 0B', PIDs: '12',
    });
    const stdout = [
      row('shop-api-1', '2.10%', '180MiB'),
      row('shop-db-1', '0.80%', '75MiB'),
      row('shop-minio-1', '0.10%', '90MiB'),
      row('shop-edge-runtime-1', '0.30%', '60MiB'),
      row('app-edge-runtime-1', '0.20%', '55MiB'),
      row('app-api-1', '1.00%', '150MiB'),
    ].join('\n');
    const svc = new PlatformMetricsService(vi.fn().mockResolvedValue({ stdout, stderr: '' }) as any);

    const { projects } = await svc.perProject();
    expect(projects.map(p => p.project).sort()).toEqual(['app', 'shop']);
    const shop = projects.find(p => p.project === 'shop')!;
    expect(shop.containers).toBe(4);
    expect(shop.cpuPercent).toBeCloseTo(3.3, 1);
  });

  it('coalesces concurrent callers and reuses one docker stats sample', async () => {
    const stdout = JSON.stringify({
      Name: 'acme-api-1', CPUPerc: '1.00%', MemPerc: '1.00%', MemUsage: '10MiB / 2GiB', NetIO: '0B / 0B',
    });
    // Resolve on demand so both callers are genuinely in flight together.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const exec = vi.fn(async () => {
      await gate;
      return { stdout, stderr: '' };
    });
    const svc = new PlatformMetricsService(exec as any);

    const both = Promise.all([svc.containers(), svc.containers()]);
    release();
    const [first, second] = await both;

    // Two overlapping callers, one spawn.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);

    // And a caller arriving inside the TTL reuses the sample rather than
    // spawning again: this is what keeps N open browser tabs costing what one
    // tab costs.
    await svc.containers();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('annotates projects with usage-vs-quota when limits are injected', async () => {
    const stdout = [
      JSON.stringify({ Name: 'acme-api-1', CPUPerc: '50.00%', MemPerc: '3.10%', MemUsage: '256MiB / 2GiB', NetIO: '0B / 0B' }),
      JSON.stringify({ Name: 'acme-db-1', CPUPerc: '75.00%', MemPerc: '8.00%', MemUsage: '256MiB / 2GiB', NetIO: '0B / 0B' }),
    ].join('\n');
    const exec = vi.fn().mockResolvedValue({ stdout, stderr: '' });
    const svc = new PlatformMetricsService(exec as any);

    // The edge runtime counts like any service: 1 + 0.5 + 0.25 + 0.25 = 2 cores,
    // (512+512+256+256)MiB of memory.
    const limits = { acme: { apiCpus: 1, apiMemMb: 512, dbCpus: 0.5, dbMemMb: 512, minioCpus: 0.25, minioMemMb: 256, edgeCpus: 0.25, edgeMemMb: 256 } };
    const { projects } = await svc.perProject(limits as any);
    const acme = projects.find(p => p.project === 'acme')!;

    expect(acme.cpuLimit).toBeCloseTo(2, 2);
    expect(acme.memLimitBytes).toBe((512 + 512 + 256 + 256) * 1024 ** 2);
    // usage cpu = 125% (of one core) -> /2 = 62.5%
    expect(acme.cpuPct).toBeCloseTo(62.5, 0);
    // usage mem = 512MiB / 1536MiB ≈ 33.3%
    expect(acme.memPct).toBeCloseTo(33.3, 0);
  });

  it('perProject() with no limits arg is unchanged (no quota fields)', async () => {
    const stdout = JSON.stringify({ Name: 'acme-api-1', CPUPerc: '10.00%', MemPerc: '1.00%', MemUsage: '10MiB / 2GiB', NetIO: '0B / 0B' });
    const svc = new PlatformMetricsService(vi.fn().mockResolvedValue({ stdout, stderr: '' }) as any);
    const { projects } = await svc.perProject();
    expect(projects[0].cpuLimit).toBeUndefined();
    expect(projects[0].memPct).toBeUndefined();
  });

  it('guards divide-by-zero when a limit is zero', async () => {
    const stdout = JSON.stringify({ Name: 'z-api-1', CPUPerc: '5.00%', MemPerc: '1.00%', MemUsage: '10MiB / 2GiB', NetIO: '0B / 0B' });
    const svc = new PlatformMetricsService(vi.fn().mockResolvedValue({ stdout, stderr: '' }) as any);
    const limits = { z: { apiCpus: 0, apiMemMb: 0, dbCpus: 0, dbMemMb: 0, minioCpus: 0, minioMemMb: 0, edgeCpus: 0, edgeMemMb: 0 } };
    const { projects } = await svc.perProject(limits as any);
    expect(projects[0].cpuPct).toBe(0);
    expect(projects[0].memPct).toBe(0);
  });

  it('returns empty stats when docker is unavailable', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('no docker'));
    const svc = new PlatformMetricsService(exec as any);
    const { containers, projects, host } = await svc.perProject();
    expect(containers).toEqual([]);
    expect(projects).toEqual([]);
    expect(host.cpuCount).toBeGreaterThan(0);
  });
});

describe('PlatformSettingsService', () => {
  it('only keeps editable server keys', () => {
    const picked = PlatformSettingsService.pickServerKeys({
      apiImage: 'img:1', mode: 'prod', adminPasswordHash: 'x', traefikNetwork: ' net ',
      certResolver: '', alertWebhookUrl: '',
    });
    expect(picked).toEqual({ apiImage: 'img:1', traefikNetwork: 'net', alertWebhookUrl: '' });
  });

  it('merges patches over persisted state and ignores undefined', async () => {
    const file = path.join('d', 'console-settings.json');
    const store: Record<string, string> = { [file]: JSON.stringify({ apiImage: 'old', certResolver: 'le' }) };
    const fsx = {
      readFile: vi.fn(async (p: string) => store[p] ?? Promise.reject(new Error('enoent'))),
      writeFile: vi.fn(async (p: string, data: string) => { store[p] = data; }),
      mkdir: vi.fn(async () => {}),
    };
    const svc = new PlatformSettingsService({ projectsDir: 'd' }, fsx as any);
    const next = await svc.update({ apiImage: 'new', adminEmail: undefined });
    expect(next).toEqual({ apiImage: 'new', certResolver: 'le' });
  });
});
