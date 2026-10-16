// Headless check for the xBloom grinder plugin: loads plugin.js with test
// UUIDs, drives the handlers through a fake session, and validates the
// driver's BLE writes against the observed device behavior. No Decaid, no
//
// It also checks the Streamline dashboard surfaces: the `skin` answer, the
// `ui` overlay page (through a stub DOM, so its messages and REST sequencing
// are exercised), the framing headers, and the `changed` emit.
//
//   node scripts/check_plugin.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "xbloom-grinder.reaplugin/plugin.js"), "utf8");

const createPlugin = new Function(source + "; return createPlugin;")();

const SERVICE = "0000e0ff-3c17-d293-8e48-14fe2e4da212";
const writes = [];
const published = [];
// host.emit("changed", …) calls, for the Streamline live push.
const emitted = [];
let notify = null;
let disconnected = false;
// The driver's latest onDisconnect handler, so a host-reported drop can be
// replayed (the session above never drops on its own).
let onDisconnectHandler = null;

const session = {
  gatt: {
    discoverServices: async () => [SERVICE],
    subscribe: async (_s, _c, cb) => {
      notify = cb;
      return { unsubscribe: async () => {} };
    },
    writeWithoutResponse: async (_s, _c, data) => writes.push(Buffer.from(data, "base64").toString("hex")),
    onDisconnect: (cb) => {
      disconnected = true;
      onDisconnectHandler = cb;
    },
  },
  publish: async (snap) => published.push(snap),
  reportDisconnected: async () => {},
};

let factory = null;
const store = new Map();
let plugin = null;
const host = {
  log: () => {},
  emit: (name, payload) => emitted.push({ name, payload }),
  storage: (cmd) => {
    if (cmd.type === "read") {
      const value = store.has(cmd.key) ? store.get(cmd.key) : null;
      queueMicrotask(() =>
        plugin.onEvent({ name: "storageRead", payload: { key: cmd.key, value } }),
      );
    } else {
      store.set(cmd.key, cmd.data);
      queueMicrotask(() =>
        plugin.onEvent({ name: "storageWrite", payload: cmd.data }),
      );
    }
  },
  devices: {
    bindDriver: async (id, f) => {
      assert.equal(id, "xbloom");
      factory = f;
    },
  },
};

plugin = createPlugin(host);
await plugin.onLoad();
assert.ok(factory, "bindDriver was not called");
const handlers = factory.create({ id: "x", name: "XBLOOM", advertisement: {} });

await handlers.connect(session);
assert.deepEqual(published[0], { state: "idle", setting: "50", rpm: 60 }, "initial snapshot");
assert.ok(disconnected, "onDisconnect was not registered");

await handlers.setGrindSetting("50");
assert.equal(writes.at(-1), "580101461f1400000001320000003c0000000403", "set frame");
assert.deepEqual(published.at(-1), { state: "idle", setting: "50", rpm: 60 });

await handlers.setRpm(60);
assert.equal(writes.at(-1), "580101461f1400000001320000003c0000000403", "set frame (rpm)");

// start/stop are not declared (the START frame did not start the device), so
// the driver exposes no such handlers.
assert.equal(typeof handlers.start, "undefined", "no start handler");
assert.equal(typeof handlers.stop, "undefined", "no stop handler");

await assert.rejects(() => handlers.setGrindSetting("81"), /grind setting/);
await assert.rejects(() => handlers.setRpm(0), /rpm/);

// Phase transitions from notifications: the burr moves to target first (0x9e39),
// then real grinding starts at the reach event (0x9e4e). Duplicates must not
// republish.
const notifyFrame = (cmd, payload = []) =>
  Buffer.from(
    [0x58, 0x02, 0x01, cmd & 0xff, (cmd >> 8) & 0xff, 0x0c, 0, 0, 0, 1]
      .concat(payload, [0, 0]),
  ).toString("base64");

notify(notifyFrame(0x9e39, [68, 0, 0, 0]));
assert.equal(published.at(-1).state, "busy", "move frame → busy");
const afterMove = published.length;
notify(notifyFrame(0x9e39, [68, 0, 0, 0]));
assert.equal(published.length, afterMove, "repeated move frames did not republish");
assert.equal(published.at(-1).state, "busy", "still moving");
notify(notifyFrame(0x9e4e, [80, 0, 0, 0]));
assert.equal(published.at(-1).state, "grinding", "reach event → grinding");
notify(notifyFrame(0x9e45));
assert.equal(published.at(-1).state, "idle", "autonomous stop → idle");

