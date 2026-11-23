#!/usr/bin/env node
/**
 * athena-utm-authority – a reference flight authority (docs/UTM_AUTHORITY.md) for trying the
 * external UTM authorisation of Athena-sky without an account at a real service.
 *
 *   athena-utm-authority [--port 4700] [--host 127.0.0.1] [--key secret] [--mode approve|review|reject]
 *
 * approve: plans up to 120 m are approved at once (higher ones rejected); review: every plan
 * waits for a decision in the console at http://host:port/; reject: every plan is rejected.
 * With --key, the protocol and the console require it (console: http://host:port/?key=<key>);
 * the public safety map (/map) does not.
 * Then start the server with ATHENA_UTM_AUTHORITY_URL=http://host:port (and _KEY, _NAME).
 */
import { startMockAuthority } from './mock-authority';

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = (arg('mode') ?? 'approve') as 'approve' | 'review' | 'reject';
if (!['approve', 'review', 'reject'].includes(mode)) {
  console.error('--mode must be approve, review or reject');
  process.exit(2);
}
const a = await startMockAuthority({ port: Number(arg('port') ?? 4700), host: arg('host') ?? '127.0.0.1', key: arg('key') ?? null, decide: mode });
const key = arg('key');
console.log(`Flight authority (${mode}) listening on ${a.url} – console ${a.url}/${key ? '?key=<key>' : ''}, safety map ${a.url}/map`);
const stop = () => void a.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
