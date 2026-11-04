import { Inject, Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'fs';
import { dirname, join } from 'path';
import { canonicalize } from '@crescent/licensing';
import { NXGEN_CONFIG } from '../config/nxgen.config';
import type { NxGenConfig } from '../config/nxgen.config';

/**
 * Local protected storage.
 *
 * A 256-bit root key is generated on first use and stored in the data
 * directory with owner-only permissions. Separate encryption and integrity keys
 * are derived from it with HKDF.
 *
 * TODO(windows): wrap the root key with DPAPI (machine scope) instead of a
 * plain owner-only file; that is what makes it "protected from normal-user
 * modification" on a real lab workstation.
 *
 * Encryption is confidentiality / anti-casual-tampering only. It is never a
 * substitute for verifying license signatures (Technical Architecture §2).
 */
@Injectable()
export class SecureStorageService {
  private encryptionKey?: Buffer;
  private integrityKey?: Buffer;

  constructor(@Inject(NXGEN_CONFIG) private readonly config: NxGenConfig) {}

  private keys(): { enc: Buffer; mac: Buffer } {
    if (!this.encryptionKey || !this.integrityKey) {
      const rootPath = join(this.config.dataDir, 'keys', 'storage.key');
      let root: Buffer;
      if (existsSync(rootPath)) {
        root = readFileSync(rootPath);
        if (root.length !== 32)
          throw new Error('Protected storage key is damaged');
      } else {
        root = randomBytes(32);
        mkdirSync(dirname(rootPath), { recursive: true, mode: 0o700 });
        this.writeAtomic(rootPath, root, 0o600);
      }
      const derive = (info: string) =>
        Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), info, 32));
      this.encryptionKey = derive('nxgen/storage/encryption/v1');
      this.integrityKey = derive('nxgen/storage/integrity/v1');
    }
    return { enc: this.encryptionKey, mac: this.integrityKey };
  }

  /** Write via temp file + fsync + rename so a crash never leaves a half-written file. */
  writeAtomic(path: string, data: Buffer | string, mode = 0o600): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      const fd = openSync(tmp, 'w', mode);
      try {
        writeSync(
          fd,
          typeof data === 'string' ? Buffer.from(data, 'utf8') : data,
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  encrypt(plaintext: string, associatedData: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys().enc, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const data = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return JSON.stringify({
      v: 1,
      alg: 'AES-256-GCM',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    });
  }

  /** Throws if the ciphertext was modified or bound to different associated data. */
  decrypt(sealed: string, associatedData: string): string {
    const box = JSON.parse(sealed) as {
      v: number;
      alg: string;
      iv: string;
      tag: string;
      data: string;
    };
    if (box.v !== 1 || box.alg !== 'AES-256-GCM')
      throw new Error('Unsupported protected-storage format');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.keys().enc,
      Buffer.from(box.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(box.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  private mac(value: unknown): string {
    return createHmac('sha256', this.keys().mac)
      .update(canonicalize(value))
      .digest('hex');
  }

  /** JSON file with an HMAC so out-of-band edits are detected (not hidden). */
  writeSealedJson(path: string, value: Record<string, unknown>): void {
    this.writeAtomic(
      path,
      `${JSON.stringify({ value, mac: this.mac(value) }, null, 2)}\n`,
    );
  }

  /** Returns null if the file is missing; `intact: false` if it was modified. */
  readSealedJson<T>(path: string): { value: T; intact: boolean } | null {
    if (!existsSync(path)) return null;
    try {
      const { value, mac } = JSON.parse(readFileSync(path, 'utf8')) as {
        value: T;
        mac: string;
      };
      const expected = Buffer.from(this.mac(value), 'hex');
      const actual = Buffer.from(String(mac), 'hex');
      return {
        value,
        intact:
          actual.length === expected.length &&
          timingSafeEqual(actual, expected),
      };
    } catch {
      return { value: null as T, intact: false };
    }
  }
}
