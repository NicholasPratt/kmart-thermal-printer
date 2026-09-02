# Thermal Print — Kmart JLR-79430

A no-install web app to print to the Kmart **JLR-79430** ("Anko Thermal Bluetooth Printer",
BLE name `YHK-…`) directly from a computer over Bluetooth — no phone, no WalkPrint.

Despite the "cat printer" branding, this unit is actually an **ESC/POS printer**
behind an **ISSC/Microchip "Transparent UART"** BLE bridge:

- Service `49535343-fe7d-4ae5-8fa9-9fafd205e455`
- Write (host→printer) `49535343-8841-43f4-a8d4-ecbe34729bb3`
- Notify (printer→host) `49535343-1e4d-4bd9-ba61-23c647249616`

We stream a raw ESC/POS job — `ESC @` init, `ESC 7` heating (darkness),
`GS v 0` raster bit image (384 dots wide, MSB = leftmost), `ESC J` feed — in
~180-byte writes with ~40 ms pauses so the UART bridge doesn't drop bytes.

## Run it

Web Bluetooth needs a secure context, so serve over `localhost`:

```sh
cd thermalp
python3 -m http.server 8000
```

Open **http://localhost:8000** in **Chrome or Edge** (Safari/Firefox don't support Web Bluetooth).

1. Turn the printer on.
2. **Inspect BLE** (optional, Phase 0) — dumps the printer's services/characteristics
   to the log so you can confirm it really is `AE30 / AE01 / AE02`. If they differ,
   tell me the UUIDs and I'll adjust `printer.js`.
3. **Connect printer** — pick the `YHK-…` device.
4. Type text or load an image, tune the preview, hit **Print**.

## Features
- **Text**, **Image** (Floyd–Steinberg dithered), **QR code**, and **Photobooth** (webcam) tabs.
- Live preview of the exact dots that will print.
- Darkness (heating) and tear-off feed controls.

## Files
- `printer.js` — Web Bluetooth driver + ESC/POS protocol (connect, print, inspect).
- `render.js` — text/image/QR → 384-wide canvas → dither/threshold → 48-byte lines.
- `qrcodegen.js` — vendored QR encoder (Project Nayuki, MIT), compiled from TS.
- `app.js` — UI glue.
- `index.html` — UI.

## Tuning knobs if a print looks wrong
- **All blank / very faint** → raise Darkness.
- **Smears / printer stalls** → increase `pace` (ms/line) in `printer.js:print`.
- **Mirrored horizontally** → flip bit order in `render.js:packLines` (`x` → `w-1-x`).
- **Nothing prints but connects** → run Inspect; the write characteristic may not be `AE01`.
  `chrome://bluetooth-internals` gives a full raw dump as a fallback.

## Credit / references
Protocol from [NaitLee/Cat-Printer](https://github.com/NaitLee/Cat-Printer),
[abhigkar/YHK-Cat-Thermal-Printer](https://github.com/abhigkar/YHK-Cat-Thermal-Printer),
and [WerWolv's writeup](https://werwolv.net/blog/cat_printer/).
