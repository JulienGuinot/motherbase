import { describe, expect, it } from 'vitest';
import { Readable } from 'stream';
import sharp from 'sharp';
import {
  outputFormat,
  parseTransformOptions,
  signRenderToken,
  transformImage,
  verifyRenderToken,
} from '../services/storage/image-transform';
import { ImageRenderService } from '../services/storage/image-render.service';

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#3366ff' } }).png().toBuffer();
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('parseTransformOptions', () => {
  it('reads the Supabase query keys and ignores everything else', () => {
    expect(parseTransformOptions({ width: '200', resize: 'contain', token: 'x' })).toEqual({ width: 200, resize: 'contain' });
    expect(parseTransformOptions({ token: 'x' })).toBeNull();
  });

  it('refuses values outside Supabase limits', () => {
    expect(() => parseTransformOptions({ width: '2501' })).toThrow(/width/);
    expect(() => parseTransformOptions({ quality: '5' })).toThrow(/quality/);
    expect(() => parseTransformOptions({ format: 'gif' })).toThrow(/format/);
  });
});

describe('outputFormat', () => {
  it('negotiates WebP only when no format was asked for', () => {
    expect(outputFormat({}, 'image/png', 'image/avif,image/webp,*/*')).toBe('image/webp');
    expect(outputFormat({}, 'image/png', '*/*')).toBe('image/png');
    expect(outputFormat({ format: 'origin' }, 'image/png', 'image/webp')).toBe('image/png');
    expect(outputFormat({ format: 'avif' }, 'image/png')).toBe('image/avif');
  });
});

describe('transformImage', () => {
  it('resizes within the box for contain and to the box for cover', async () => {
    const source = await png(400, 200);
    const contained = await sharp(await collect(transformImage(Readable.from(source), { width: 100, height: 100, resize: 'contain' }, 'image/png'))).metadata();
    expect([contained.width, contained.height]).toEqual([100, 50]);
    const covered = await sharp(await collect(transformImage(Readable.from(source), { width: 100, height: 100 }, 'image/webp'))).metadata();
    expect([covered.width, covered.height, covered.format]).toEqual([100, 100, 'webp']);
  });
});

describe('render tokens', () => {
  const claim = { bucket: 'avatars', key: 'u1/me.png', options: { width: 100 } };

  it('binds the object, the transform and the expiry', () => {
    const token = signRenderToken(claim, Date.now() + 60_000, 'secret');
    expect(verifyRenderToken(token, claim, 'secret')).toBe(true);
    expect(verifyRenderToken(token, { ...claim, options: { width: 2000 } }, 'secret')).toBe(false);
    expect(verifyRenderToken(token, { ...claim, key: 'u2/me.png' }, 'secret')).toBe(false);
    expect(verifyRenderToken(signRenderToken(claim, Date.now() - 1, 'secret'), claim, 'secret')).toBe(false);
  });
});

describe('ImageRenderService', () => {
  const serviceWith = (settings: object, object: { mime: string; contentLength: number }) =>
    new ImageRenderService({
      SettingsService: { get: async () => settings },
      StorageService: {
        streamFileByKey: async () => ({ ...object, body: Readable.from(Buffer.alloc(0)) }),
      },
    } as any);

  it('refuses when the project switched transformations off', async () => {
    const svc = serviceWith({ enabled: false }, { mime: 'image/png', contentLength: 10 });
    await expect(svc.renderAuthenticated('b', 'k', {}, {})).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses a source over the size ceiling and a non-image', async () => {
    await expect(serviceWith({ maxSourceBytes: 5 }, { mime: 'image/png', contentLength: 10 })
      .renderAuthenticated('b', 'k', {}, {})).rejects.toMatchObject({ statusCode: 413 });
    await expect(serviceWith({}, { mime: 'application/pdf', contentLength: 10 })
      .renderAuthenticated('b', 'k', {}, {})).rejects.toMatchObject({ statusCode: 400 });
  });
});
