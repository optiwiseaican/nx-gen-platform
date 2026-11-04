import { app, BrowserWindow } from 'electron';
import * as path from 'path';

// In development the Electron shell loads the Next.js dev server.
// In packaged (standalone) builds it will load the bundled web app and
// start the local NestJS service + device service.
const WEB_URL = process.env.CRESCENT_WEB_URL ?? 'http://localhost:3000';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Crescent Pharma Compliance Platform',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadURL(WEB_URL);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
