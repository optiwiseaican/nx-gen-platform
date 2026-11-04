import { contextBridge } from 'electron';

// Minimal, explicit bridge to the renderer. Expand only with audited APIs.
contextBridge.exposeInMainWorld('crescent', {
  platform: process.platform,
});
