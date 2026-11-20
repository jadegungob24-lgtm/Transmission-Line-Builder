# How to Run PH Grid Builder

A step-by-step guide to starting the Philippine Power Grid Simulator on your Windows PC.

---

## Before you start

You need:

| Requirement | Notes |
|---|---|
| **Windows 10 or 11** | |
| **Internet connection** | The map imagery and 3D terrain stream online while you play. |
| **Node.js** | Already on this PC as a portable copy. The launcher finds it automatically. |
| **A modern browser** | Chrome or Edge recommended. |

The project lives in this folder:

```
Desktop\PH Grid Builder
```

---

## Method 1 — Double-click launcher (recommended)

### Step 1. Open the project folder
Open **File Explorer** → **Desktop** → **PH Grid Builder**.

### Step 2. Start the launcher
Double-click **`Start PH Grid Builder.bat`**.

A black Command Prompt window opens.

- **First time only:** it says `Installing dependencies - first run only...` and downloads the libraries the app needs. This takes about 30 seconds.
- After that it prints `Starting PH Grid Builder at http://localhost:5173`.

### Step 3. Wait for the browser
Your browser opens to **http://localhost:5173** automatically.

> If the page shows "This site can't be reached", wait 2–3 seconds and press **F5**. The server can take a moment longer than the browser to start.

### Step 4. Choose how to begin
The welcome screen offers two buttons:

- **Load demo line (Batangas–Laguna, 230 kV)**: builds a sample line from a power plant to two substations and flies the camera to it.
- **Continue my network / Start with an empty map**: goes straight to the map.

### Step 5. Stop the simulator when you're done
Close the black Command Prompt window, or click into it, press **Ctrl + C**, then type **Y** and press **Enter**.

Your network is saved automatically in the browser, so it'll be there next time.

---

## Method 2 — Run it from PowerShell

Use this if you prefer typing commands. Run each line in order.

### Step 1. Open PowerShell in the project folder
In File Explorer, open **PH Grid Builder**, click the address bar, type `powershell` and press **Enter**.

Or open PowerShell anywhere and run:

```powershell
cd "$env:USERPROFILE\Desktop\PH Grid Builder"
```

### Step 2. Make Node.js available in this window

```powershell
$env:PATH = "$env:LOCALAPPDATA\Programs\node-v24.21.0-win-x64;$env:PATH"
```

> You need this line every time you open a **new** PowerShell window, unless you install Node.js from nodejs.org (see Troubleshooting).

### Step 3. Install dependencies (first time only)

```powershell
npm.cmd install
```

### Step 4. Start the server

```powershell
npm.cmd run dev
```

When you see `Local: http://localhost:5173/`, the app is running.

### Step 5. Open the app
Go to **http://localhost:5173** in your browser.

### Step 6. Stop the server
Press **Ctrl + C** in the PowerShell window.

> **Important:** in PowerShell, always type **`npm.cmd`**, not `npm`. Plain `npm` triggers the error *"running scripts is disabled on this system"*.

---

## Your first transmission line (2-minute tutorial)

