import type { DeviceInfo } from '@crescent/module-sdk';
import type { SerialPort } from 'serialport';
import type { AuditService } from '../audit/audit.service';
import type { NxGenConfig } from '../config/nxgen.config';
import type { DatabaseService } from '../database/database.service';
import type { ModuleRegistry } from '../modules/module-registry';
import { GatewayService } from './gateway.service';
import { encodeCommand, parseEnvelope } from './packet';

describe('packet framing', () => {
  it('reads JSON booleans as text and keeps numbers and strings', () => {
    expect(
      parseEnvelope(
        '{"DEVICE_ID":"M1","PROBE_CONNECTED":true,"ATC":1,"X":"a"}',
      ),
    ).toEqual({
      ok: true,
      deviceIdentifier: 'M1',
      fields: { PROBE_CONNECTED: 'true', ATC: 1, X: 'a' },
    });
  });

  it('still rejects nested values', () => {
    expect(parseEnvelope('{"DEVICE_ID":"M1","X":{"a":1}}')).toMatchObject({
      ok: false,
    });
  });

  it('encodes a command in the packet framing', () => {
    expect(encodeCommand('M1', { CAL: 20 })).toEqual({
      ok: true,
      line: '{"CAL":20,"DEVICE_ID":"M1"}',
    });
  });

  it('refuses commands it could not frame safely', () => {
    expect(encodeCommand('M 1', { CAL: 20 }).ok).toBe(false);
    expect(encodeCommand('M1', {}).ok).toBe(false);
    expect(encodeCommand('M1', { 'A"B': 1 }).ok).toBe(false);
    expect(encodeCommand('M1', { DEVICE_ID: 'other' }).ok).toBe(false);
    expect(encodeCommand('M1', { CAL: Number.NaN }).ok).toBe(false);
    expect(encodeCommand('M1', { X: 'y'.repeat(5000) }).ok).toBe(false);
  });
});

describe('GatewayService.send', () => {
  const device: DeviceInfo = {
    id: 'd-1',
    code: 'PH-1',
    instrumentType: 'PH',
    name: 'pH meter',
    manufacturer: '',
    model: '',
    serialNumber: '',
    location: '',
    status: 'ACTIVE',
    deviceIdentifier: 'M1',
    readiness: { state: 'READY', usable: true, message: '', dueAt: null },
  };
  const query = jest.fn().mockResolvedValue([{ id: '7' }]);
  const write = jest.fn();
  const port = {
    isOpen: true,
    write,
    drain: (cb: (e: Error | null) => void) => cb(null),
  } as unknown as SerialPort;
  let gateway: GatewayService;

  const connected = (lastSeenAt = Date.now()) =>
    gateway['seen'].set('M1', {
      deviceId: device.id,
      code: device.code,
      portPath: '/dev/usb0',
      transport: 'SERIAL',
      lastSeenAt,
    });

  beforeEach(() => {
    query.mockClear();
    write.mockReset();
    write.mockImplementation(
      (_l: string, _e: string, cb: (e: Error | null) => void) => cb(null),
    );
    gateway = new GatewayService(
      { production: false } as NxGenConfig,
      { query } as unknown as DatabaseService,
      {} as AuditService,
      {} as ModuleRegistry,
    );
    gateway['runtime']('/dev/usb0').port = port;
  });

  it('writes one line to the dongle and stores the command', async () => {
    connected();
    await expect(gateway.send(device, { CAL: 20 })).resolves.toEqual({
      sent: true,
      messageId: 7,
    });
    expect(write).toHaveBeenCalledWith(
      '{"CAL":20,"DEVICE_ID":"M1"}\n',
      'utf8',
      expect.any(Function),
    );
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("'OUT'");
    expect(params[2]).toBe('{"CAL":20,"DEVICE_ID":"M1"}');
  });

  it('can skip storing a repeated keep-alive frame', async () => {
    connected();
    await expect(
      gateway.send(device, { B_2: '4.01' }, { persist: false }),
    ).resolves.toEqual({ sent: true, messageId: null });
    expect(query).not.toHaveBeenCalled();
  });

  it('always stores a command the dongle refused', async () => {
    connected();
    write.mockImplementation(
      (_l: string, _e: string, cb: (e: Error | null) => void) =>
        cb(new Error('write failed')),
    );
    await expect(
      gateway.send(device, { B_2: '4.01' }, { persist: false }),
    ).resolves.toEqual({ sent: false, reason: 'write failed' });
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params.slice(-2)).toEqual([false, 'write failed']);
  });

  it('does not send to an instrument that has gone silent', async () => {
    connected(Date.now() - 11_000);
    await expect(gateway.send(device, { CAL: 20 })).resolves.toEqual({
      sent: false,
      reason: 'The instrument is not connected.',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('does not send to an instrument that is not active', async () => {
    connected();
    const result = await gateway.send(
      { ...device, status: 'OUT_OF_SERVICE' },
      { CAL: 20 },
    );
    expect(result.sent).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('reports a closed dongle', async () => {
    connected();
    gateway['runtime']('/dev/usb0').port = null;
    await expect(gateway.send(device, { CAL: 20 })).resolves.toEqual({
      sent: false,
      reason: 'The USB dongle is not connected.',
    });
  });
});

describe('GatewayService live packet monitor', () => {
  const gateway = () =>
    new GatewayService(
      { production: false } as NxGenConfig,
      {
        query: jest.fn().mockResolvedValue([{ id: '1' }]),
      } as unknown as DatabaseService,
      { record: jest.fn() } as unknown as AuditService,
      { handlerFor: () => null } as unknown as ModuleRegistry,
    );

  it('keeps each line with its decision, and returns only newer lines on request', async () => {
    const g = gateway();
    jest.spyOn(g as never, 'device' as never).mockResolvedValue(null as never);
    await g.ingest('{"DEVICE_ID":"PHMETER_a06b","PH_VAL":7.01}', 'SERIAL', '/dev/ttyACM0');
    await g.ingest('not json', 'SERIAL', '/dev/ttyACM0');
    await g.ingest('   ', 'SERIAL', '/dev/ttyACM0');
    const all = g.recentPackets('/dev/ttyACM0');
    expect(all.packets.map((p) => [p.raw, p.deviceIdentifier, p.accepted, p.reason])).toEqual([
      ['{"DEVICE_ID":"PHMETER_a06b","PH_VAL":7.01}', 'PHMETER_a06b', false, 'Instrument not registered'],
      ['not json', null, false, expect.any(String)],
    ]);
    expect(g.recentPackets('/dev/ttyACM0', all.packets[0].seq).packets).toHaveLength(1);
    expect(g.recentPackets('/dev/other').packets).toHaveLength(0);
  });

  it('keeps only the latest 200 lines of a port', async () => {
    const g = gateway();
    jest.spyOn(g as never, 'device' as never).mockResolvedValue(null as never);
    for (let i = 0; i < 230; i++) await g.ingest(`{"DEVICE_ID":"M1","N":${i}}`, 'SERIAL', '/dev/ttyACM0');
    const { packets } = g.recentPackets('/dev/ttyACM0');
    expect(packets).toHaveLength(200);
    expect(packets[0].raw).toBe('{"DEVICE_ID":"M1","N":30}');
  });
});
