# Thermal Print — Kmart JLR-79430

A no-install, dependency-free web app that prints to the Kmart **JLR-79430**
("Anko Thermal Bluetooth Printer", BLE name `YHK-…`) straight from a browser
over Bluetooth — no phone, no WalkPrint app, no drivers.

**▶️ Use it now: https://nicholaspratt.github.io/kmart-thermal-printer/**

Print **text**, **dithered images**, **QR codes**, or take a **webcam photobooth**
shot — with a live preview of the exact dots that will print.

## Browser support

Web Bluetooth is Chromium-only. The app itself is OS-agnostic; the browser is the limit.

| Platform | Works | Notes |
|---|---|---|
| macOS / Windows / Linux | ✅ | Chrome, Edge, Brave, Opera. Linux needs BlueZ ≥ 5.41 |
| Android | ✅ | Chrome (grant Location — Android gates BLE scanning behind it) |
| ChromeOS | ✅ | Best supported |
| **iOS / iPadOS** | ❌ | Apple's WebKit has no Web Bluetooth, so Chrome-on-iOS fails too. Workaround: the **Bluefy** browser |
| Safari / Firefox | ❌ | Neither implements Web Bluetooth, on any OS |

## Usage

1. Turn the printer on (and disconnect it from your phone — only one host at a time).
2. Open the site above, or run it locally (below).
3. **Connect printer** → pick the `YHK-…` device in Chrome's picker.
   You do **not** need to pair it in your OS Bluetooth settings — in fact, if the OS
   has already claimed it, "Forget" it there first.
4. Pick a tab, tune the preview, hit **Print**.

### Running locally

Web Bluetooth requires a secure context — `localhost` counts, so no HTTPS needed:

```sh
python3 -m http.server 8000     # or: npx serve
```

Then open <http://localhost:8000> in Chrome.

## How it works

Despite the "cat printer" branding, this unit is **not** a `0x51 0x78` cat-protocol
device. It's a plain **ESC/POS printer** behind an **ISSC/Microchip "Transparent UART"**
BLE bridge — a generic BLE-to-serial link:

| | UUID |
|---|---|
| Service | `49535343-fe7d-4ae5-8fa9-9fafd205e455` |
| Write (host→printer) | `49535343-8841-43f4-a8d4-ecbe34729bb3` |
| Notify (printer→host) | `49535343-1e4d-4bd9-ba61-23c647249616` |

The driver streams a raw ESC/POS job over that link:

- `ESC @` — initialize
- `ESC 7 n1 n2 n3` — heating config; `n2` (heating time) is the darkness control
- `GS v 0` — raster bit image, 384 dots wide, 48 bytes/line, **MSB = leftmost dot**,
  emitted in 128-row bands
- **feed** — this firmware ignores `ESC J` after a raster block, so paper is advanced
  by printing **blank raster rows** instead, which reliably moves the platen

Writes go out in **~180-byte chunks with ~40 ms pauses** (≈5 KB/s). The UART bridge
drains slower than BLE can push, and flooding it silently corrupts the stream.

## Files

| File | Role |
|---|---|
| `index.html` | UI |
| `app.js` | UI glue, live preview, webcam capture |
| `printer.js` | Web Bluetooth driver + ESC/POS protocol |
| `render.js` | text/image/QR → 384px canvas → dither/threshold → 48-byte lines |
| `qrcodegen.js` | vendored QR encoder ([Project Nayuki](https://www.nayuki.io/page/qr-code-generator-library), MIT) |

## Troubleshooting

- **Blank or faint output** → raise **Darkness**.
- **Dense QR won't scan** → *lower* darkness (over-burn bleeds modules together) and/or
  raise error correction to **H**.
- **Muddy photos** → darkness ~50% with contrast up; faces dither better under-burned.
- **Last line stuck behind the tear bar** → raise **Feed after print**.
- **Connects but nothing prints** → hit **Inspect BLE**, or use `chrome://bluetooth-internals`
  for a full raw GATT dump, and check the UUIDs against the table above.
- **Print stalls partway** → the bridge is being flooded; raise the `delay` in
  `printer.js` `_write()`.

## Credit

Protocol groundwork from [NaitLee/Cat-Printer](https://github.com/NaitLee/Cat-Printer),
[abhigkar/YHK-Cat-Thermal-Printer](https://github.com/abhigkar/YHK-Cat-Thermal-Printer),
and [WerWolv's writeup](https://werwolv.net/blog/cat_printer/).
QR encoding by [Project Nayuki](https://www.nayuki.io/page/qr-code-generator-library) (MIT).
