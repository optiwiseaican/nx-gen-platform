#!/usr/bin/env node
/**
 * AICAN License Portal — activation keys (VENDOR-ONLY). Uses the portal's database settings (config.ts).
 *
 *   keys create --customer-id <id> --customer-name <name> [--site <site>] [--modules tlc,ph]
 *               [--devices 1] [--type PERPETUAL|SUBSCRIPTION] [--expires YYYY-MM-DD]
 *               [--users N] [--instruments N] [--note <text>]
 *   keys list
 *   keys show <NXG-...>        the computers it activated
 *   keys revoke <NXG-...>      no further activations (licences already issued keep working offline)
 */
import { parseArgs } from 'util';
import { generateActivationCode, parseActivationCode } from '@crescent/licensing';
import { portalStore } from './config';

const MODULE_ID = /^[a-z][a-z0-9-]{1,31}$/;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const store = portalStore();
  try {
    await store.migrate();
    if (command === 'create') {
      const { values } = parseArgs({
        args: rest,
        options: {
          'customer-id': { type: 'string' },
          'customer-name': { type: 'string' },
          site: { type: 'string' },
          modules: { type: 'string', default: '' },
          devices: { type: 'string', default: '1' },
          type: { type: 'string', default: 'PERPETUAL' },
          expires: { type: 'string' },
          users: { type: 'string' },
          instruments: { type: 'string' },
          note: { type: 'string' },
        },
      });
      if (!values['customer-id'] || !values['customer-name']) throw new Error('--customer-id and --customer-name are required');
      const modules = values.modules!.split(',').map((m) => m.trim()).filter(Boolean);
      for (const m of modules) if (!MODULE_ID.test(m)) throw new Error(`Invalid module id "${m}"`);
      const devices = Number(values.devices);
      if (!Number.isInteger(devices) || devices < 1) throw new Error('--devices must be a whole number ≥ 1');
      const type = values.type!.toUpperCase();
      if (type !== 'PERPETUAL' && type !== 'SUBSCRIPTION') throw new Error('--type is PERPETUAL or SUBSCRIPTION');
      const expiresAt = values.expires ? new Date(`${values.expires}T23:59:59Z`) : null;
      if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error('--expires is YYYY-MM-DD');
      if (type === 'SUBSCRIPTION' && !expiresAt) throw new Error('A SUBSCRIPTION key needs --expires');
      const optionalInt = (v?: string) => (v === undefined ? null : Number(v));
      const key = await store.createKey({
        code: generateActivationCode(),
        customerId: values['customer-id'],
        customerName: values['customer-name'],
        site: values.site ?? null,
        licenseType: type,
        expiresAt,
        modules,
        deviceLimit: devices,
        userLimit: optionalInt(values.users),
        instrumentLimit: optionalInt(values.instruments),
        note: values.note ?? null,
      });
      console.log(`Activation key: ${key.code}`);
      console.log(`  ${key.customerName} (${key.customerId})${key.site ? `, ${key.site}` : ''}`);
      console.log(`  ${key.licenseType}${key.expiresAt ? ` until ${key.expiresAt.toISOString().slice(0, 10)}` : ''}; modules: ${key.modules.join(', ') || 'platform only'}; computers: ${key.deviceLimit}`);
    } else if (command === 'list') {
      for (const k of await store.listKeys()) {
        const state = k.revokedAt ? 'REVOKED' : k.expiresAt && k.expiresAt < new Date() ? 'EXPIRED' : 'ACTIVE';
        console.log(`${k.code}  ${state.padEnd(7)}  ${String(k.computers).padStart(2)}/${k.deviceLimit} computers  ${k.customerName}  [${k.modules.join(',')}]`);
      }
    } else if (command === 'show' || command === 'revoke') {
      const parsed = parseActivationCode(rest[0] ?? '');
      if (!parsed.valid) throw new Error('Give the activation key: NXG-XXXX-XXXX-XXXX');
      if (command === 'revoke') console.log((await store.revokeKey(parsed.code)) ? `Revoked ${parsed.code}` : `No active key ${parsed.code}`);
      else for (const a of await store.activations(parsed.code)) console.log(`${a.issuedAt.toISOString()}  ${a.instanceId}  ${a.channel}  licence ${a.licenseId}`);
    } else {
      console.log('Usage: keys create | list | show <key> | revoke <key>   (see the header of src/cli.ts)');
      process.exitCode = command ? 1 : 0;
    }
  } finally {
    await store.pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
