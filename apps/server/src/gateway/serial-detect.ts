/**
 * Recognises which serial ports on a workstation are USB-to-UART adapters (the
 * AICAN dongle is one), and which are Bluetooth or built-in ports that never
 * carry instrument data. Pure: the caller supplies the operating system's list.
 */

/** What `SerialPort.list()` reports for a port. */
export interface RawPort {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  vendorId?: string;
  productId?: string;
  friendlyName?: string;
}

export type PortKind = 'USB_UART' | 'USB_SERIAL' | 'BLUETOOTH' | 'SYSTEM';

export interface DetectedPort {
  /** The path to open. On macOS the call-out device (/dev/cu.*), which does not wait for a carrier. */
  path: string;
  /** Other names the operating system gives the same port (on macOS, /dev/tty.*). */
  aliases: string[];
  kind: PortKind;
  /** The bridge chip, when the USB IDs identify one, e.g. "FTDI FT232R". */
  chip: string | null;
  manufacturer: string | null;
  serialNumber: string | null;
  vendorId: string | null;
  productId: string | null;
  /** Could be the instrument dongle: a USB serial port. */
  usable: boolean;
}

/** USB-to-UART bridge chips by vendor ID, and by product ID where the vendor makes several. */
const CHIPS: Record<string, { vendor: string; products: Record<string, string> }> = {
  '0403': { vendor: 'FTDI', products: { '6001': 'FT232R', '6010': 'FT2232', '6011': 'FT4232', '6014': 'FT232H', '6015': 'FT231X / FT230X' } },
  '10c4': { vendor: 'Silicon Labs', products: { ea60: 'CP210x', ea70: 'CP2105', ea71: 'CP2108' } },
  '1a86': { vendor: 'WCH', products: { '7523': 'CH340', '7522': 'CH340K', '5523': 'CH341', '55d4': 'CH9102', '55d3': 'CH343' } },
  '067b': { vendor: 'Prolific', products: { '2303': 'PL2303', '23a3': 'PL2303GC', '23c3': 'PL2303GT' } },
  '04d8': { vendor: 'Microchip', products: { '00dd': 'MCP2221', '000a': 'CDC serial' } },
  '0483': { vendor: 'STMicroelectronics', products: { '5740': 'Virtual COM port' } },
  '303a': { vendor: 'Espressif', products: { '1001': 'USB serial/JTAG' } },
  '2341': { vendor: 'Arduino', products: {} },
  '2a03': { vendor: 'Arduino', products: {} },
  '1366': { vendor: 'SEGGER', products: {} },
  '0d28': { vendor: 'Arm DAPLink', products: { '0204': 'CMSIS-DAP' } },
};

/** Port names that only USB serial drivers create. */
const USB_NAME = /(usbserial|usbmodem|wchusbserial|SLAB_USBtoUART|ttyUSB|ttyACM|ttyCH34|ttyCP)/i;
const BLUETOOTH_NAME = /(bluetooth|-SerialPort|rfcomm)/i;

const hex = (v: string | undefined) => (v ? v.toLowerCase().replace(/^0x/, '').padStart(4, '0') : null);

function kindOf(p: RawPort, vendorId: string | null, platform: NodeJS.Platform): PortKind {
  const pnp = p.pnpId ?? '';
  if (vendorId && CHIPS[vendorId]) return 'USB_UART';
  // Built-in UARTs: Linux /dev/ttyS* and PCI serial controllers report the chipset's
  // vendor (Intel 8086, AMD 1022) but are not USB, and never carry dongle data.
  if (/^\/dev\/ttyS\d+$/.test(p.path) || /^pci-|^ACPI\\|^PCI\\/i.test(pnp)) return 'SYSTEM';
  if (/^BTHENUM/i.test(pnp) || BLUETOOTH_NAME.test(p.path) || BLUETOOTH_NAME.test(p.friendlyName ?? '')) return 'BLUETOOTH';
  if (vendorId || /^USB\\/i.test(pnp) || USB_NAME.test(p.path)) return 'USB_SERIAL';
  if (platform === 'darwin') {
    // macOS gives every paired Bluetooth device a serial port with no USB IDs.
    return /debug-console/i.test(p.path) ? 'SYSTEM' : 'BLUETOOTH';
  }
  return 'SYSTEM'; // COM1 on the motherboard, /dev/ttyS*, and the like
}

/** On macOS each port appears as /dev/tty.X and /dev/cu.X; the cu device is the one to open. */
function canonicalPath(path: string, platform: NodeJS.Platform) {
  if (platform === 'darwin' && path.startsWith('/dev/tty.')) {
    return { path: `/dev/cu.${path.slice('/dev/tty.'.length)}`, aliases: [path] };
  }
  if (platform === 'darwin' && path.startsWith('/dev/cu.')) {
    return { path, aliases: [`/dev/tty.${path.slice('/dev/cu.'.length)}`] };
  }
  return { path, aliases: [] as string[] };
}

const ORDER: Record<PortKind, number> = { USB_UART: 0, USB_SERIAL: 1, BLUETOOTH: 2, SYSTEM: 3 };

export function classifyPorts(raw: RawPort[], platform: NodeJS.Platform = process.platform): DetectedPort[] {
  const byPath = new Map<string, DetectedPort>();
  for (const p of raw) {
    if (!p?.path) continue;
    const vendorId = hex(p.vendorId);
    const productId = hex(p.productId);
    const { path, aliases } = canonicalPath(p.path, platform);
    const chipInfo = vendorId ? CHIPS[vendorId] : undefined;
    const kind = kindOf(p, vendorId, platform);
    const port: DetectedPort = {
      path,
      aliases,
      kind,
      chip: chipInfo ? [chipInfo.vendor, (productId && chipInfo.products[productId]) || null].filter(Boolean).join(' ') : null,
      manufacturer: p.manufacturer?.trim() || null,
      serialNumber: p.serialNumber?.trim() || null,
      vendorId,
      productId,
      usable: kind === 'USB_UART' || kind === 'USB_SERIAL',
    };
    const prev = byPath.get(path);
    // The same port listed twice (tty and cu): keep the entry with more detail.
    if (!prev || (!prev.vendorId && port.vendorId)) byPath.set(path, port);
  }
  return [...byPath.values()].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.path.localeCompare(b.path));
}

/** Whether a configured port path names this detected port. */
export const matchesPort = (configuredPath: string, port: DetectedPort) =>
  configuredPath === port.path || port.aliases.includes(configuredPath);
