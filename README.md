# xBloom Studio Grinder for Decaid

A [Decaid](https://github.com/decentespresso/decaid) plugin that adds the xBloom
Studio grinder, which advertises itself as `XBLOOM` followed by the last six
digits of the machine's serial number. The plugin owns the device protocol;
Decaid owns discovery, the BLE connection lifecycle, and the device surface. It
also exposes [Streamline](https://github.com/decentespresso/streamline-js)
dashboard surfaces.

## Protocol provenance

The protocol implementation was derived by observing BLE communications between
an xBloom Studio grinder and software running on an Android device, using
Android's HCI snoop logging facility, and then validating the observed behavior
against the live device. No vendor protocol specification, SDK, source code,
firmware, or integration documentation was used or is included in this
repository.

## Driver type

The plugin declares the `grinder` driver type with three capabilities:
`startStop`, `grindSetting` and `rpmControl`. It publishes `state`, `setting`
and `rpm` as its snapshot, and Decaid exposes it through the singular
`/api/v1/grinder/*` REST surface and `/ws/v1/grinder/snapshot`.

Declared controls:

| Capability | Handler | Control |
| --- | --- | --- |
| `grindSetting` | `setGrindSetting(setting)` | numeric 1–80, step 1 |
| `rpmControl` | `setRpm(rpm)` | numeric 60–120, step 1 |
| `startStop` | `start()` / `stop()` | — |

## Install

From the Decaid REST API, which installs this repository's latest release:

```bash
curl -X POST http://localhost:8080/api/v1/plugins/install/github-release \
  -H 'content-type: application/json' \
  -d '{"repo": "tadelv/decaid-xbloom-grinder"}'
```

Or open the Plugins settings screen in Decaid and install from the repository.

The driver itself needs no particular Decaid release. See
[Dashboard surfaces](#dashboard-surfaces) for the one optional extra that does
need a newer skin.

## Matching

This targets the xBloom Studio grinder, firmware `V12.0D.500`. The GATT UUIDs
baked into `plugin.js` were read from that firmware, so verify them if a
different revision is targeted.

An advertisement whose name starts with `XBLOOM`. The GATT UUIDs are not used
for matching: they were read from the live device rather than from an
advertisement, so the matcher stays on the name. The xBloom coffee machine also
advertises `XBLOOM`, so tighten this to `serviceUuids` once the advertisement is
confirmed to carry the vendor service.

## Snapshot

The driver publishes `{state, setting, rpm}`:

| Field | Source | Mapping |
| --- | --- | --- |
| `state` | device notifications | `busy` while the burr moves to the target, `grinding` once grinding starts, `idle` when stopped or at rest |
| `setting` | last set or stored default | integer, requires `grindSetting` |
| `rpm` | last set or stored default | integer, requires `rpmControl` |

The move-to-target phase publishes `busy`. That state needs the host change in
the private development repo's `decaid-grinder-busy-state.patch` (it adds `busy`
to `GrinderState`, the OpenAPI enum, the docs and a test). Without it the host
rejects `busy`, and the plugin falls back to `idle` automatically — so the
driver works on stock Decaid either way.

## Controls

Each setter writes one command and waits for the device's acknowledgement. The
host validates the value against the declared control before invoking the
handler, so the driver only normalises and rounds.

Grind and rpm are also persisted per device (Decaid's plugin `host.storage`) as
the **defaults** applied on connect, through the `settings` device surface
below.

## Dashboard surfaces

A skin on the Streamline plugin-surfaces protocol can draw a fixed set of UI
pieces for a plugin that answers its `skin` endpoint, and runs only actions it
knows — no plugin code runs in the skin. The driver needs no particular Decaid
release; these surfaces are strictly additive and stay inert until the skin can
read them, which needs a Streamline build carrying its `docs/plugin-surfaces.md`
(its **main** branch today — the last release, v0.2.13, predates the spec).

The plugin answers `GET /api/v1/plugins/xbloom-grinder.reaplugin/skin` with three
surfaces:

| Surface | Kind | Where | Shows |
| --- | --- | --- | --- |
| `rpm` | `tile-line` | under the Grind label | the current RPM (`90 rpm`), drawn switched on while the grinder is not idle; a tap opens the skin's own numpad and sets it |
| `stepsize` | `tile-hint` | the Grind tile's pill | a `1 / 5` step for Decaid's own `-`/`+`, chosen by the user |
| `grinder` | `header-button` | the dashboard header | "Grinder" plus the current grind and RPM, or that it is offline; opens a control overlay |

**The RPM line is also the control**, in the slot it already occupies: no second
surface, and no `tile-mode` (a mode owns the tile's value and would take the
grind control with it). The tap carries a `call` action with a numpad `input`
limited to 60–120, and the typed number arrives as `POST
/api/v1/plugins/xbloom-grinder.reaplugin/rpm` with `{"rpm": <number>}`. The
endpoint re-validates the number — the skin's range is not a guard, since anyone
can POST there — and answers only after the value has landed, so the skin's
follow-up `skin` read shows the truth. With no grinder bound or connected it
answers `503` rather than hanging.

The pill carries a `text` because the spec requires one; the skin draws the pill
label itself from the size the user picked on that device. Both sizes are whole
numbers because `grindSetting` is an integer control (1–80, step 1): a
fractional size would draw the tile with a decimal and then be rejected by the
driver's own guard, which reads as a glitch.

**The `skin` answer never blocks and never needs the grinder.** It is built from
an in-memory view (connected, phase, grind, rpm), so it renders — reporting the
grinder offline — before any device binds, and the skin's 2 s budget is never at
risk.

The `ui` endpoint serves the overlay the header button opens. It reports its
size to the skin, drives Decaid's same-origin `/api/v1/grinder/*` REST surface,
stores grind and RPM before starting (because START is what moves the burr here),
and renders in both the `light` and `dark` themes the skin passes. Decaid stamps
`X-Frame-Options: SAMEORIGIN` on plugin pages, so the `ui` response answers with
`Content-Security-Policy: frame-ancestors 'self' <skin origin>` when the request
carries an `Origin` or `Referer` header; the host is validated, not reflected.

### Keeping the skin in sync

`live` in the same answer names the `changed` websocket. The skin holds it open
and re-reads `skin` on every message, so the plugin emits `{"what": "skin"}`
whenever its view of the grinder moves — on connect, on a failed connect, on
disconnect, on either setter, on saved defaults, and on every notification-driven
phase change. The body says the workflow did not change, which is always true
here: this plugin never writes one. Without `live`, the skin's minute poll still
applies.

`host.emit` is guarded with a `typeof` check, so the offline harness keeps
working without it.

## Device surface

Separate from the dashboard surfaces above: the manifest declares one driver
surface, `settings`, pointing at `device-settings`. Device management opens it as
a small form for the default grind and rpm, per device, persisted with
`host.storage` and applied on connect.

```
GET  /api/v1/plugins/xbloom-grinder.reaplugin/device-settings?deviceId=…[&ui=1]
POST /api/v1/plugins/xbloom-grinder.reaplugin/device-settings   {grind, rpm}
```

## Releasing

`scripts/package.sh` builds `dist/xbloom-grinder.reaplugin-<version>.zip`.
Pushing a `vX.Y.Z` tag runs the same script in CI and publishes the release.

Decaid enforces three things the script keeps in sync:

- the release tag is `X.Y.Z` or `vX.Y.Z` and equals `manifest.version` exactly
- the release carries exactly one `.zip` asset
- the archive holds a single top-level `xbloom-grinder.reaplugin/` directory
  containing `manifest.json` and `plugin.js`

So bump `manifest.version` and tag the same version. A release whose tag and
manifest disagree is rejected at install time.

## Tests

`node scripts/check_plugin.mjs` runs offline — no Decaid, no hardware, no
dependencies. It loads `plugin.js` against a fake BLE session and validates the
driver's BLE writes (against the observed device behavior), the busy→idle host
fallback, the published snapshot keys, the `skin` answer, the `ui` page's
messages and REST sequencing through a stub DOM, the framing headers with and
without an `Origin`, and the live view plus `changed` emit.

## Verified

The protocol was exercised against a physical unit from the private development
repo's Python reference client (macOS/CoreBluetooth, firmware
`V12.0D.500`): connect, subscribe, set grind and rpm, START, the move-to-target
tick, grind, and STOP, plus an autonomous hopper-empty stop. The JavaScript
driver implements the observed device behavior, which `scripts/check_plugin.mjs`
verifies.

The dashboard surfaces were exercised live against a running Decaid with a
simulated machine and Streamline from `main` as the skin: the skin read the
`skin` answer in the browser, the `changed` socket upgraded, and the three
surfaces rendered while the grinder was offline (`GET /api/v1/grinder/state`
answering `503`). They have not been exercised against grinder hardware, since
the surfaces are built from the same in-memory view the driver's own state
comes from.

## Licence

**GPL-3.0.** This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. It is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. The full text is in [LICENSE](LICENSE).
