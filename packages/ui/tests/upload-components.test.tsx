import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createClient, memoryStorage } from '@motherbase/client';
import { AvatarUpload, FilesUpload, FileUpload, MotherbaseProvider, UserButton, acceptsFile, rejectFile } from '../src/index.js';

afterEach(cleanup);

const user = { id: 'u1', email: 'ada@example.com', name: 'Ada' };

function clientWithRoutes(routes: Record<string, (init: RequestInit) => unknown>) {
  const fetchSpy = vi.fn(async (url: string, init: RequestInit = {}) => {
    const route = routes[new URL(url).pathname];
    if (!route) throw new Error(`Unexpected request: ${url}`);
    return new Response(JSON.stringify(route(init)), { status: 200 });
  });
  const client = createClient('https://api.example.com', undefined, { storage: memoryStorage(), fetch: fetchSpy as unknown as typeof fetch });
  return { client, fetchSpy };
}

const png = (name: string) => new File(['x'], name, { type: 'image/png' });
const chooseFiles = (files: File[]) => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files } });
const uploadRoute = { '/api/files/': () => ({ file: { id: 'f1' } }) };

describe('upload validation', () => {
  it('applies <input accept> rules to dropped files', () => {
    expect(acceptsFile({ name: 'a.png', type: 'image/png' }, 'image/*')).toBe(true);
    expect(acceptsFile({ name: 'a.pdf', type: 'application/pdf' }, 'image/*')).toBe(false);
    expect(acceptsFile({ name: 'DATA.CSV', type: '' }, '.csv, image/*')).toBe(true);
    expect(acceptsFile({ name: 'a.bin', type: '' })).toBe(true);
    expect(rejectFile({ name: 'big.png', type: 'image/png', size: 5000 }, { maxSize: 1024 })).toMatch(/larger than/);
    expect(rejectFile({ name: 'big.png', type: 'image/png', size: 5000 }, { maxSize: 1024 }, { tooLarge: name => `${name} est trop lourd.` })).toBe('big.png est trop lourd.');
  });
});

describe('FileUpload', () => {
  it('uploads the chosen file under the requested key', async () => {
    const { client, fetchSpy } = clientWithRoutes(uploadRoute);
    const onUploaded = vi.fn();
    render(<FileUpload client={client} bucket="docs" path={file => `reports/${file.name}`} onUploaded={onUploaded} />);
    chooseFiles([png('a.png')]);

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ path: 'reports/a.png' }), expect.any(File)));
    expect((fetchSpy.mock.calls[0][1].body as FormData).get('bucket')).toBe('docs');
  });

  it('rejects a file before sending it', async () => {
    const { client, fetchSpy } = clientWithRoutes(uploadRoute);
    render(<FileUpload client={client} bucket="docs" accept="application/pdf" />);
    chooseFiles([png('a.png')]);

    expect((await screen.findByRole('alert')).textContent).toMatch(/not an accepted file type/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('FilesUpload', () => {
  it('reports each file and keeps going after a rejection', async () => {
    const { client } = clientWithRoutes(uploadRoute);
    const onUploaded = vi.fn();
    render(<FilesUpload client={client} bucket="docs" accept="image/*" onUploaded={onUploaded} />);
    chooseFiles([png('a.png'), new File(['x'], 'b.pdf', { type: 'application/pdf' })]);

    expect(await screen.findByText('Uploaded')).toBeTruthy();
    expect(screen.getByText(/b.pdf is not an accepted/)).toBeTruthy();
    expect(onUploaded).toHaveBeenCalledWith([expect.objectContaining({ path: 'a.png' })]);
  });
});

describe('AvatarUpload', () => {
  it('stores the public URL of the uploaded picture on the user', async () => {
    const updates: unknown[] = [];
    const { client } = clientWithRoutes({
      ...uploadRoute,
      '/api/auth/sign-in/email': () => ({ token: 't', user }),
      '/api/auth/update-user': init => { updates.push(JSON.parse(init.body as string)); return { status: true }; },
      '/api/auth/get-session': () => ({ session: { token: 't' }, user: { ...user, image: 'https://cdn.example.com/new.png' } }),
    });
    await client.auth.signIn.email({ email: user.email, password: 'password' });
    const onChange = vi.fn();
    render(<MotherbaseProvider client={client}><AvatarUpload onChange={onChange} /></MotherbaseProvider>);
    await screen.findByText('Change photo');
    chooseFiles([png('me.png')]);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(updates[0]).toEqual({ image: expect.stringMatching(/\/avatars\/files\/u1%2Favatar\?v=\d+$/) });
  });
});

describe('UserButton items', () => {
  it('renders custom lines as links or buttons', async () => {
    const { client } = clientWithRoutes({ '/api/auth/sign-in/email': () => ({ token: 't', user }) });
    await client.auth.signIn.email({ email: user.email, password: 'password' });
    const onClick = vi.fn();
    render(<MotherbaseProvider client={client}><UserButton items={[{ label: 'Billing', href: '/billing' }, { label: 'Help', onClick }]} /></MotherbaseProvider>);

    fireEvent.click(await screen.findByText('Ada'));
    expect(screen.getByRole('link', { name: 'Billing' }).getAttribute('href')).toBe('/billing');
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    expect(onClick).toHaveBeenCalled();
  });
});
