# Thermal Print — Kmart JLR-79430

A no-install, dependency-free web app that prints to the Kmart **JLR-79430**
("Anko Thermal Bluetooth Printer", BLE name `YHK-…`) straight from a browser
over Bluetooth — no phone, no WalkPrint app, no drivers.

**▶️ Use it now: https://nicholaspratt.github.io/kmart-thermal-printer/**

Print **text**, **dithered images**, **QR codes**, or take a **webcam photobooth**
shot — with a live preview of the exact dots that will print. There's also a
**zine maker**: fixed-size pages, page numbers, cut lines and placed photos.

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

### Making a zine

The **Zine** tab is a text editor that paginates. Write, pick a page size, and
the preview shows every page end to end exactly as it will print.

- **Page size** — the head is 203 dpi (8 dots/mm) and the paper is 48 mm wide, so
  a 48 × 48 mm page is 384 × 384 dots. Presets, a custom height in mm, or
  *Continuous* for one unbroken strip.
- **Page numbers** — centred at the foot of every page.
- **Cut line between pages** — a dashed line in a 2 mm gutter *between* pages, so
  each page stays exactly the height you asked for. Cut on the line.
- **Photos** — import (they're downscaled to 384 dots on the way in), then set a
  width and alignment per photo and hit **Insert** to drop an `[img:1]` token at
  the cursor. A line reading `[img:1]` on its own places that photo; a line of
  `---` forces a page break. Photos are dithered at their final size, so they stay
  photographic while the text around them stays crisp.
- **Saving** — named zines live in the browser's local storage, and the zine you
  have open is auto-saved as a draft and restored on reload. **Export file** writes
  a self-contained `.json` (photos included) you can keep or move to another machine.

Content that overflows a page flows onto the next one; a photo too tall for a
page is scaled down to fit.

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

### Status queries

This firmware answers **real-time status**, out of band — it replies even in the
middle of a raster block, so a job can be watched while it streams. Probed on a
`YHK-6172`, replies within ~250–500 ms:

| Query | Reply | Meaning |
|---|---|---|
| `DLE EOT 1` printer status | `0x16` | online (bit3 clear) |
| `DLE EOT 2` offline status | `0x12` | cover closed, no paper end, no error |
| `DLE EOT 3` error status | `0x12` | no error — bit6, the auto-recoverable/overheat bit, stays clear |
| `DLE EOT 4` paper sensor | `0x10` | paper present (bit1 should be fixed high; this clone leaves it clear) |
| `GS r 1` paper sensor | `0x00` | paper adequate |
| `GS r 2`, `ESC v`, `GS I n` | — | not implemented |

So the app can tell you it's **out of paper, cover open or offline** — see
`printer.js` `status()`. What it can **not** tell you is temperature: there's no
command that reads back degrees, and the one bit that would carry overheat stayed
clear even with the head hot after burning 2 cm of solid black at heat 220. Head
temperature is managed inside the firmware, invisibly; you observe it as printing
slowing or output fading on long dense jobs, never as a message.

Printing is guarded accordingly:

- **Pre-flight** — `print()` reads status first and refuses to stream into a
  printer that is out of paper, open or faulted.
- **Mid-job watch** — jobs over 400 lines are polled every 3 s with a single
  `DLE EOT 2`, so a paper-out is caught in seconds instead of after the whole
  zine has been pushed out.
- **Silence means unknown.** A printer that doesn't answer is probed once at
  connect and then printed to blind — an unanswered query never blocks a job.

## Files

| File | Role |
|---|---|
| `index.html` | UI |
| `app.js` | UI glue, live preview, webcam capture, zine photos + saving |
| `printer.js` | Web Bluetooth driver + ESC/POS protocol + status queries |
| `render.js` | text/zine/image/QR → 384px canvas → dither/threshold → 48-byte lines |
| `qrcodegen.js` | vendored QR encoder ([Project Nayuki](https://www.nayuki.io/page/qr-code-generator-library), MIT) |

## Troubleshooting

- **Blank or faint output** → raise **Darkness**.
- **Dense QR won't scan** → *lower* darkness (over-burn bleeds modules together) and/or
  raise error correction to **H**.
- **Muddy photos** → darkness ~50% with contrast up; faces dither better under-burned.
- **Last line stuck behind the tear bar** → raise **Feed after print**.
- **Zine won't save** → local storage is ~5 MB; drop a photo or **Export file** instead.
- **"Out of paper" but there is paper** → the roll-end sensor is optical; a very
  dark or reflective liner can read as empty. Print with `preflight: false` to skip
  the check.
- **Connects but nothing prints** → hit **Inspect BLE**, or use `chrome://bluetooth-internals`
  for a full raw GATT dump, and check the UUIDs against the table above.
- **Print stalls partway** → the bridge is being flooded; raise the `delay` in
  `printer.js` `_write()`.

## Credit

Protocol groundwork from [NaitLee/Cat-Printer](https://github.com/NaitLee/Cat-Printer),
[abhigkar/YHK-Cat-Thermal-Printer](https://github.com/abhigkar/YHK-Cat-Thermal-Printer),
and [WerWolv's writeup](https://werwolv.net/blog/cat_printer/).
QR encoding by [Project Nayuki](https://www.nayuki.io/page/qr-code-generator-library) (MIT).