// Settings surface: GET renders a page, POST persists per device, and a live
// instance adopts the new defaults.
const settingsRequest = (method, query, body = null) => ({
  requestId: "settings",
  endpoint: "device-settings",
  method,
  headers: {},
  query,
  body,
});
const page = await plugin.__httpRequestHandler(
  settingsRequest("GET", { ui: "1", deviceId: "x", deviceName: "XBLOOM" }),
);
assert.equal(page.status, 200, "settings page status");
assert.match(page.headers["Content-Type"], /text\/html/, "settings page content type");
assert.match(page.body, /value="50"/, "settings page shows default grind");
assert.match(page.body, /value="60"/, "settings page shows default rpm");

const writesBeforeSave = writes.length;
const saved = await plugin.__httpRequestHandler(
  settingsRequest("POST", { deviceId: "x" }, { grind: 30, rpm: 90 }),
);
assert.equal(saved.status, 200);
assert.ok(
  writes.length > writesBeforeSave,
  "saving defaults sends a set frame to the connected grinder",
);
assert.deepEqual(JSON.parse(saved.body), { deviceId: "x", grind: 30, rpm: 90 });
assert.equal(store.get("x"), JSON.stringify({ grind: 30, rpm: 90 }), "defaults persisted");
assert.deepEqual(
  published.at(-1),
  { state: "idle", setting: "30", rpm: 90 },
  "live instance adopted defaults",
);

const rejected = await plugin.__httpRequestHandler(
  settingsRequest("POST", { deviceId: "x" }, { grind: 900, rpm: 90 }),
);
assert.equal(rejected.status, 400, "out-of-range defaults rejected");
const offStep = await plugin.__httpRequestHandler(
  settingsRequest("POST", { deviceId: "x" }, { grind: 30, rpm: 75 }),
);
assert.equal(offStep.status, 400, "off-step rpm default rejected");
assert.equal(
  (await plugin.__httpRequestHandler({ endpoint: "other", method: "GET", query: {} })).status,
  404,
  "unknown endpoint",
);

// A reconnect reloads the persisted defaults.
handlers.disconnect();
await handlers.connect(session);
assert.deepEqual(
  published.at(-1),
  { state: "idle", setting: "30", rpm: 90 },
  "reconnect loads persisted defaults",
);
handlers.disconnect();
await assert.rejects(() => handlers.setGrindSetting("30"), /not connected/);

