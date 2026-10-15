// xBloom Studio grinder BLE driver for Decaid.
//
// Protocol derived by observing BLE traffic between the grinder and an Android
// device; validated against the live device (see README.md). Frame envelope:
//   58 <dir> <type> <cmd:u16-LE> <len> 00 00 00 <flag> <body> <crc16-LE>
// CRC16 = Kermit (poly 0x1021, init 0x0000, reflected, no xorout).
//
// TODO(uuid): confirm these stay stable across firmware; captured from the
// live device via scripts/x_grind.py (macOS/CoreBluetooth, firmware V12.0D.500).
// Any accepted BLE alias (16/32/128-bit) works; the host normalizes to 128-bit.
const SERVICE_UUID = "0000e0ff-3c17-d293-8e48-14fe2e4da212"; // xBloom vendor service
const WRITE_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"; //   write-without-response
const NOTIFY_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"; //  notify

function createPlugin(host) {
  "use strict";

  const GRIND_MIN = 1;
  const GRIND_MAX = 80;
  const RPM_MIN = 60;
  const RPM_MAX = 120;
  const DEFAULT_GRIND = 50;
  const DEFAULT_RPM = 60;

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  // Heartbeats: never logged or acted on.
  const CMD_HEARTBEAT = [0x9e4b, 0x9e4a, 0x5015];
  // Burr motion: 0x9e39 ticks the position while moving to the requested grind
  // size (persists across runs); 0x0dac is the START ack carrying the position.
  const CMD_MOVING = [0x9e39, 0x0dac];
  // Grinding has actually begun: 0x9e4e = target reached, 0x9e3a = grind start.
  const CMD_GRIND_START = [0x9e4e, 0x9e3a];
  const CMD_STATUS = 0x1f57;
  const STATUS_GRINDING = 0x22;
  const STATUS_IDLE = 2;
  // 0x9e3b = stopped (commanded or autonomous); 0x9e45 = hopper empty (no
  // beans) — the device stops itself and flashes a "beans" message; 0x0db1 =
  // reply to a commanded STOP.
  const CMD_STOPPED = [0x9e3b, 0x0db1];
  const CMD_NO_BEANS = 0x9e45;
  const CMD_SET_ACK = [0x1f46]; // set grind/rpm acknowledgement
  const CMD_MANUAL_GRIND = 0x1fa9;
  const CMD_MANUAL_RPM = 0x1faa;

  function log(msg) {
    host.log("[xbloom] " + msg);
  }

  // Per-device defaults (grind + rpm), keyed by the runtime device id. The host
  // namespaces storage to this plugin. host.storage answers through onEvent:
  // reads resolve by key, writes resolve in FIFO order.
  const pendingReads = new Map();
  const pendingWrites = [];
  const activeInstances = new Map();

  // The driver the host most recently created. The Streamline `rpm` line's
  // numpad posts without a device id, and this host binds one grinder at a
  // time; a bound-but-offline driver answers with its own "not connected".
  let boundDriver = null;

  function storageRead(key) {
    if (typeof host.storage !== "function") return Promise.resolve(null);
    return new Promise(function (resolve) {
      // A response dropped by a generation change must not stall connect, so
      // the read resolves as null after a short bound.
      const entry = {
        resolve: resolve,
        timer: setTimeout(function () {
          if (pendingReads.get(key) === entry) {
            pendingReads.delete(key);
            resolve(null);
          }
        }, 2000)
      };
      pendingReads.set(key, entry);
      host.storage({ type: "read", key: key });
    });
  }

  function storageWrite(key, value) {
    if (typeof host.storage !== "function") return Promise.resolve();
    return new Promise(function (resolve) {
      pendingWrites.push(resolve);
      host.storage({ type: "write", key: key, data: value });
    });
  }

  // Stored as a JSON string so every KV backend round-trips the same value.
  function parseDefaults(raw) {
    if (typeof raw !== "string") return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return null;
    }
    const grind = Number(parsed && parsed.grind);
    const rpm = Number(parsed && parsed.rpm);
    if (!Number.isInteger(grind) || grind < GRIND_MIN || grind > GRIND_MAX) return null;
    if (!Number.isInteger(rpm) || rpm < RPM_MIN || rpm > RPM_MAX) return null;
    return { grind: grind, rpm: rpm };
  }

  function jsonResponse(status, payload) {
    return {
      status: status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    };
  }

  // The single in-memory view of the bound grinder the `skin` answer reads:
  // connected, phase, grind, rpm. The driver callbacks below keep it current,
  // and it never needs the grinder to be connected, so `skin` cannot block.
  const live = {
    connected: false,
    phase: "idle",
    grind: DEFAULT_GRIND,
    rpm: DEFAULT_RPM
  };

  function emitChanged() {
    // Offline harnesses have no host.emit; the surfaces then just poll.
    if (typeof host.emit !== "function") return;
    host.emit("changed", { what: "skin" });
  }

  function updateLive(next) {
    let changed = false;
    for (const key of Object.keys(next)) {
      if (live[key] !== next[key]) {
        live[key] = next[key];
        changed = true;
      }
    }
    if (changed) emitChanged();
  }

  // Streamline reads the `skin` answer on dashboard load, on a timer, and
  // whenever the `changed` socket speaks. It is built from `live` alone.
  function skinAnswer() {
    const moving = live.connected && live.phase !== "idle";
    return {
      version: 1,
      surfaces: [
        {
          id: "rpm",
          kind: "tile-line",
          tile: "grind",
          text: live.rpm + " rpm",
          active: moving,
          // The same line is the control: a tap opens the skin's own numpad and
          // the typed number is POSTed to the `rpm` endpoint as {rpm: <n>}.
          action: {
            type: "call",
            endpoint: "rpm",
            field: "rpm",
            input: {
              title: "RPM",
              unit: "",
              min: RPM_MIN,
              max: RPM_MAX,
              decimals: 0,
              value: live.rpm
            }
          }
        },
        {
          id: "stepsize",
          kind: "tile-hint",
          tile: "grind",
          // The skin draws the pill text itself (from the size stored on the
          // device); the spec still requires some text. Whole numbers only:
          // grindSetting is an integer control (1..80, step 1) and a fractional
          // size would both render the tile with a decimal and be rejected by
          // the driver's own integer guard, which reads as a glitch.
          text: "Step",
          action: { type: "stepsize", field: "grinderSetting", sizes: [1, 5] }
        },
        {
          id: "grinder",
          kind: "header-button",
          label: "Grinder",
          text: live.connected
            ? "Grind " + live.grind + " \u00b7 " + live.rpm + " rpm"
            : "Grinder offline",
          action: { type: "open", view: "grinder", presentation: "overlay", fit: true }
        }
      ],
      live: { endpoint: "changed" }
    };
  }

  // The host does not case-normalise header keys, so look them up that way.
  function headerValue(headers, name) {
    if (!headers) return null;
    const wanted = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === wanted) {
        const value = headers[key];
        return typeof value === "string" && value.length > 0 ? value : null;
      }
    }
    return null;
  }

  // "https://host:port/path" (or a bare origin) → "https://host:port".
  // The host is interpolated into a CSP header, so it is validated rather than
  // reflected: letters, digits, dots and hyphens, plus an optional :port.
  function originOf(value) {
    const match = /^(https?:)\/\/([A-Za-z0-9.-]+)(:\d+)?(?=[\/?#]|$)/i.exec(String(value || ""));
    if (!match) return null;
    return match[1].toLowerCase() + "//" + match[2] + (match[3] || "");
  }

  // Native device management opens this page in an in-app browser with
  // ui=1, deviceId and an optional display-only deviceName.
  function renderSettingsPage(deviceName, grind, rpm) {
    const name = String(deviceName || "xBloom grinder")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
      "<title>xBloom grinder defaults</title><style>" +
      "body{font-family:-apple-system,system-ui,sans-serif;margin:2rem;max-width:26rem}" +
      "label{display:block;margin:1rem 0 .25rem;font-weight:600}" +
      "input{width:100%;padding:.5rem;font-size:1rem;box-sizing:border-box}" +
      "button{margin-top:1.5rem;padding:.6rem 1.2rem;font-size:1rem}" +
      "#status{margin-top:1rem;min-height:1.2em}.hint{color:#666;font-size:.85rem}" +
      "</style></head><body><h1>xBloom grinder defaults</h1>" +
      "<p class=\"hint\">" + name + " &middot; applied when the grinder connects. " +
      "Grind " + GRIND_MIN + "\u2013" + GRIND_MAX + ", RPM " + RPM_MIN + "\u2013" + RPM_MAX + ".</p>" +
      "<label for=\"grind\">Default grind</label>" +
      "<input id=\"grind\" type=\"number\" min=\"" + GRIND_MIN + "\" max=\"" + GRIND_MAX + "\" step=\"1\" value=\"" + grind + "\">" +
      "<label for=\"rpm\">Default RPM</label>" +
      "<input id=\"rpm\" type=\"number\" min=\"" + RPM_MIN + "\" max=\"" + RPM_MAX + "\" step=\"1\" value=\"" + rpm + "\">" +
      "<button id=\"save\">Save</button><div id=\"status\"></div><script>" +
      "document.getElementById('save').addEventListener('click',function(){" +
      "var status=document.getElementById('status');" +
      "var grind=Number(document.getElementById('grind').value);" +
      "var rpm=Number(document.getElementById('rpm').value);" +
      "fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'}," +
      "body:JSON.stringify({grind:grind,rpm:rpm})}).then(function(r){" +
      "return r.json().then(function(body){return {ok:r.ok,body:body};});" +
      "}).then(function(result){" +
      "status.textContent=result.ok?'Saved.':(result.body.error||'Could not save');" +
      "status.style.color=result.ok?'#0a7a26':'#b00020';" +
      "}).catch(function(){" +
      "status.textContent='Could not save';status.style.color='#b00020';});" +
      "});<\/script></body></html>";
  }

  async function handleDeviceSettings(request) {
    const query = request.query || {};
    const deviceId = query.deviceId;
    if (typeof deviceId !== "string" || deviceId.length === 0) {
      return jsonResponse(400, { error: "deviceId is required" });
    }
    const stored = parseDefaults(await storageRead(deviceId)) ||
      { grind: DEFAULT_GRIND, rpm: DEFAULT_RPM };

    if (request.method === "POST") {
      const body = request.body || {};
      const grind = Number(body.grind);
      const rpm = Number(body.rpm);
      if (!Number.isInteger(grind) || grind < GRIND_MIN || grind > GRIND_MAX ||
          !Number.isInteger(rpm) || rpm < RPM_MIN || rpm > RPM_MAX) {
        return jsonResponse(400, {
          error: "grind must be " + GRIND_MIN + ".." + GRIND_MAX +
            " and rpm " + RPM_MIN + ".." + RPM_MAX
        });
      }
      await storageWrite(deviceId, JSON.stringify({ grind: grind, rpm: rpm }));
      const instance = activeInstances.get(deviceId);
      if (instance) await instance.applyDefaults(grind, rpm);
      return jsonResponse(200, { deviceId: deviceId, grind: grind, rpm: rpm });
    }

    if (query.ui === "1") {
      return {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: renderSettingsPage(query.deviceName, stored.grind, stored.rpm)
      };
    }
    return jsonResponse(200, {
      deviceId: deviceId,
      grind: stored.grind,
      rpm: stored.rpm
    });
  }

  // The `ui` page the header button opens: an overlay over the dashboard
  // (`embed=1&theme=…`), or a page with `returnTo`. It drives Decaid's
  // same-origin /api/v1/grinder REST surface directly. `fit: true` makes the
  // dialog transparent, so the page draws its own card on a transparent
  // html/body and reports its size to the skin.
  function renderControlPage(theme) {
    return "<!DOCTYPE html><html lang=\"en\" data-theme=\"" +
      (theme === "dark" ? "dark" : "light") + "\"><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
      "<title>xBloom grinder</title><style>" +
      ":root{--card:#fff;--text:#1c1c1e;--muted:#6b7280;--field:#f2f2f7;--line:#d1d1d6;--accent:#0a7a26}" +
      "html[data-theme=dark]{--card:#1c1c1e;--text:#f2f2f7;--muted:#9ca3af;--field:#2c2c2e;--line:#3a3a3c;--accent:#4ade80}" +
      "html,body{background:transparent;margin:0}" +
      "body{font-family:-apple-system,system-ui,sans-serif;color:var(--text)}" +
      "#card{width:100%;box-sizing:border-box;background:var(--card);border-radius:14px;" +
      "box-shadow:0 10px 30px rgba(0,0,0,.28);padding:1rem 1.1rem 1.1rem}" +
      "h1{font-size:1.05rem;margin:0 0 .35rem}" +
      "#state{color:var(--muted);font-size:.9rem;margin:0 0 .8rem;min-height:1.2em}" +
      "label{display:block;font-size:.8rem;font-weight:600;margin:.6rem 0 .2rem}" +
      "input{width:100%;box-sizing:border-box;padding:.5rem;font-size:1rem;color:var(--text);" +
      "background:var(--field);border:1px solid var(--line);border-radius:8px}" +
      ".row{display:flex;gap:.6rem;align-items:center;margin-top:1rem}" +
      "button{flex:1;padding:.6rem 1rem;font-size:1rem;border:0;border-radius:8px;" +
      "background:var(--accent);color:#fff}" +
      "button.ghost{flex:0 0 auto;background:transparent;color:var(--muted);border:1px solid var(--line)}" +
      "#note{color:var(--muted);font-size:.85rem}" +
      "</style></head><body><div id=\"card\"><h1>xBloom grinder</h1>" +
      "<p id=\"state\">Loading\u2026</p>" +
      "<label for=\"grind\">Grind (" + GRIND_MIN + "\u2013" + GRIND_MAX + ")</label>" +
      "<input id=\"grind\" type=\"number\" min=\"" + GRIND_MIN + "\" max=\"" + GRIND_MAX + "\" step=\"1\">" +
      "<label for=\"rpm\">RPM (" + RPM_MIN + "\u2013" + RPM_MAX + ")</label>" +
      "<input id=\"rpm\" type=\"number\" min=\"" + RPM_MIN + "\" max=\"" + RPM_MAX + "\" step=\"1\">" +
      "<div class=\"row\"><button id=\"start\">Start</button><button id=\"stop\">Stop</button></div>" +
      "<div class=\"row\"><button id=\"close\" class=\"ghost\">Close</button><span id=\"note\"></span></div>" +
      "</div><script>" +
      "(function(){" +
      "var view=null;" +
      "var params=new URLSearchParams(location.search);" +
      "var embedded=params.get('embed')==='1';" +
      "function $(id){return document.getElementById(id);}" +
      "function post(message){try{window.parent.postMessage(message,'*');}catch(error){}}" +
      "function note(text){$('note').textContent=text||'';}" +
      "function paint(){" +
      "if(!view){$('state').textContent='Grinder offline';return;}" +
      "$('state').textContent=view.state+' \u00b7 grind '+view.setting+' \u00b7 '+view.rpm+' rpm';}" +
      "function put(url,body){var init={method:'PUT'};" +
      "if(body!==undefined){init.headers={'Content-Type':'application/json'};" +
      "init.body=JSON.stringify(body);}" +
      "return fetch(url,init).then(function(response){" +
      "if(!response.ok)throw new Error('HTTP '+response.status);return response;});}" +
      // START is what moves the burr on this device, so grind and rpm are
      // stored first and only then is grinding requested.
      "function apply(){" +
      "var grind=Number($('grind').value);var rpm=Number($('rpm').value);" +
      "return put('/api/v1/grinder/setting',{setting:String(grind)}).then(function(){" +
      "return put('/api/v1/grinder/rpm',{rpm:rpm});});}" +
      "function load(){return fetch('/api/v1/grinder/state').then(function(response){" +
      "return response.ok?response.json():null;}).then(function(body){" +
      "if(!body){view=null;paint();return;}" +
      "view=body;$('grind').value=body.setting;$('rpm').value=body.rpm;paint();note('');" +
      "}).catch(function(){view=null;paint();});}" +
      "$('start').addEventListener('click',function(){note('Starting\u2026');" +
      "apply().then(function(){return put('/api/v1/grinder/state/grinding');})" +
      ".then(load).catch(function(){note('Could not start');});});" +
      "$('stop').addEventListener('click',function(){note('Stopping\u2026');" +
      "put('/api/v1/grinder/state/idle').then(load)" +
      ".catch(function(){note('Could not stop');});});" +
      "$('close').addEventListener('click',function(){" +
      "if(embedded){post({type:'streamline:close'});return;}" +
      "var raw=params.get('returnTo');var target=null;" +
      "if(raw){try{var url=new URL(raw,location.href);" +
      "if(url.protocol==='http:'||url.protocol==='https:')target=url.href;}catch(error){}}" +
      "location.assign(target||'/');});" +
      "function postSize(){var rect=$('card').getBoundingClientRect();" +
      "post({type:'streamline:size',width:Math.round(rect.width),height:Math.round(rect.height)});}" +
      "window.addEventListener('resize',postSize);" +
      // `ready` and the first `size` are posted synchronously as the page
      // script runs; later size changes come from the resize event (a hidden
      // frame may not run rAF).
      "post({type:'streamline:ready'});postSize();load();" +
      "})();" +
      "<\/script></body></html>";
  }

  // The Streamline `skin` line's numpad calls this with {rpm: <number>}. The
  // skin keeps the user inside min..max, but anyone can POST here, so the value
  // is re-validated exactly as the driver's setRpm does before it reaches the
  // device. The answer goes out only once the write and the publish have
  // landed — the spec requires a `call` to answer after the change, because the
  // skin re-reads `skin` when this resolves. Offline it fails fast instead of
  // hanging.
  async function handleRpm(request) {
    if (request.method !== "POST") {
      return jsonResponse(405, { error: "POST required" });
    }
    const value = Number((request.body || {}).rpm);
    if (!Number.isInteger(value) || value < RPM_MIN || value > RPM_MAX) {
      return jsonResponse(400, {
        error: "rpm must be an integer " + RPM_MIN + ".." + RPM_MAX
      });
    }
    if (!boundDriver) {
      return jsonResponse(503, { error: "No xBloom grinder is connected" });
    }
    try {
      await boundDriver.setRpm(value);
    } catch (error) {
      return jsonResponse(503, {
        error: (error && error.message) || "Could not set the rpm"
      });
    }
    // setRpm moved the live view, so `changed` has already been emitted.
    return jsonResponse(200, { rpm: value });
  }

  // Decaid adds X-Frame-Options: SAMEORIGIN to every plugin page, so a skin on
  // another origin is refused in the overlay. Answering with frame-ancestors
  // for the skin's origin (from Origin, else Referer) makes browsers ignore it.
  function handleUi(request) {
    const headers = { "Content-Type": "text/html; charset=utf-8" };
    const origin = originOf(headerValue(request.headers, "origin")) ||
      originOf(headerValue(request.headers, "referer"));
    if (origin) {
      headers["Content-Security-Policy"] = "frame-ancestors 'self' " + origin;
    }
    return {
      status: 200,
      headers: headers,
      body: renderControlPage((request.query || {}).theme)
    };
  }

  function decodeBase64(data) {
    if (typeof data !== "string" || data.length % 4 !== 0) return null;
    const out = [];
    for (let i = 0; i < data.length; i += 4) {
      const a = B64.indexOf(data[i]);
      const b = B64.indexOf(data[i + 1]);
      const c = data[i + 2] === "=" ? 0 : B64.indexOf(data[i + 2]);
      const d = data[i + 3] === "=" ? 0 : B64.indexOf(data[i + 3]);
      if (a < 0 || b < 0 || c < 0 || d < 0) return null;
      out.push((a << 2) | (b >> 4));
      if (data[i + 2] !== "=") out.push(((b & 15) << 4) | (c >> 2));
      if (data[i + 3] !== "=") out.push(((c & 3) << 6) | d);
    }
    return out;
  }

  function crc16Kermit(bytes) {
    let crc = 0x0000;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit++) {
        crc = crc & 1 ? (crc >> 1) ^ 0x8408 : crc >> 1;
      }
    }
    return crc & 0xffff;
  }

  function u32le(value) {
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
  }

  function buildFrame(cmd, body) {
    // Length byte equals the total frame length (matches x_grind.py).
    const length = 5 + 1 + 3 + 1 + body.length + 2;
    const framed = [0x58, 0x01, 0x01, cmd & 0xff, (cmd >> 8) & 0xff,
      length, 0x00, 0x00, 0x00, 0x01].concat(body);
    const crc = crc16Kermit(framed);
    return framed.concat([crc & 0xff, (crc >> 8) & 0xff]);
  }

  function frameSet(grind, rpm) {
    return buildFrame(0x1f46, u32le(grind).concat(u32le(rpm)));
  }
  function frameStart(grind, rpm) {
    return buildFrame(0x0dac, u32le(0x03e8).concat(u32le(grind), u32le(rpm)));
  }
  function frameStop() {
    return buildFrame(0x0db1, []);
  }

  function toHex(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    }
    return out;
  }

  function normalizeUuid(uuid) {
    const u = uuid.toLowerCase();
    if (u.length === 4) return "0000" + u + "-0000-1000-8000-00805f9b34fb";
    if (u.length === 8) return u + "-0000-1000-8000-00805f9b34fb";
    return u;
  }

  function readU32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  function parseGrind(setting) {
    const grind = Number(setting);
    if (!Number.isInteger(grind) || grind < GRIND_MIN || grind > GRIND_MAX) {
      throw new Error("grind setting must be an integer " + GRIND_MIN + ".." + GRIND_MAX);
    }
    return grind;
  }

  // Mirrors the declared rpmControl descriptor (min/max); the host validates
  // commands the same way, this guard covers direct handler calls.
  function parseRpm(rpm) {
    const value = Number(rpm);
    if (!Number.isInteger(value) || value < RPM_MIN || value > RPM_MAX) {
      throw new Error("rpm must be an integer " + RPM_MIN + ".." + RPM_MAX);
    }
    return value;
  }

  return {
    id: "xbloom-grinder.reaplugin",

    onLoad() {
      return host.devices.bindDriver("xbloom", {
        create(device) {
          const deviceId =
            device && typeof device.id === "string" ? device.id : null;
          // Survives reconnects for the life of this binding. Last values the
          // host set are re-sent as one combined 0x1f46 frame per setter.
          let lastGrind = DEFAULT_GRIND;
          let lastRpm = DEFAULT_RPM;
          let active = null;

          // Per-device defaults persisted by the device-settings surface, loaded
          // once per connect so grind/rpm resume across app restarts.
          async function loadDefaults() {
            if (!deviceId) return;
            const stored = parseDefaults(await storageRead(deviceId));
            if (stored) {
              lastGrind = stored.grind;
              lastRpm = stored.rpm;
            }
          }

          // Lets the settings endpoint reach the live instance, so a saved
          // default is reflected without waiting for a reconnect.
          if (deviceId) {
            activeInstances.set(deviceId, {
              applyDefaults(grind, rpm) {
                lastGrind = grind;
                lastRpm = rpm;
                updateLive({ grind: grind, rpm: rpm });
                if (active && !active.stopped) {
                  return active.session
                    .publish(snapshot(active, active.phase))
                    .catch(function () {});
                }
                return Promise.resolve();
              }
            });
          }

          function requireActive() {
            if (!active || active.stopped) {
              throw new Error("xBloom grinder is not connected");
            }
            return active;
          }

          function snapshot(state, phase) {
            return {
              state: phase,
              setting: String(lastGrind),
              rpm: lastRpm
            };
          }

          function write(state, bytes) {
            return state.session.gatt.writeWithoutResponse(
              SERVICE_UUID, WRITE_UUID, btoa(String.fromCharCode.apply(null, bytes)));
          }

          // `busy` (burr moving to target) is a newer Decaid state. Older hosts
          // reject it, so fall back to `idle` once and remember.
          let busySupported = null;

          function setPhase(state, phase) {
            if (state.phase === phase) return;
            state.phase = phase;
            updateLive({ phase: phase });
            const attempt = phase === "busy" && busySupported === false ? "idle" : phase;
            // Notification-driven publish; a stale session here must not kill
            // the subscription, so swallow it.
            state.session.publish(snapshot(state, attempt)).catch((error) => {
              if (attempt === "busy" && error && error.code === "invalid_argument") {
                busySupported = false;
                state.session.publish(snapshot(state, "idle")).catch(() => {});
              }
            });
          }

          function onNotify(state, data) {
            if (state.stopped) return;
            const bytes = decodeBase64(data);
            if (!bytes || bytes.length < 11 || bytes[0] !== 0x58) return;
            const cmd = bytes[3] | (bytes[4] << 8);
            const payload = bytes.slice(10, bytes.length - 2);

            // START first moves the burr to the requested grind size/rpm; real
            // grinding only begins at the reach/grind-start frames, which can
            // take seconds. The move maps to `busy`.
            if (CMD_MOVING.indexOf(cmd) >= 0) {
              setPhase(state, "busy");
              return;
            }
            if (CMD_GRIND_START.indexOf(cmd) >= 0) {
              setPhase(state, "grinding");
              return;
            }
            if (cmd === CMD_STATUS && payload.length >= 4) {
              const status = readU32(payload, 0);
              if (status === STATUS_GRINDING) setPhase(state, "grinding");
              else if (status === STATUS_IDLE) setPhase(state, "idle");
              return;
            }
            if (cmd === CMD_NO_BEANS) {
              log("no beans detected — grinder stopped itself");
              setPhase(state, "idle");
              return;
            }
            if (CMD_STOPPED.indexOf(cmd) >= 0) {
              setPhase(state, "idle");
              return;
            }
            if (CMD_SET_ACK.indexOf(cmd) >= 0) return;
            if (CMD_HEARTBEAT.indexOf(cmd) >= 0) return;

            if (payload.length >= 4) {
              const value = readU32(payload, 0);
              // Physical dial events; value semantics unconfirmed, so log only.
              if (cmd === CMD_MANUAL_GRIND) {
                log("manual grind size event: " + value);
                return;
              }
              if (cmd === CMD_MANUAL_RPM) {
                log("manual rpm event: " + value);
                return;
              }
            }
            log("<- cmd=0x" + cmd.toString(16) + " payload=" + toHex(payload));
          }

          const driver = {
            async connect(session) {
              // An attempt starts from offline: if discovery, subscribe or the
              // first snapshot fails, the live view already reads offline.
              updateLive({ connected: false });
              if (!SERVICE_UUID || !WRITE_UUID || !NOTIFY_UUID) {
                throw new Error("xBloom GATT UUIDs are not configured (see plugin.js)");
              }
              const state = { session: session, stopped: false, phase: "idle" };
              active = state;

              await loadDefaults();

              const services = await session.gatt.discoverServices();
              if (services.indexOf(normalizeUuid(SERVICE_UUID)) < 0) {
                throw new Error("xBloom vendor service unavailable");
              }
              session.gatt.onDisconnect(() => {
                state.stopped = true;
                updateLive({ connected: false });
              });
              await session.gatt.subscribe(SERVICE_UUID, NOTIFY_UUID, (data) => {
                onNotify(state, data);
              });

              // Readiness for a grinder is connect() resolving plus a valid
              // initial snapshot; the device sends nothing unsolicited on connect.
              await session.publish(snapshot(state, state.phase));
              updateLive({
                connected: true,
                phase: state.phase,
                grind: lastGrind,
                rpm: lastRpm
              });
              log("connected (grind=" + lastGrind + " rpm=" + lastRpm + ")");
            },

            disconnect() {
              if (active) active.stopped = true;
              active = null;
              updateLive({ connected: false });
            },

            async start() {
              const state = requireActive();
              await write(state, frameStart(lastGrind, lastRpm));
              // Moving to target; the reach/grind-start frames flip to "grinding".
              setPhase(state, "busy");
            },

            async stop() {
              const state = requireActive();
              await write(state, frameStop());
              setPhase(state, "idle");
            },

            async setGrindSetting(setting) {
              const state = requireActive();
              lastGrind = parseGrind(setting);
              // Stores the target only — the xBloom does not move to the
              // requested grind/rpm until start().
              await write(state, frameSet(lastGrind, lastRpm));
              await state.session.publish(snapshot(state, state.phase));
              updateLive({ grind: lastGrind });
            },

            async setRpm(rpm) {
              const state = requireActive();
              lastRpm = parseRpm(rpm);
              // See setGrindSetting: configure only, no movement.
              await write(state, frameSet(lastGrind, lastRpm));
              await state.session.publish(snapshot(state, state.phase));
              updateLive({ rpm: lastRpm });
            }
          };
          // The `rpm` endpoint posts without a device id; the newest binding
          // owns it, and its setRpm is the same path the host's control setter
          // takes.
          boundDriver = driver;
          return driver;
        }
      });
    },

    // Serves the driver's `settings` surface, the Streamline `skin` answer and
    // the `ui` overlay page. Native device management opens the host-built
    // href for the settings surface; other callers can read the same values as
    // JSON.
    __httpRequestHandler(request) {
      if (!request) return jsonResponse(404, { error: "Unknown endpoint" });
      if (request.endpoint === "skin") return jsonResponse(200, skinAnswer());
      if (request.endpoint === "ui") return handleUi(request);
      if (request.endpoint === "rpm") return handleRpm(request);
      if (request.endpoint === "device-settings") return handleDeviceSettings(request);
      return jsonResponse(404, { error: "Unknown endpoint" });
    },

    onEvent(event) {
      if (!event || typeof event.name !== "string") return;
      const payload = event.payload || {};
      if (event.name === "storageRead") {
        const entry = pendingReads.get(payload.key);
        if (entry) {
          pendingReads.delete(payload.key);
          clearTimeout(entry.timer);
          entry.resolve(payload.value);
        }
      } else if (event.name === "storageWrite") {
        const resolve = pendingWrites.shift();
        if (resolve) resolve();
      }
    },

    // Host retires any live BLE session on unload; clear plugin-level requests.
    onUnload() {
      for (const entry of pendingReads.values()) clearTimeout(entry.timer);
      pendingReads.clear();
      pendingWrites.length = 0;
      activeInstances.clear();
      boundDriver = null;
    }
  };
}
