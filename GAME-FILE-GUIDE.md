# Game‑File Guide — RAM Viewer

This guide explains how to add new games to the RAM Viewer.

## Directory Structure
```
ram-viewer/
├── games/           ← JSON files for each game
├── public/          ← web UI
├── server.js        ← Node.js server
└── GAME-FILE-GUIDE.md
```

## JSON Format
Each game JSON file must have:

```json
{
  "name": "Game Title",
  "console": "SNES|NES|Genesis|Game Boy|etc.",
  "core": "snes9x|Genesis Plus GX|mGBA|FBNeo|etc.",
  "romCRC": "optional CRC for identification",
  "addresses": [
    {
      "address": "0x0529",
      "label": "Banana Counter",
      "description": "In-level banana count (0–99)"
    },
    {
      "address": "0x0575",
      "label": "Lives",
      "description": "Player lives count"
    }
  ]
}
```

## Adding a New Game

### Step 1: Find RAM Addresses
1. Load the game in RetroArch with **Network Commands** enabled.
2. Open RetroArch’s **Memory Viewer** (`Settings → Debug → Memory Viewer`).
3. Look for visible counters (lives, score, HP) and note their WRAM addresses.
   - SNES WRAM is `0x0000–0x3FFF`.
   - Addresses displayed in memory viewer are **SNES bus addresses**, not WRAM offsets.
   - WRAM offsets are often `0x7E0000 + bus address`. For `0x0529` WRAM offset, bus address is `0x7E0529`.
   - However RetroArch `READ_CORE_RAM` expects WRAM offset (0x0529) not full bus address.

### Step 2: Verify with UDP Test
Using the RAM Viewer:
1. Set IP to your RetroArch host (default `192.168.68.73`).
2. Click **Test Connection** → should return `GET_STATUS` response.
3. Use **Console** to send manual commands:
   ```
   READ_CORE_RAM 0x0529 1
   WRITE_CORE_RAM 0x0529 99
   ```
4. Watch the game’s screen to see if the value changes.

### Step 3: Create JSON File
Create `games/<gamename>.json` with the verified addresses.

### Step 4: Test Polling
Select the game in dropdown, click **Start Polling**. Console will show each address value updating every 200ms.

## Example: Donkey Kong Country (SNES)
- WRAM offsets discovered:
  - `0x0529` → banana counter
  - `0x0575` → lives
- Verified by watching value increment when bananas collected, decrement when lives lost.

## Troubleshooting
- **Connection failed**: Ensure RetroArch `network_cmd_enable = "true"` in `retroarch.cfg`.
- `READ_CORE_RAM` returns `no memory map defined`: Use `READ_CORE_RAM` not `READ_CORE_MEMORY`.
- Address values don’t match screen: WRAM vs bus address confusion — test with `WRITE_CORE_RAM` injection.

## Contributing to FiberQuest
Once addresses are verified, add them to `fiberquest/games/` for tournament use. Payment triggers can be defined (e.g., banana pickup → 1 shannon payment).