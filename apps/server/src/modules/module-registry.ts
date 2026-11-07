import { Injectable } from '@nestjs/common';
import type {
  DeviceInfo,
  ModuleRoute,
  PacketHandler,
} from '@crescent/module-sdk';
import type { ModuleManifest } from '@crescent/licensing';

export interface LoadedModule {
  id: string;
  manifest: ModuleManifest;
  installPath: string;
  routes: ModuleRoute[];
  handlers: PacketHandler[];
  unload?: () => void;
}

/** How the registry reaches the instrument register without depending on it. */
export interface DeviceDirectory {
  get(id: string): Promise<DeviceInfo | null>;
  byIdentifier(identifier: string): Promise<DeviceInfo | null>;
  list(instrumentType: string): Promise<DeviceInfo[]>;
}

/**
 * What is loaded right now: modules, their routes and packet handlers, and
 * which instrument types are therefore usable. Shared by the module manager,
 * the instrument register and the device gateway.
 */
@Injectable()
export class ModuleRegistry {
  private readonly modules = new Map<string, LoadedModule>();
  private directory: DeviceDirectory | null = null;

  add(m: LoadedModule) {
    this.modules.set(m.id, m);
  }

  remove(id: string) {
    const m = this.modules.get(id);
    try {
      m?.unload?.();
    } finally {
      this.modules.delete(id);
    }
  }

  get(id: string) {
    return this.modules.get(id);
  }

  all() {
    return [...this.modules.values()];
  }

  /** The loaded module that provides this instrument type, if any. */
  providerOf(instrumentType: string): LoadedModule | undefined {
    return this.all().find((m) =>
      m.manifest.instrumentTypes.some((t) => t.code === instrumentType),
    );
  }

  /** OTHER is built into the core; every other type needs its module loaded. */
  typeAvailable(instrumentType: string) {
    return instrumentType === 'OTHER' || !!this.providerOf(instrumentType);
  }

  handlerFor(instrumentType: string): PacketHandler | undefined {
    for (const m of this.modules.values()) {
      const h = m.handlers.find((x) => x.instrumentType === instrumentType);
      if (h) return h;
    }
    return undefined;
  }

  setDeviceDirectory(d: DeviceDirectory) {
    this.directory = d;
  }

  get devices(): DeviceDirectory {
    if (!this.directory) throw new Error('Instrument register not ready');
    return this.directory;
  }
}
