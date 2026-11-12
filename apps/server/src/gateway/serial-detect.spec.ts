import { classifyPorts, matchesPort } from './serial-detect';

describe('serial port detection', () => {
  it('recognises USB-to-UART adapters by their USB IDs and lists them first', () => {
    const ports = classifyPorts(
      [
        { path: '/dev/tty.Rockerz650Pro' },
        { path: '/dev/tty.debug-console' },
        { path: '/dev/tty.usbserial-A10K3L2B', manufacturer: 'FTDI', vendorId: '0403', productId: '6001', serialNumber: 'A10K3L2B' },
        { path: '/dev/tty.wchusbserial1420', vendorId: '1A86', productId: '7523' },
        { path: '/dev/tty.SLAB_USBtoUART', vendorId: '10c4', productId: 'ea60' },
      ],
      'darwin',
    );
    expect(ports.map((p) => [p.path, p.kind, p.chip, p.usable])).toEqual([
      ['/dev/cu.SLAB_USBtoUART', 'USB_UART', 'Silicon Labs CP210x', true],
      ['/dev/cu.usbserial-A10K3L2B', 'USB_UART', 'FTDI FT232R', true],
      ['/dev/cu.wchusbserial1420', 'USB_UART', 'WCH CH340', true],
      ['/dev/cu.Rockerz650Pro', 'BLUETOOTH', null, false],
      ['/dev/cu.debug-console', 'SYSTEM', null, false],
    ]);
  });

  it('opens the macOS call-out device and still matches a port saved under its tty name', () => {
    const [p] = classifyPorts([{ path: '/dev/tty.usbserial-1', vendorId: '0403', productId: '6015' }], 'darwin');
    expect(p.path).toBe('/dev/cu.usbserial-1');
    expect(matchesPort('/dev/tty.usbserial-1', p)).toBe(true);
    expect(matchesPort('/dev/cu.usbserial-1', p)).toBe(true);
    expect(matchesPort('/dev/cu.usbserial-2', p)).toBe(false);
  });

  it('lists a port reported under both names once, keeping the USB details', () => {
    const ports = classifyPorts([{ path: '/dev/cu.usbmodem101' }, { path: '/dev/tty.usbmodem101', vendorId: '2341', productId: '0043' }], 'darwin');
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({ path: '/dev/cu.usbmodem101', kind: 'USB_UART', chip: 'Arduino' });
  });

  it('treats an unknown USB serial device as usable, and Windows Bluetooth and motherboard ports as not', () => {
    const ports = classifyPorts(
      [
        { path: 'COM1', pnpId: 'ACPI\\PNP0501\\0' },
        { path: 'COM7', pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}' },
        { path: 'COM5', pnpId: 'USB\\VID_1234&PID_5678\\0001', vendorId: '1234', productId: '5678' },
      ],
      'win32',
    );
    expect(ports.map((p) => [p.path, p.kind, p.usable])).toEqual([
      ['COM5', 'USB_SERIAL', true],
      ['COM7', 'BLUETOOTH', false],
      ['COM1', 'SYSTEM', false],
    ]);
  });

  it('knows Linux USB serial names without USB IDs', () => {
    const ports = classifyPorts([{ path: '/dev/ttyS0' }, { path: '/dev/ttyUSB0' }, { path: '/dev/ttyACM0' }], 'linux');
    expect(ports.map((p) => [p.path, p.kind])).toEqual([
      ['/dev/ttyACM0', 'USB_SERIAL'],
      ['/dev/ttyUSB0', 'USB_SERIAL'],
      ['/dev/ttyS0', 'SYSTEM'],
    ]);
  });
});
