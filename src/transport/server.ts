import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import websocket from '@fastify/websocket';
import type { DatabaseProbe } from '../database/connection';
import { SessionError } from '../session/contracts';
import type { Principal } from '../session/contracts';
import { CommandFailure, dispatchCommand } from '../session/commands';
import type { SessionService } from '../session/service';
import { AuthenticationError, unavailableIdentity, verifiedPrincipal } from './auth';
import type { IdentityAdapter } from './auth';
import { registerDashboard } from '../dashboard/routes';
import type { DashboardOptions } from '../dashboard/routes';
import { liveChannel } from './live-channel';
import type { LiveOptions } from './live-channel';

export type ServerOptions = { service: SessionService; identity?: IdentityAdapter; database: DatabaseProbe; storage?: DatabaseProbe; dashboard?: DashboardOptions; live?: LiveOptions };
export function errorResult(error: unknown): { status: number; body: { ok: false; error: string; commandId?: string } } {
  if (error instanceof CommandFailure) {
    const result = errorResult(error.reason); return { ...result, body: { ...result.body, commandId: error.commandId } };
  }
  if (error instanceof AuthenticationError) return { status: error.code === 'unauthenticated' ? 401 : 503, body: { ok: false, error: error.code } };
  if (error instanceof SessionError) {
    const status = error.code === 'invalid_input' ? 400 : error.code === 'not_found' ? 404
      : ['no_access', 'forbidden'].includes(error.code) ? 403 : ['provider_unavailable', 'content_storage_unconfigured'].includes(error.code) ? 503 : 409;
    return { status, body: { ok: false, error: error.code } };
  }
  return { status: 500, body: { ok: false, error: 'internal_error' } };
}

export async function createServer(options: ServerOptions) {
  if (options.live && (!Number.isSafeInteger(options.live.pollIntervalMs ?? 1000) || (options.live.pollIntervalMs ?? 1000) < 1)) throw new Error('Invalid live poll interval');
  const app = Fastify({ logger: false, bodyLimit: 16_384, onProtoPoisoning: 'error', onConstructorPoisoning: 'error' });
  const channels = new Map<WebSocket, { stop(): void; drain(): Promise<void> }>();
  app.addHook('preClose', async () => {
    const entries = [...channels];
    for (const [socket, channel] of entries) { channel.stop(); socket.terminate(); }
    await Promise.all(entries.map(([, channel]) => channel.drain()));
  });
  await app.register(websocket, { options: { maxPayload: 16_384, perMessageDeflate: false } });
  const identity = options.identity ?? unavailableIdentity;
  const principals = new WeakMap<FastifyRequest, Principal>();
  async function authenticate(request: FastifyRequest) {
    // No credentials in query strings or client/account claims in command payloads.
    if (Object.keys((request.query ?? {}) as object).length) throw new SessionError('invalid_input');
    const authorization = request.headers.authorization;
    if (!authorization || !/^Bearer [^\s]+$/.test(authorization)) throw new AuthenticationError('unauthenticated');
    const principal = verifiedPrincipal(await identity.verify(authorization));
    principals.set(request, principal);
  }
  app.setErrorHandler((error, _request, reply) => {
    const code = (error as { code?: string }).code;
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send({ ok: false, error: 'unsupported_media_type' });
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ ok: false, error: 'payload_too_large' });
    if (code === 'FST_ERR_CTP_INVALID_JSON_BODY' || error instanceof SyntaxError) return reply.code(400).send({ ok: false, error: 'invalid_input' });
    const response = errorResult(error); return reply.code(response.status).send(response.body);
  });
  app.get('/health', async () => ({ ok: true, service: 'mind-space-backend', profile: 'internal-test-v1' }));
  registerDashboard(app, options.dashboard);
  app.get('/ready', async (_request, reply) => {
    const database = await options.database.check();
    const storage = await options.storage?.check();
    return reply.code(503).send({ ok: false, profile: 'internal-test-v1', components: {
      databaseConnection: database ? 'reachable' : 'unavailable', durableSessionStore: storage ? 'available' : 'unavailable',
      identity: 'unavailable', dialogue: 'unavailable', speech: 'unavailable',
    } });
  });
  app.post('/v1/session/commands', { preValidation: authenticate }, async request => {
    const value = await dispatchCommand(options.service, principals.get(request)!, request.body);
    return { ok: true, profile: 'internal-test-v1', ...value };
  });
  app.get('/v1/session/channel', { websocket: true, preValidation: authenticate }, (socket, request) => {
    let pending = 0, chain = Promise.resolve();
    const initial = principals.get(request)!;
    function enqueue(work: () => Promise<void>) { chain = chain.then(work).catch(() => { socket.terminate(); }); return chain; }
    function send(value: unknown) {
      if (socket.readyState !== 1) return false;
      const payload = JSON.stringify(value);
      if (socket.bufferedAmount + Buffer.byteLength(payload) > 65_536) { socket.close(1013, 'Output capacity reached'); return false; }
      socket.send(payload, error => { if (error) socket.terminate(); }); return true;
    }
    async function verify() {
      const principal = verifiedPrincipal(await identity.verify(request.headers.authorization!));
      if (principal.accountId !== initial.accountId || principal.clientId !== initial.clientId || principal.connectionId !== initial.connectionId) throw new AuthenticationError('unauthenticated');
      return principal;
    }
    function fail(error: unknown) {
      send(errorResult(error).body);
      if (socket.readyState === 1) socket.close(error instanceof AuthenticationError ? 1008 : error instanceof SessionError ? 1008 : 1011, 'Live state unavailable');
    }
    const live = options.live ? liveChannel(socket, options.live, options.service, verify, enqueue, fail, send) : undefined;
    channels.set(socket, { stop: () => { live?.stop(); }, drain: () => chain });
    socket.on('close', () => { live?.stop(); channels.delete(socket); });
    socket.on('error', () => {});
    socket.on('message', (bytes, binary) => {
      if (binary) { socket.close(1003, 'Text JSON required'); return; }
      if (pending >= 8) { socket.close(1013, 'Command capacity reached'); return; }
      pending++;
      // Attach listener synchronously and serialize commands within each connection.
      void enqueue(async () => {
        if (socket.readyState !== 1) return;
        try {
          let raw: unknown;
          try { raw = JSON.parse(bytes.toString()); } catch { throw new SessionError('invalid_input'); }
          // Revalidate each command, including identity expiration/revocation after the handshake.
          const principal = await verify();
          const value = await dispatchCommand(options.service, principal, raw);
          if (send({ ok: true, profile: 'internal-test-v1', ...value })) live?.bind(value.value.snapshot);
        } catch (error) {
          const response = errorResult(error);
          if (socket.readyState === 1) {
            send(response.body);
            if (error instanceof AuthenticationError) socket.close(1008, 'Identity no longer available');
          }
        }
      }).finally(() => { pending--; });
    });
  });
  app.addHook('onClose', async () => { await options.database.close(); await options.storage?.close(); });
  return app;
}
