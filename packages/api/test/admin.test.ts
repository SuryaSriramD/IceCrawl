import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers';

const TOKEN = 'admin-token-of-sufficient-length';
const admin = (token: string = TOKEN) => ({ authorization: `Bearer ${token}` });

describe('/admin/keys', () => {
  it('does not exist unless an admin token is configured', async () => {
    const { app } = await makeApp();
    for (const [method, url] of [['GET', '/admin/keys'], ['POST', '/admin/keys']] as const) {
      expect((await app.inject({ method, url, headers: admin() })).statusCode, url).toBe(404);
    }
  });

  it('needs the admin token, and an API key is not one', async () => {
    const { app, auth } = await makeApp({ adminToken: TOKEN });
    expect((await app.inject({ method: 'GET', url: '/admin/keys' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/keys', headers: admin('wrong-token') })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/keys', headers: auth })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/admin/keys', headers: auth, payload: { name: 'sneaky' } })).statusCode).toBe(401);
  });

  it('creates a key that works, lists it without the secret, and revokes it', async () => {
    const { app } = await makeApp({ adminToken: TOKEN });
    const created = (await app.inject({ method: 'POST', url: '/admin/keys', headers: admin(), payload: { name: 'claude-laptop' } })).json();
    expect(created).toMatchObject({ success: true, data: { name: 'claude-laptop', key: expect.stringMatching(/^ic-[0-9a-f]{48}$/) } });

    const use = () => app.inject({ method: 'GET', url: '/v2/team/queue-status', headers: { authorization: `Bearer ${created.data.key}` } });
    expect((await use()).statusCode).toBe(200);

    const listed = (await app.inject({ method: 'GET', url: '/admin/keys', headers: admin() })).json();
    const mine = listed.data.keys.find((k: { id: string }) => k.id === created.data.id);
    expect(mine).toMatchObject({ name: 'claude-laptop', revoked: false });
    expect(JSON.stringify(listed)).not.toContain(created.data.key);

    expect((await app.inject({ method: 'DELETE', url: `/admin/keys/${created.data.id}`, headers: admin() })).json()).toEqual({ success: true });
    expect((await use()).statusCode).toBe(401);
    const after = (await app.inject({ method: 'GET', url: '/admin/keys', headers: admin() })).json();
    expect(after.data.keys.find((k: { id: string }) => k.id === created.data.id).revoked).toBe(true);
  });

  it('defaults the name, validates input and answers 404 for an unknown key', async () => {
    const { app } = await makeApp({ adminToken: TOKEN });
    const unnamed = (await app.inject({ method: 'POST', url: '/admin/keys', headers: admin(), payload: {} })).json();
    expect(unnamed.data.name).toBe('default');
    expect((await app.inject({ method: 'POST', url: '/admin/keys', headers: admin(), payload: { name: 'x'.repeat(101) } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/admin/keys/not-a-uuid', headers: admin() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/admin/keys/11111111-1111-4111-8111-111111111111', headers: admin() })).statusCode).toBe(404);
  });

  it('locks a client out after ten wrong tokens, even for the right one', async () => {
    const { app } = await makeApp({ adminToken: TOKEN });
    for (let i = 0; i < 10; i++) expect((await app.inject({ method: 'GET', url: '/admin/keys', headers: admin(`wrong-${i}`) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/keys', headers: admin() })).statusCode).toBe(429);
  });
});
