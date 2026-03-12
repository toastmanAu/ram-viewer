# RAM Viewer — RetroArch UDP RAM Polling Tool

Live polling of SNES/NES/Genesis game RAM via RetroArch’s network commands.  
Map game variables (lives, score, HP) and wire them to **real‑money micropayments** (FiberQuest) or just explore memory.

![Screenshot](screenshot.png)

## Features

- **Browser GUI** — IP/port settings, game JSON dropdown, connection test
- **Local toggle** — connect to RetroArch on localhost or remote machine
- **Real‑time console** — logs with copy/save buttons
- **Per‑address cards** — each RAM address on its own line: `[BANANA] 0x0529 = 84`
- **Community game library** — contribute JSON files for new games
- **WebSocket server** — Node.js backend, UDP to RetroArch

## Quick Start

1. **Enable RetroArch network commands**  
   In `retroarch.cfg`:
   ```
   network_cmd_enable = "true"
   network_cmd_port = 55355
   ```

2. **Start the server**  
   ```bash
   git clone https://github.com/toastmanAu/ram-viewer.git
   cd ram-viewer
   npm install
   npm start
   ```
   Server runs on **port 8766**.

3. **Open browser**  
   `http://localhost:8766`

4. **Test connection**, select a game, click **Start Polling**.

## Adding New Games

### Step 1: Find RAM Addresses
- Load the game in RetroArch, open **Memory Viewer** (`Settings → Debug → Memory Viewer`).
- Look for visible counters (lives, score, HP) and note their **WRAM offsets**.
- Verify with UDP commands:
  ```
  READ_CORE_RAM 0x0529 1
  WRITE_CORE_RAM 0x0529 99
  ```
  Watch the game screen change.

### Step 2: Create JSON File
Add `games/your-game.json`:
```json
{
  "name": "Donkey Kong Country (SNES)",
  "console": "SNES",
  "core": "snes9x",
  "romCRC": "AAE679E5",
  "addresses": [
    {
      "address": "0x0529",
      "label": "Banana Counter",
      "description": "In‑level banana count (0–99)"
    },
    {
      "address": "0x0575",
      "label": "Lives",
      "description": "Player lives count"
    }
  ]
}
```

### Step 3: Submit a Pull Request
1. Fork the repo
2. Add your JSON file to `games/`
3. Update `games/INDEX.md` (optional)
4. Open a PR

## Community Game Library

We maintain a shared library of verified RAM maps.  
See `games/` for available titles. Want to contribute? Read [GAME‑FILE‑GUIDE.md](GAME-FILE-GUIDE.md).

## Use with FiberQuest

This tool is part of the **FiberQuest** stack — retro gaming with real‑money micropayments.

- **Sidecar daemon** polls RAM → triggers Fiber channel payments
- **Tournament mode** — competitive leaderboards with CKB payouts
- **ESP32‑P4 hub** — SNES controller → HTTP → sidecar

See [FiberQuest repo](https://github.com/toastmanAu/fiberquest) for integration.

## API

### WebSocket Events (client → server)
- `{"type":"test","host":"192.168.68.73","port":55355}`
- `{"type":"start","game":"dkc","host":"…","port":…}`
- `{"type":"stop"}`
- `{"type":"command","command":"READ_CORE_RAM 0x0529 1"}`

### Server → Client
- `{"event":"games","games":["dkc","…"]}`
- `{"event":"log","type":"info","message":"…"}`
- `{"event":"ram","address":"0x0529","label":"Banana Counter","value":84}`

## Development

```bash
npm run dev        # start with nodemon
npm test           # (todo)
```

### Project Structure
```
ram-viewer/
├── server.js          # Node.js + WebSocket + UDP
├── public/
│   ├── index.html    # GUI
│   ├── style.css
│   └── app.js        # WebSocket client
├── games/            # community JSON files
├── GAME-FILE-GUIDE.md
└── package.json
```

## License

MIT — free to use, modify, contribute.  
Built by [Wyltek Industries](https://wyltekindustries.com).