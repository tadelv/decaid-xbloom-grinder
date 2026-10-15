# Tests

The plugin's offline coverage is `scripts/check_plugin.mjs`:

```bash
node scripts/check_plugin.mjs
```

It needs nothing but Node — no Decaid checkout, no hardware, no `npm install`.

## Why the coverage is not the Dart overlay shape

`decaid-bookoo-mt80` (the plugin this repository's layout mirrors) documents its
tests as **non-standalone**: `test/helpers/<id>_plugin_fixture.dart` and
`test/plugins/<id>_plugin_test.dart` are copied onto a Decaid checkout's `test/`
tree, where they import Decaid's own helpers by relative path and load the plugin
from a hard-coded `examples/plugins/<plugin-id>/` directory.

This repository does not ship that shape. Two concrete reasons:

1. **The overlay is not portable in practice.** The reference tests import
   `plugin_test_helpers.dart`, which does not exist in Decaid's `test/helpers/`
   (Decaid main ships `plugin_ble_fixture.dart`, not `plugin_test_helpers.dart`),
   and `examples/plugins/bookoo-mt80.reaplugin/` does not exist in Decaid either.
   The overlay has to be repaired against whatever Decaid revision is at hand
   before it runs at all.
2. **It would be a second copy of the same coverage.** Anything asserted there
   would be asserted by the Node suite too, but only the Node suite can run
   without assembling a Decaid checkout first — so the copy that runs is the one
   that stays honest, and the copy that does not is the one that rots.

The coverage itself is **not** dropped. It lives in one place, runs standalone,
and is the same set of assertions the Dart overlay would have made.

## What the Node suite covers

- the frame builder: the bytes the driver writes for set grind, set rpm, start
  and stop, validated against the observed device behavior
  (`0x1f46`, `0x1fa9`/`0x1faa`, `0x9e4e`, `0x9e3a`, `0x0db1`, the `58 …` envelope
  and the Kermit CRC);
- the notification decoder and the phase mapping, including the `busy` → `idle`
  fallback on a host that does not accept `busy`;
- the published snapshot keys (`state`, `setting`, `rpm`);
- the whole `device-settings` surface, including stored defaults;
- the Streamline `skin` answer — its shape, the RPM line, the step-size pill and
  the header button;
- the `ui` overlay page through a stub DOM, so its message order and its
  `/api/v1/grinder/*` REST sequencing are exercised, not just its text;
- the `ui` framing headers with and without an `Origin`/`Referer`, including
  hosts that must be rejected;
- the in-memory live view, and the `changed` emit after a setter and after a
  notification-driven phase change.

## Adding to it

Append to `scripts/check_plugin.mjs`. It loads `plugin.js` from the repository
root into a fake BLE session (`session`), and the plugin's own `host` stub
records logs, emits, storage and publications, so a new assertion usually needs
no new scaffolding. Run it before pushing a tag: `scripts/package.sh` ships
whatever `plugin.js` is on disk.