1. **Fly somewhere.** Click the **search box** at the top (or press **/**). Pick a region such as *Laguna de Bay*, or type a town name and press **Enter**.
2. **Place a power source.** Open **Other Infrastructure** in the bottom toolbar → **Power Plant** → click on land.
3. **Pick a voltage.** Click **230 kV** on the right of the toolbar.
4. **Build towers.** Open **Transmission Towers** → **DC Suspension**. Click the power plant to start from it, then click across the land. Each click places a tower and strings conductors from the previous one. Keep towers within about 500 m of each other; the preview turns red and tells you if a span is too long.
5. **Finish at a substation.** Right-click to end the line. Open **Substations** → **Substation** and place it within about 500 m of your last tower. Then click your last tower; conductors are strung between them.
6. **Watch it energise.** Lines connected to the power plant glow with moving power-flow pulses. Double-click a tower to fly in for a closer look.

**Faster option:** open **Conductors** → **Auto Route · DC Lattice**, then click a start point and an end point. Towers are placed along the terrain automatically.

---

## Controls

The camera works like the **Laguna Floating TL Map**, plus a few Google Earth extras.

**Camera**

| Action | Control |
|---|---|
| Pan the map | **Left-drag**, **W A S D** or **arrow keys** |
| Zoom | **Mouse wheel** (toward the cursor), or **right-drag** up/down (down = closer) |
| Rotate and tilt | **Middle-drag**, **Ctrl + drag** or **Shift + drag** |
| Rotate and tilt with keys | **Shift + arrow keys**, or **Q / E** to orbit |
| Zoom with keys | **+ / −** or **Page Up / Page Down** (hold) |
| Fly in to a tower or span | **Double-click** it (Select tool). The camera then slowly orbits it until you click, drag or scroll. Turn the orbit off in **⚙ Settings** |
| Leave the fly-in view | **Esc**: flies back to where you were and clears the selection |
| Zoom in on a point | **Double-click** empty ground (Select tool) |
| **Reset view** (face north, look straight down at the spot you're exploring) | **R**, or the **⟲** button (bottom right) |
| Face north | **N**, or click the **compass** |
| Look straight down | **U**, or click **3D** to switch to **2D** |
| Rotate freely | **Drag the compass ring** |
| Search for a place or coordinates | **/** or **Ctrl + F** |
| Fit your whole network in view | **⌂ home** button (bottom right); the whole country if you haven't built anything yet |
| Top / isometric / ground view | **1 / 2 / 3** |

**Building**

| Action | Control |
|---|---|
| Place / select | **Left-click** |
| Cancel / end the current line | **Right-click** or **Esc** |
| Rotate the structure being placed | **T** (clockwise) / **Shift + T** |
| Select, move, bulldoze tools | **V / M / X** |
| String conductors between existing structures | **C** |
| Construction menus | **F1 – F5** |
| Change voltage | **[ / ]** |
| Delete the selected item | **Delete** |

The status bar at the bottom shows the cursor position, ground elevation, **eye altitude**, heading and tilt. A scale bar sits beside it.

**Search tips:** type a city, town, barangay or landmark and press **Enter**; results come from OpenStreetMap and are limited to the Philippines. You can also type coordinates such as `14.58, 121.03`.

> 3D towers appear once you zoom in past roughly city level. When zoomed out, the network shows as coloured lines on the map.

---

## Saving and sharing your network

- **Autosave:** your network saves in the browser every time you change it.
- **Export to a file:** **⚙ Settings** → **Export JSON** saves `ph-grid-network.json` to your Downloads.
- **Load a file:** **⚙ Settings** → **Import JSON**.
- **Start over:** **⚙ Settings** → **Clear map**.

> Autosave belongs to one browser. If you switch from Chrome to Edge, export from one and import into the other.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **`npm : The term 'npm' is not recognized`** | Node.js isn't on the PATH in that window. Run the PATH line from Method 2, Step 2, or use the launcher. |
| **`npm.ps1 cannot be loaded because running scripts is disabled`** | Type **`npm.cmd`** instead of `npm`. You don't need to change any Windows security setting. |
| **`npm error ... Could not read package.json`** | You're in the wrong folder. `cd` into `Desktop\PH Grid Builder` first. |
| **`Port 5173 is already in use`** | The simulator is already running in another window. Use that one, or close it and start again. |
| **"This site can't be reached"** | The server isn't running, or it's still starting. Check the black window is open, wait a few seconds, then press F5. |
| **The map is dark blue with no imagery** | Check your internet connection, then refresh the page. |
| **I can't see any towers** | Zoom in further. Below about zoom 10 the network is drawn as flat lines. |
| **"Node.js was not found"** (launcher) | Install the **LTS** version from **https://nodejs.org**, then run the launcher again. |
| **The app feels slow** | **⚙ Settings** → turn off *Dynamic shadows* and *Clouds*. |

### Optional: install Node.js permanently
Installing Node.js LTS from **https://nodejs.org** means you won't need the PATH line in Command Prompt.

In PowerShell you'll still need to type `npm.cmd` rather than `npm`.

---

## Quick reference

**Every time, easiest:** double-click `Start PH Grid Builder.bat`.

**Every time, PowerShell:**

```powershell
cd "$env:USERPROFILE\Desktop\PH Grid Builder"
$env:PATH = "$env:LOCALAPPDATA\Programs\node-v24.21.0-win-x64;$env:PATH"
npm.cmd run dev
```

Then open **http://localhost:5173**.
