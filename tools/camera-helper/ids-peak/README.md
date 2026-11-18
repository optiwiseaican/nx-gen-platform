# IDS peak inside the NxGen installer

The lab camera (IDS U3-34L0XCP, USB3 Vision) needs the IDS USB3 Vision driver and the IDS peak runtime on
the PC. To spare users a second installation, the Windows installer can carry the IDS setup and run it
silently while NxGen is installed (only when IDS peak is not installed yet).

To enable it, on the build PC put here:

- the IDS peak setup for Windows, as downloaded from IDS (it is not committed: `*.exe` is ignored here);
- `install.json`:

```json
{
  "setup": "ids-peak-setup.exe",
  "arguments": "/quiet /norestart",
  "installedCheck": "C:\\Program Files\\IDS\\ids_peak"
}
```

| Key | Meaning |
|---|---|
| `setup` | file name of the IDS setup in this folder |
| `arguments` | the IDS setup's switches for a silent install of the driver and runtime only (check them with `<setup>.exe /?`) |
| `installedCheck` | a file or folder that exists once IDS peak is installed; the setup is skipped when it exists |

`npm run package:win` then copies the setup into the app and writes `apps/desktop/build/ids-peak.nsh`; the
installer runs it with those arguments. Exit codes 0 and 3010 (restart needed) count as success; anything
else shows a warning, NxGen is installed anyway and IDS peak can be installed separately.

Check IDS's licence terms for distributing their setup with NxGen.
