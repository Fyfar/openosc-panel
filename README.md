# OpenOSC Panel

**Your ZOYI ZT703S on OpenOSC firmware, driven from the browser.** Oscilloscope, signal
generator, Bode plotter and multimeter on a big screen, over one USB cable. No drivers, no
install, no backend. Your data never leaves your machine.

[![Build](https://img.shields.io/github/actions/workflow/status/Fyfar/openosc-panel/ci.yml?branch=main&label=build)](https://github.com/Fyfar/openosc-panel/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/package-json/v/Fyfar/openosc-panel?label=version&color=3b82f6)](https://github.com/Fyfar/openosc-panel/blob/main/package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e)](./LICENSE)
![Firmware: OpenOSC 0.21+ only](https://img.shields.io/badge/firmware-OpenOSC%200.21%2B%20only-f59e0b)
![Stack: Vite · React · TypeScript · Tailwind](https://img.shields.io/badge/stack-Vite%20·%20React%2019%20·%20TypeScript%20·%20Tailwind%20v4-3b82f6)

![OpenOSC Panel: oscilloscope, generator, Bode and multimeter for the ZOYI ZT703S on OpenOSC firmware, shown as the multimeter, oscilloscope and generator views](./images/hero.jpg)

### **[Open the app →](https://fyfar.github.io/openosc-panel/)**

> [!IMPORTANT]
> This panel works **only with the [OpenOSC](https://github.com/bve/OpenOSC) firmware**. The
> stock ZOYI firmware has no remote control over USB. Still on stock firmware? See
> [below](#stock-firmware).

## Features

- **The scope on your monitor.** Both channels live, edge trigger, Run/Stop/Single, Auto
  setup, measurements, cursors and FFT. Export the full capture record as CSV.
- **Bode plots in one click.** The panel sweeps the generator, re-ranges each channel as the
  gain changes, reads off the −3 dB corner and roll-off, then puts your settings back.
- **A generator you can type into.** `10k`, `2.5 MHz`, `500 mHz`. Six shapes, duty cycle,
  levels or amplitude, and it keeps running while you work in another view.
- **Multimeter with a trend chart and CSV logging.**
- **One tab per instrument.** The device needs a different USB profile for scope and
  multimeter; the panel switches it for you in about a second.
- **Full control when you need it:** a SCPI console, device screenshots and a remote lock for
  the device's keys.

## What you need

- A **ZOYI ZT703S** with **OpenOSC 0.21 or newer** (tested on 0.21.4 to 0.21.7). The
  **ZT706S** should work too, but nobody has tried it on real hardware yet. Reports welcome.
- On the device: USB on in *Settings → Files & USB*, and performance profile 200/100 (faster
  profiles switch USB off).
- **Chrome, Edge, Opera or Firefox 151+ on desktop.** Safari and iOS have no Web Serial.

> [!CAUTION]
> **The USB port is not isolated.** Probe ground is tied to your computer's ground. Never
> measure mains while the cable is in.

## Stock firmware?

The stock firmware has no remote control, so the panel can't connect to it. Two options:

- **Keep it and use [Multimeter·Live](https://github.com/Fyfar/multimeter-live)**
  ([open the app](https://fyfar.github.io/multimeter-live/)). It reads the multimeter through
  the meter's serial output over a USB-UART adapter or Bluetooth. Multimeter only: no scope,
  generator or control.
- **Install OpenOSC.** The [OpenOSC README](https://github.com/bve/OpenOSC#installation) and
  [wiki](https://github.com/bve/OpenOSC/wiki/Installation) cover installing it and going back
  to stock. Flashing firmware is at your own risk.

## Good to know

- Scope and multimeter can't run at the same time: they are separate USB profiles on the
  device. The generator keeps running across the switch.
- Nothing is saved between visits. Export what you want to keep.
- One device, one tab: the serial port is exclusive.

> Independent project, not affiliated with ZOYI or ZOTEK, and separate from the OpenOSC
> firmware project. Product names are used only to identify the hardware.

## Run it locally

```sh
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) and click **Connect device**.
`npm run build` writes a static site to `dist/`; host it anywhere with HTTPS. Every push to
`main` publishes it to [GitHub Pages](https://fyfar.github.io/openosc-panel/).

## Contributing

Issues and pull requests are welcome, ZT706S reports most of all. Before sending code, run
`npm run build`, `npm run check` and `npx fallow`.

## License

[MIT](./LICENSE)