// Older Decaid without the `busy` state: the host rejects the publication and
// the plugin falls back to idle for the move phase.
{
  const fallback = [];
  let fallbackNotify = null;
  const fallbackSession = {
    gatt: {
      discoverServices: async () => [SERVICE],
      subscribe: async (_s, _c, cb) => {
        fallbackNotify = cb;
        return { unsubscribe: async () => {} };
      },
      writeWithoutResponse: async () => {},
      onDisconnect: () => {},
    },
    publish: async (snap) => {
      if (snap.state === "busy") {
        const error = new Error("Invalid Grinder publication");
        error.code = "invalid_argument";
        throw error;
      }
      fallback.push(snap);
    },
    reportDisconnected: async () => {},
  };
  let fallbackFactory = null;
  const fallbackHost = {
    log: () => {},
    devices: {
      bindDriver: async (_id, f) => {
        fallbackFactory = f;
      },
    },
  };
  const fallbackPlugin = createPlugin(fallbackHost);
  await fallbackPlugin.onLoad();
  const fallbackHandlers = fallbackFactory.create({});
  await fallbackHandlers.connect(fallbackSession);
  fallbackNotify(notifyFrame(0x9e39, [0, 0, 0, 0]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fallback.at(-1).state, "idle", "busy unsupported → idle fallback");
}

// --- Streamline dashboard surfaces (skin, ui, changed) --------------------

// Manifest: the three surface endpoints plus the emit permission, with the
// BLE driver and its device-settings surface untouched.
{
  const manifest = JSON.parse(
    readFileSync(join(root, "xbloom-grinder.reaplugin/manifest.json"), "utf8"),
  );
  assert.equal(manifest.version, "1.1.0", "manifest version bumped for the surfaces");
  assert.ok(manifest.permissions.includes("api"), "api permission kept");
  assert.ok(manifest.permissions.includes("emit"), "emit permission declared");
  const endpoints = new Map(manifest.api.map((entry) => [entry.id, entry.type]));
  assert.equal(endpoints.get("skin"), "http", "skin is an http endpoint");
  assert.equal(endpoints.get("ui"), "http", "ui is an http endpoint");
  assert.equal(endpoints.get("rpm"), "http", "rpm (numpad call) is an http endpoint");
  assert.equal(endpoints.get("changed"), "websocket", "changed is a websocket endpoint");
  assert.equal(endpoints.get("device-settings"), "http", "device-settings endpoint kept");
  for (const id of ["state", "set-grind", "mock"]) {
    assert.equal(endpoints.get(id), "http", id + " is an http endpoint");
  }
  assert.ok(manifest.settings && manifest.settings.MockGrinder, "MockGrinder setting declared");
  assert.deepEqual(
    manifest.drivers[0].capabilities,
    ["grindSetting", "rpmControl"],
    "driver capabilities (no startStop)",
  );
  assert.deepEqual(
    manifest.drivers[0].controls,
    {
      grindSetting: { kind: "numeric", min: 1, max: 80, step: 1 },
      rpmControl: { kind: "numeric", min: 60, max: 120, step: 10 },
    },
    "typed controls unchanged",
  );
  assert.deepEqual(
    manifest.drivers[0].surfaces,
    [{ id: "settings", role: "settings", endpoint: "device-settings", label: "Defaults" }],
    "device-settings surface unchanged",
  );
}

const skinAnswer = async () => {
  const response = await plugin.__httpRequestHandler({
    requestId: "skin",
    endpoint: "skin",
    method: "GET",
    headers: {},
    query: {},
  });
  assert.equal(response.status, 200, "skin status");
  assert.match(response.headers["Content-Type"], /application\/json/, "skin content type");
  return JSON.parse(response.body);
};
const surfaceOf = (answer, kind) => answer.surfaces.find((surface) => surface.kind === kind);

// Connecting moves the live view, which emits; the skin answer itself needs no
// grinder and is served from that in-memory view.
await handlers.connect(session);
assert.deepEqual(
  emitted.at(-1),
  { name: "changed", payload: { what: "skin" } },
  "connect emits changed",
);
let answer = await skinAnswer();
assert.equal(answer.version, 1, "skin answer version");
assert.deepEqual(answer.live, { endpoint: "changed" }, "live endpoint");
assert.equal(answer.surfaces.length, 3, "three surfaces");
assert.deepEqual(
  answer.surfaces.map((surface) => surface.kind),
  ["tile-line", "tile-hint", "header-button"],
  "surface kinds",
);
for (const surface of answer.surfaces) {
  assert.match(surface.id, /^[A-Za-z0-9_-]{1,40}$/, "surface id charset and length");
}
assert.equal(
  new Set(answer.surfaces.map((surface) => surface.id)).size,
  answer.surfaces.length,
  "surface ids unique",
);

const line = surfaceOf(answer, "tile-line");
assert.equal(line.tile, "grind", "line sits on the grind tile");
assert.equal(line.text, "90 rpm", "line shows the current rpm");
assert.ok(line.text.length <= 40, "line text within 40 characters");
assert.equal(line.active, false, "idle grinder → line not active");
assert.deepEqual(
  line.action,
  {
    type: "call",
    endpoint: "rpm",
    field: "rpm",
    input: { title: "RPM", unit: "", min: 60, max: 120, decimals: 0, value: 90 },
  },
  "line carries the rpm numpad call",
);

const hint = surfaceOf(answer, "tile-hint");
assert.equal(hint.tile, "grind", "hint sits on the grind tile");
assert.ok(hint.text.length > 0 && hint.text.length <= 24, "hint text within 24 characters");
assert.deepEqual(
  hint.action,
  {
    type: "call",
    endpoint: "set-grind",
    field: "setting",
    input: { title: "Grind", unit: "", min: 1, max: 80, decimals: 0, value: 30 },
  },
  "hint opens the grind numpad and calls set-grind",
);

const button = surfaceOf(answer, "header-button");
assert.ok(button.label.length > 0 && button.label.length <= 24, "button label within 24 characters");
assert.ok(button.text.length > 0 && button.text.length <= 40, "button text within 40 characters");
assert.match(button.text, /30/, "button text shows the current grind");
assert.deepEqual(
  button.action,
  { type: "open", view: "grinder", presentation: "overlay", fit: true },
  "button opens the grinder overlay",
);

// A setter moves the live view, the answer follows, and the push fires once.
const beforeSetter = emitted.length;
await handlers.setGrindSetting("35");
assert.equal(emitted.length, beforeSetter + 1, "setter emits changed");
assert.deepEqual(emitted.at(-1), { name: "changed", payload: { what: "skin" } }, "setter payload");
answer = await skinAnswer();
assert.match(surfaceOf(answer, "header-button").text, /35/, "button text follows the setter");
assert.equal(surfaceOf(answer, "tile-line").text, "90 rpm", "line still shows the rpm");

// Moving to target is not idle, so the line is drawn active.
notify(notifyFrame(0x9e39, [0, 0, 0, 0]));
assert.equal(surfaceOf(await skinAnswer(), "tile-line").active, true, "moving grinder → line active");

// A notification-driven phase change updates the view and pushes.
const beforeNotify = emitted.length;
notify(notifyFrame(0x9e4e, [80, 0, 0, 0]));
assert.equal(emitted.length, beforeNotify + 1, "phase change emits changed");
assert.deepEqual(emitted.at(-1), { name: "changed", payload: { what: "skin" } }, "phase payload");
assert.equal(surfaceOf(await skinAnswer(), "tile-line").active, true, "grinding → line active");

// The `rpm` endpoint behind the line's numpad call is the same path as the
// host's own control setter, re-validated here because anyone can POST to it.
const rpmRequest = (body, method = "POST") => ({
  requestId: "rpm",
  endpoint: "rpm",
  method,
  headers: {},
  body,
  query: {},
});
const beforeRpmCall = emitted.length;
const rpmApplied = await plugin.__httpRequestHandler(rpmRequest({ rpm: 100 }));
assert.equal(rpmApplied.status, 200, "rpm call accepted");
assert.deepEqual(JSON.parse(rpmApplied.body), { rpm: 100 }, "rpm call echoes the value");
assert.equal(emitted.length, beforeRpmCall + 1, "rpm call emits changed once");
assert.deepEqual(emitted.at(-1), { name: "changed", payload: { what: "skin" } }, "rpm call payload");
assert.equal(
  surfaceOf(await skinAnswer(), "tile-line").text,
  "100 rpm",
  "rpm call follows into the line",
);
assert.equal(
  surfaceOf(await skinAnswer(), "tile-line").action.input.value,
  100,
  "the line's numpad opens on the new value",
);
for (const bad of [59, 65, 121, 60.5, "abc", null, {}]) {
  const rejected = await plugin.__httpRequestHandler(rpmRequest({ rpm: bad }));
  assert.equal(rejected.status, 400, `rpm call rejects ${JSON.stringify(bad)}`);
}
assert.equal(
  (await plugin.__httpRequestHandler(rpmRequest({ rpm: 90 }, "GET"))).status,
  405,
  "rpm call requires POST",
);

// Offline: the answer is still served without blocking, and says so.
handlers.disconnect();
assert.deepEqual(
  emitted.at(-1),
  { name: "changed", payload: { what: "skin" } },
  "disconnect emits changed",
);
answer = await skinAnswer();
assert.equal(surfaceOf(answer, "tile-line").active, false, "offline → line not active");
assert.match(surfaceOf(answer, "header-button").text, /offline/i, "button reports offline");

// Saving the device defaults moves the live view too (applyDefaults).
const resaved = await plugin.__httpRequestHandler(
  settingsRequest("POST", { deviceId: "x" }, { grind: 12, rpm: 80 }),
);
assert.equal(resaved.status, 200, "device defaults saved");
assert.deepEqual(
  emitted.at(-1),
  { name: "changed", payload: { what: "skin" } },
  "applyDefaults emits changed",
);
assert.equal(
  surfaceOf(await skinAnswer(), "tile-line").text,
  "80 rpm",
  "applyDefaults follows into the live view",
);

// The other setter moves the live view as well, and a drop the host reports
// (onDisconnect) puts it back offline.
await handlers.connect(session);
const beforeRpm = emitted.length;
await handlers.setRpm(70);
assert.equal(emitted.length, beforeRpm + 1, "setRpm emits changed");
assert.equal(
  surfaceOf(await skinAnswer(), "tile-line").text,
  "70 rpm",
  "setRpm follows into the live view",
);
onDisconnectHandler();
assert.deepEqual(
  emitted.at(-1),
  { name: "changed", payload: { what: "skin" } },
  "onDisconnect emits changed",
);
assert.match(
  surfaceOf(await skinAnswer(), "header-button").text,
  /offline/i,
  "onDisconnect marks the view offline",
);

// Offline, the same call fails fast and says why rather than hanging, and the
// line does not move.
const offlineRpm = await plugin.__httpRequestHandler(rpmRequest({ rpm: 100 }));
assert.equal(offlineRpm.status, 503, "offline rpm call is refused");
assert.match(JSON.parse(offlineRpm.body).error, /not connected/i, "offline rpm call says why");
assert.equal(
  surfaceOf(await skinAnswer(), "tile-line").text,
  "70 rpm",
  "a refused rpm call does not move the line",
);

// A connect that fails (no vendor service) leaves the view offline too.
const failingSession = {
  gatt: {
    discoverServices: async () => [],
    subscribe: async () => ({ unsubscribe: async () => {} }),
    writeWithoutResponse: async () => {},
    onDisconnect: () => {},
  },
  publish: async () => {},
  reportDisconnected: async () => {},
};
await handlers.connect(session);
await assert.rejects(() => handlers.connect(failingSession), /vendor service/);
assert.match(
  surfaceOf(await skinAnswer(), "header-button").text,
  /offline/i,
  "failed connect marks the view offline",
);

// The `ui` page: content type, theme, and the framing headers.
const uiRequest = (headers = {}, query = {}) => ({
  requestId: "ui",
  endpoint: "ui",
  method: "GET",
  headers,
  query,
});
const uiPage = await plugin.__httpRequestHandler(uiRequest());
assert.equal(uiPage.status, 200, "ui status");
assert.match(uiPage.headers["Content-Type"], /text\/html/, "ui content type");
assert.equal(uiPage.headers["Content-Security-Policy"], undefined, "no Origin/Referer → no CSP");
assert.match(uiPage.body, /streamline:ready/, "ui posts ready");
assert.match(uiPage.body, /streamline:size/, "ui posts size");
assert.match(uiPage.body, /streamline:close/, "ui posts close");
assert.match(uiPage.body, /fetch\('state'\)/, "ui reads the plugin's own state");
assert.match(uiPage.body, /\/api\/v1\/devices\//, "ui can drive Decaid's device connect");
assert.match(uiPage.body, /api\('mock'/, "ui can toggle the mock grinder");
assert.match(uiPage.body, /id="rpm"[^>]*step="10"/, "ui steps rpm by 10");
assert.match(uiPage.body, /id="apply"/, "ui has an Apply button");
assert.match(
  uiPage.body,
  /html,body\{[^}]*background:\s*transparent/,
  "ui leaves the html/body canvas transparent",
);
assert.ok(!/color-scheme/i.test(uiPage.body), "ui does not claim a colour scheme");

const framed = await plugin.__httpRequestHandler(uiRequest({ Origin: "http://localhost:8044" }));
assert.equal(
  framed.headers["Content-Security-Policy"],
  "frame-ancestors 'self' http://localhost:8044",
  "Origin → frame-ancestors",
);
const referred = await plugin.__httpRequestHandler(
  uiRequest({ referer: "http://localhost:8044/dashboard?x=1" }),
);
assert.equal(
  referred.headers["Content-Security-Policy"],
  "frame-ancestors 'self' http://localhost:8044",
  "Referer origin, header lookup case-insensitive",
);
const oddOrigin = await plugin.__httpRequestHandler(
  uiRequest({ Origin: "file:///tmp/page.html" }),
);
assert.equal(
  oddOrigin.headers["Content-Security-Policy"],
  undefined,
  "non-http(s) Origin → no CSP",
);
for (const bad of ["http://evil;script", "http://user:pw@host", "http://"]) {
  const hostile = await plugin.__httpRequestHandler(uiRequest({ Origin: bad }));
  assert.equal(
    hostile.headers["Content-Security-Policy"],
    undefined,
    `malformed Origin (${bad}) → no CSP`,
  );
}

const dark = await plugin.__httpRequestHandler(uiRequest({}, { theme: "dark" }));
assert.match(dark.body, /data-theme="dark"/, "dark theme");
const light = await plugin.__httpRequestHandler(uiRequest({}, { theme: "light" }));
assert.match(light.body, /data-theme="light"/, "light theme");

// The page in a stub DOM: message order, REST sequencing, close behaviour.
function openPage(html, search, href) {
  const posts = [];
  const fetches = [];
  const assigned = [];
  const elements = new Map();
  const windowHandlers = {};
  const elementFor = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: "",
        textContent: "",
        handlers: {},
        addEventListener(type, handler) {
          (this.handlers[type] = this.handlers[type] || []).push(handler);
        },
        getBoundingClientRect: () => ({ width: 320, height: 240 }),
        click() {
          for (const handler of this.handlers.click || []) handler();
        },
      });
    }
    return elements.get(id);
  };
  const document = { getElementById: elementFor };
  const window = {
    parent: { postMessage: (message) => posts.push(message) },
    addEventListener(type, handler) {
      (windowHandlers[type] = windowHandlers[type] || []).push(handler);
    },
  };
  const location = { search, href, assign: (url) => assigned.push(url) };
  const fetchStub = (url, init = {}) => {
    fetches.push({ url, method: init.method || "GET", body: init.body });
    // The page reads the plugin's own `state` endpoint and posts to its action
    // endpoints; the stub answers both shapes.
    const body = /(^|\/)state$/.test(url)
      ? { connected: true, state: "idle", setting: "50", rpm: 90, mock: false }
      : {};
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  };
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  new Function("document", "window", "location", "fetch", "URL", "URLSearchParams", script)(
    document,
    window,
    location,
    fetchStub,
    URL,
    URLSearchParams,
  );
  return {
    posts,
    fetches,
    assigned,
    elementFor,
    resize() {
      for (const handler of windowHandlers.resize || []) handler();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const overlayUrl =
  "http://decaid.local:8080/api/v1/plugins/xbloom-grinder.reaplugin/ui?embed=1&theme=dark";
const overlay = openPage(uiPage.body, "?embed=1&theme=dark", overlayUrl);
await flush();
assert.deepEqual(overlay.posts[0], { type: "streamline:ready" }, "ready posted first");
assert.deepEqual(
  overlay.posts[1],
  { type: "streamline:size", width: 320, height: 240 },
  "size posted after ready",
);
assert.equal(overlay.elementFor("grind").value, "50", "page loads the current grind");
assert.equal(overlay.elementFor("rpm").value, 90, "page loads the current rpm");
const beforeResize = overlay.posts.length;
overlay.resize();
assert.equal(overlay.posts.length, beforeResize + 1, "resize re-posts size");
assert.deepEqual(
  overlay.posts.at(-1),
  { type: "streamline:size", width: 320, height: 240 },
  "size payload",
);

overlay.elementFor("grind").value = "42";
overlay.elementFor("rpm").value = "100";
overlay.fetches.length = 0;
overlay.elementFor("apply").click();
await flush();
assert.deepEqual(
  overlay.fetches.map((call) => call.method + " " + call.url).slice(0, 2),
  ["POST set-grind", "POST rpm"],
  "apply sends grind and rpm",
);
assert.equal(overlay.fetches[0].body, JSON.stringify({ setting: 42 }), "setting body");
assert.equal(overlay.fetches[1].body, JSON.stringify({ rpm: 100 }), "rpm body");

overlay.elementFor("close").click();
assert.deepEqual(overlay.posts.at(-1), { type: "streamline:close" }, "embedded close posts close");
assert.deepEqual(overlay.assigned, [], "embedded close does not navigate");

const backTo = "http://decaid.local:8080/#/dashboard";
const pageMode = openPage(
  uiPage.body,
  "?returnTo=" + encodeURIComponent(backTo) + "&view=grinder",
  "http://decaid.local:8080/api/v1/plugins/xbloom-grinder.reaplugin/ui" +
    "?returnTo=" + encodeURIComponent(backTo) + "&view=grinder",
);
await flush();
pageMode.elementFor("close").click();
assert.deepEqual(pageMode.assigned, [backTo], "page close follows returnTo");
assert.equal(
  pageMode.posts.some((message) => message.type === "streamline:close"),
  false,
  "page close does not post close",
);

const evil = "javascript:alert(1)";
const bad = openPage(
  uiPage.body,
  "?returnTo=" + encodeURIComponent(evil),
  "http://decaid.local:8080/api/v1/plugins/xbloom-grinder.reaplugin/ui?returnTo=" +
    encodeURIComponent(evil),
);
await flush();
bad.elementFor("close").click();
assert.deepEqual(bad.assigned, ["/"], "a non-http returnTo is not followed");

// --- Storage-request fixes -----------------------------------------------

// Overlapping reads of the same key both settle: connect() loads the stored
// defaults while a settings read hits the same key, so a single-slot map would
// strand the connect read forever.
{
  let capturedFactory = null;
  const tried = [];
  const host = {
    log: () => {},
    emit: () => {},
    // Respond only when the test says so.
    storage: (cmd) => { if (cmd.type === "read") tried.push(cmd.key); },
    devices: { bindDriver: async (_id, f) => { capturedFactory = f; } },
  };
  const p = createPlugin(host);
  await p.onLoad();
  const h = capturedFactory.create({ id: "dup" });
  const connecting = h.connect(session); // issues storageRead("dup")
  await new Promise((resolve) => setTimeout(resolve, 0));
  const settingsPending = p.__httpRequestHandler({
    requestId: "dup-settings",
    endpoint: "device-settings",
    method: "GET",
    headers: {},
    query: { deviceId: "dup" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(
    tried.filter((key) => key === "dup").length >= 2,
    "two reads of the same key are in flight",
  );
  p.onEvent({ name: "storageRead", payload: { key: "dup", value: null } });
  assert.equal((await settingsPending).status, 200, "the settings read settled");
  await connecting; // would hang without the per-key waiter queue
  assert.ok(true, "the overlapping connect read settled too");
  p.onUnload();
}

// A write whose confirmation never arrives is settled by onUnload, so an
// in-flight settings POST cannot hang across a reload.
{
  let p = null;
  let capturedFactory = null;
  const host = {
    log: () => {},
    emit: () => {},
    storage: (cmd) => {
      if (cmd.type === "read") {
        queueMicrotask(() =>
          p.onEvent({ name: "storageRead", payload: { key: cmd.key, value: null } }),
        );
      }
      // writes are never confirmed
    },
    devices: { bindDriver: async (_id, f) => { capturedFactory = f; } },
  };
  p = createPlugin(host);
  await p.onLoad();
  const h = capturedFactory.create({ id: "w" });
  await h.connect(session);
  const pending = p.__httpRequestHandler({
    requestId: "w-settings",
    endpoint: "device-settings",
    method: "POST",
    headers: {},
    query: { deviceId: "w" },
    body: { grind: 20, rpm: 80 },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  p.onUnload();
  assert.equal((await pending).status, 200, "the pending write settled on unload");
}

// --- Mock grinder ---------------------------------------------------------

// The toggle drives the real driver through a fake session, so the dashboard
// surfaces report a connected, controllable grinder without hardware.
{
  let mPlugin = null;
  let capturedFactory = null;
  const mockStore = new Map();
  const mockHost = {
    log: () => {},
    emit: () => {},
    storage: (cmd) => {
      if (cmd.type === "read") {
        const value = mockStore.has(cmd.key) ? mockStore.get(cmd.key) : null;
        queueMicrotask(() =>
          mPlugin.onEvent({ name: "storageRead", payload: { key: cmd.key, value } }),
        );
      } else {
        mockStore.set(cmd.key, cmd.data);
        queueMicrotask(() =>
          mPlugin.onEvent({ name: "storageWrite", payload: cmd.data }),
        );
      }
    },
    devices: { bindDriver: async (_id, f) => { capturedFactory = f; } },
  };
  mPlugin = createPlugin(mockHost);
  await mPlugin.onLoad();
  assert.ok(capturedFactory, "mock host bound the driver");

  const req = (endpoint, body, method = "POST") => ({
    requestId: endpoint, endpoint, method, headers: {}, body, query: {},
  });
  const state = async () =>
    JSON.parse((await mPlugin.__httpRequestHandler(req("state", undefined, "GET"))).body);

  assert.equal((await state()).mock, false, "mock is off by default");
  assert.equal((await state()).connected, false, "no grinder without the mock");

  const enabled = await mPlugin.__httpRequestHandler(req("mock", { on: true }));
  assert.equal(enabled.status, 200, "mock toggle accepted");
  assert.deepEqual(JSON.parse(enabled.body), { mock: true }, "mock toggle answer");
  let view = await state();
  assert.equal(view.mock, true, "mock reports on");
  assert.equal(view.connected, true, "mock reports connected");
  assert.equal(mockStore.get("mock"), "1", "mock flag persisted");

  const skinOf = async () =>
    JSON.parse(
      (await mPlugin.__httpRequestHandler({
        requestId: "skin", endpoint: "skin", method: "GET", headers: {}, query: {},
      })).body,
    ).surfaces.find((surface) => surface.kind === "header-button").text;
  assert.doesNotMatch(await skinOf(), /offline/i, "skin shows the mock grinder connected");

  await mPlugin.__httpRequestHandler(req("set-grind", { setting: 33 }));
  await mPlugin.__httpRequestHandler(req("rpm", { rpm: 110 }));
  view = await state();
  assert.equal(view.setting, "33", "mock set-grind applied");
  assert.equal(view.rpm, 110, "mock rpm applied");

  const off = await mPlugin.__httpRequestHandler(req("mock", { on: false }));
  assert.deepEqual(JSON.parse(off.body), { mock: false }, "mock toggle off");
  view = await state();
  assert.equal(view.mock, false, "mock reports off");
  assert.equal(view.connected, false, "mock off → disconnected");
  assert.equal(mockStore.get("mock"), "0", "mock off persisted");

  // A real binding supersedes a running mock.
  await mPlugin.__httpRequestHandler(req("mock", { on: true }));
  assert.equal((await state()).mock, true, "mock re-enabled");
  capturedFactory.create({ id: "real-device" });
  assert.equal((await state()).mock, false, "a real binding stops the mock");
}

// Turning the mock off hands the endpoints back to the real driver, so a mock
// cycle does not leave the plugin talking to a retired mock.
{
  let p = null;
  let factory = null;
  const store = new Map();
  const realWrites = [];
  const realSession = {
    gatt: {
      discoverServices: async () => [SERVICE],
      subscribe: async () => ({ unsubscribe: async () => {} }),
      writeWithoutResponse: async (_s, _c, data) =>
        realWrites.push(Buffer.from(data, "base64").toString("hex")),
      onDisconnect: () => {},
    },
    publish: async () => {},
    reportDisconnected: async () => {},
  };
  const host = {
    log: () => {},
    emit: () => {},
    storage: (cmd) => {
      if (cmd.type === "read") {
        const value = store.has(cmd.key) ? store.get(cmd.key) : null;
        queueMicrotask(() =>
          p.onEvent({ name: "storageRead", payload: { key: cmd.key, value } }),
        );
      } else {
        store.set(cmd.key, cmd.data);
        queueMicrotask(() =>
          p.onEvent({ name: "storageWrite", payload: cmd.data }),
        );
      }
    },
    devices: { bindDriver: async (_id, f) => { factory = f; } },
  };
  const call = (endpoint, body) =>
    p.__httpRequestHandler({
      requestId: endpoint, endpoint, method: "POST", headers: {}, body, query: {},
    });
  p = createPlugin(host);
  await p.onLoad();
  const real = factory.create({ id: "real-1" });
  await real.connect(realSession);
  await call("set-grind", { setting: 20 });
  assert.ok(realWrites.length > 0, "the real driver receives the set frame");

  await call("mock", { on: true });
  const mockWrites = realWrites.length;
  await call("set-grind", { setting: 21 });
  assert.equal(realWrites.length, mockWrites, "while mocked, the real driver is untouched");

  await call("mock", { on: false });
  const afterMock = JSON.parse(
    (await p.__httpRequestHandler({ endpoint: "state", method: "GET", headers: {}, query: {} })).body,
  );
  assert.equal(afterMock.connected, true, "live shows the real grinder again after the mock");
  await call("set-grind", { setting: 22 });
  assert.ok(
    realWrites.length > mockWrites,
    "after the mock is off, the real driver receives frames again",
  );
}

console.log("check_plugin: OK (BLE writes match the observed device behavior)");
