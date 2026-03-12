# Game Library — Community RAM Maps

This directory contains JSON files for games whose RAM addresses have been verified.

## How to Contribute

1. **Find RAM addresses** using RetroArch Memory Viewer and UDP commands.
2. **Create a JSON file** named `gamename.json` (lowercase, no spaces).
3. **Include**:
   - Game title, console, recommended core
   - ROM CRC (optional but helpful)
   - List of addresses with labels and descriptions
4. **Submit a Pull Request** adding the file here.

## Verified Games

| Game | Console | Core | Addresses |
|------|---------|------|-----------|
| [dkc.json](dkc.json) | SNES | snes9x | `0x0529` (bananas), `0x0575` (lives) |

## File Format

See [GAME‑FILE‑GUIDE.md](../GAME-FILE-GUIDE.md) for detailed specification.

## Tips

- **WRAM vs bus address**: RetroArch `READ_CORE_RAM` expects WRAM offset, not full bus address.
- **Test with WRITE**: Inject a value and watch the screen change.
- **Multi‑player offsets**: Player‑2 addresses are often `+0x100` or `+0x200` from player‑1.

## Credits

Maintained by the [FiberQuest](https://github.com/toastmanAu/fiberquest) community.