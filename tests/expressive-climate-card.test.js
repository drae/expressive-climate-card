const { JSDOM } = require("jsdom");
const fs = require("fs");
const dom = new JSDOM(`<!doctype html><body></body>`, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
w.eval(`customElements.define("ha-card", class extends HTMLElement {});
customElements.define("ha-icon", class extends HTMLElement { set icon(v){this._i=v} get icon(){return this._i} });`);
w.eval(fs.readFileSync(process.argv[2] ?? `${__dirname}/../expressive-climate-card.js`, "utf8"));

const ok = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const later = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const CL = "climate.thermostat", ROOM = "sensor.room", BOOST = "binary_sensor.boost", AWAY = "input_boolean.away", DOOR = "input_text.door";
const climate = (state, attrs = {}) => ({ state, last_changed: new Date().toISOString(), attributes: {
  hvac_modes: ["auto", "heat", "off"], preset_modes: ["boost", "none"], min_temp: 5, max_temp: 32, target_temp_step: 0.5,
  temperature: 18.5, current_temperature: 19.1, hvac_action: "idle", preset_mode: "none", friendly_name: "Thermostat", ...attrs } });
const base = () => ({
  [CL]: climate("auto"),
  [ROOM]: { state: "19.2", attributes: {} },
  [BOOST]: { state: "off", last_changed: new Date().toISOString(), attributes: {} },
  [AWAY]: { state: "off", attributes: {} },
  [DOOR]: { state: "", attributes: {} },
});
let states = base();
let calls = [];
let hive = true;
let ws = [];
const history = { [ROOM]: [{ s: "18.8" }, { s: "19.4" }, { s: "19.9" }, { s: "unavailable" }] };
const hass = () => ({
  states: { ...states },
  services: hive ? { hive: { boost_heating_on: {}, boost_heating_off: {} } } : {},
  callService: (d, s, data) => calls.push([d, s, data]),
  callWS: (msg) => { ws.push(msg); return Promise.resolve(history); },
});
const cfg = {
  entity: CL, temperature_entity: ROOM, min: 12, max: 25,
  boost: { entity: BOOST, minutes: 60, temperature: 21 },
  off_reasons: [
    { entity: AWAY, state: "on", label: "Away · heating suspended", icon: "mdi:home-export-outline" },
    { entity: DOOR, not_state: "", label: "Paused · door open", icon: "mdi:door-open" },
  ],
};
const mk = (c = cfg) => {
  const el = w.document.createElement("expressive-climate-card");
  el.setConfig(c);
  el.hass = hass();
  w.document.body.append(el);
  el.shadowRoot.querySelector(".track").getBoundingClientRect = () => ({ left: 0, width: 130, top: 0, height: 56 });
  return el;
};
const $ = (el, s) => el.shadowRoot.querySelector(s);
const text = (el, s) => $(el, s).textContent.replace(/\s+/g, " ").trim();
const update = (el) => { el.hass = hass(); };
const ptr = (el, type, x) => $(el, ".track").dispatchEvent(new w.MouseEvent(type, { clientX: x, bubbles: true, button: 0 }));
const last = () => JSON.stringify(calls.at(-1));
const menuItems = (el) => [...el.shadowRoot.querySelectorAll(".menu button")];
const openMenu = (el) => $(el, ".val").dispatchEvent(new w.Event("click", { bubbles: true }));
const pick = (el, label) => menuItems(el).find((b) => b.firstChild.textContent === label).dispatchEvent(new w.Event("click", { bubbles: true }));

(async () => {
  try { w.document.createElement("expressive-climate-card").setConfig({ entity: "light.x" }); ok(false, "should throw"); }
  catch (e) { ok(/climate/.test(e.message), "rejects a non-climate entity"); }

  // Idle in auto
  let c = mk();
  ok(text(c, ".name") === "Thermostat", "name from the entity");
  ok(text(c, ".val") === "18.5°·Auto", "value reads target · mode");
  ok(!!$(c, ".val .arr svg"), "chevron after the mode");
  ok($(c, ".val .md").nextElementSibling.classList.contains("arr"), "the chevron follows the mode, not the temperature");
  ok(text(c, ".sub") === "Idle · 19.2°", "status: idle · room temperature from temperature_entity");
  ok($(c, ".pip ha-icon").icon === "mdi:thermostat", "idle icon");
  ok($(c, ".track").style.getPropertyValue("--es-active").includes("state-climate-auto-color"), "idle fill uses the auto colour");
  ok(!$(c, ".track").classList.contains("lit"), "no glow while idle");
  ok(Math.abs(Number($(c, ".track").style.getPropertyValue("--ec-p")) - 6.5 / 13) < 1e-9, "handle at 18.5 on 12–25");
  ok(Math.abs(Number($(c, ".ghost").style.getPropertyValue("--es-g")) - 7.2 / 13) < 1e-9, "room mark at 19.2");
  ok(c.shadowRoot.querySelectorAll(".tick").length === 12, "a dot every 1° inside 12–25 (13…24)");
  ok(text(c, ".foot .mn") === "12.0°" && text(c, ".foot .mx") === "25.0°" && text(c, ".foot .bt") === "", "12° / 25° under the track, no boost text");

  // 24 h band from history, widened by live readings
  await later();
  ok(ws.length === 1 && ws[0].type === "history/history_during_period" && ws[0].entity_ids[0] === ROOM && ws[0].no_attributes, "fetches the room sensor's history once");
  ok(Math.abs(Date.now() - Date.parse(ws[0].start_time) - 24 * 3600000) < 5000, "24 hours back");
  ok(!$(c, ".range").hidden, "band shown");
  ok(Math.abs(Number($(c, ".range").style.getPropertyValue("--es-lo")) - 6.8 / 13) < 1e-9 &&
     Math.abs(Number($(c, ".range").style.getPropertyValue("--es-hi")) - 7.9 / 13) < 1e-9, "band spans 18.8–19.9");
  states[ROOM] = { state: "20.6", attributes: {} };
  update(c);
  ok(Math.abs(Number($(c, ".range").style.getPropertyValue("--es-hi")) - 8.6 / 13) < 1e-9, "a live reading widens the band");
  update(c);
  ok(ws.length === 1, "no refetch on a state update");

  // Heating
  states = base();
  states[CL] = climate("auto", { hvac_action: "heating", temperature: 19.5 });
  update(c);
  ok(text(c, ".sub") === "Heating · 19.2°", "status: heating");
  ok($(c, ".track").classList.contains("lit"), "glow while heating");
  ok($(c, ".track").style.getPropertyValue("--es-active").includes("state-climate-heat-color"), "heating fill uses the heat colour");
  ok($(c, ".pip ha-icon").icon === "mdi:fire", "heating icon");

  // Off, and why
  states = base();
  states[CL] = climate("off", { hvac_action: "off", temperature: 7 });
  update(c);
  ok(text(c, ".val") === "Off", "off: value reads Off");
  ok($(c, ".val .t").nextElementSibling.classList.contains("arr"), "off: chevron after Off");
  ok(text(c, ".sub") === "Off · 19.2°", "off by hand");
  ok($(c, ".pip ha-icon").icon === "mdi:power", "off icon");
  states[DOOR] = { state: "auto", attributes: {} };
  update(c);
  ok(text(c, ".sub") === "Paused · door open · 19.2°" && $(c, ".pip ha-icon").icon === "mdi:door-open", "off by the door pause");
  states[AWAY] = { state: "on", attributes: {} };
  update(c);
  ok(text(c, ".sub") === "Away · heating suspended · 19.2°", "the first matching reason wins");
  calls = [];
  ptr(c, "pointerdown", 10); ptr(c, "pointermove", 80); ptr(c, "pointerup", 80);
  ok(calls.length === 0, "no target changes while off");

  // A thermostat waking from off reports 7° until its next poll: keep the last good target
  states = base();
  update(c);
  states[CL] = climate("auto", { temperature: 7 });
  update(c);
  ok(text(c, ".val") === "18.5°·Auto", "an out-of-range target holds the last good one");

  // Drag: snaps to the step, sends on release, faded until reported
  states = base();
  update(c);
  calls = [];
  ptr(c, "pointerdown", 30); ptr(c, "pointermove", 40); ptr(c, "pointermove", 75.4);
  ok(calls.length === 0, "nothing sent mid-drag");
  ptr(c, "pointerup", 75.4);
  ok(last() === JSON.stringify(["climate", "set_temperature", { entity_id: CL, temperature: 19.5 }]), "release sends the snapped value (19.54 → 19.5)");
  ok($(c, ".val .t").classList.contains("pend") && text(c, ".sub") === "Updating…", "faded and Updating… until reported");
  update(c);
  ok(text(c, ".val").startsWith("19.5°"), "the request holds while the climate still reports the old target");
  states[CL] = climate("auto", { temperature: 19.5 });
  update(c);
  ok(!$(c, ".val .t").classList.contains("pend") && text(c, ".sub") === "Idle · 19.2°", "cleared once reported");

  // Tap on the track jumps there (double tap is none by default)
  calls = [];
  ptr(c, "pointerdown", 10); ptr(c, "pointerup", 10);
  ok(last() === JSON.stringify(["climate", "set_temperature", { entity_id: CL, temperature: 13 }]), "a tap sets the value straight away");

  // Keys
  states = base();
  c.remove(); c = mk();
  calls = [];
  $(c, ".track").dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  $(c, ".track").dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  ok(calls.length === 0 && text(c, ".val").startsWith("19.5°"), "arrow keys step at once and wait to send");
  await later(700);
  ok(last() === JSON.stringify(["climate", "set_temperature", { entity_id: CL, temperature: 19.5 }]), "one send after the last key");

  // Menu
  states = base();
  c.remove(); c = mk();
  openMenu(c);
  ok(!$(c, ".menu").hidden && $(c, ".val").getAttribute("aria-expanded") === "true", "tapping the value opens the menu");
  ok(menuItems(c).map((b) => b.firstChild.textContent).join() === "Auto,Heat,Off,Boost", "modes only, plus boost");
  ok(menuItems(c)[0].classList.contains("cur"), "current mode marked");
  ok(text(c, ".menu button:last-child span") === "60 min · 21.0°", "boost shows its length and temperature");
  calls = [];
  pick(c, "Heat");
  ok($(c, ".menu").hidden, "picking closes the menu");
  ok(last() === JSON.stringify(["climate", "set_hvac_mode", { entity_id: CL, hvac_mode: "heat" }]), "Heat → set_hvac_mode");
  ok(text(c, ".val") === "18.5°·Heat" && $(c, ".val .md").classList.contains("pend"), "mode shows at once, faded");
  states[CL] = climate("heat");
  update(c);
  ok(!$(c, ".val .md").classList.contains("pend"), "mode confirmed");
  openMenu(c);
  w.document.body.dispatchEvent(new w.MouseEvent("pointerdown", { bubbles: true }));
  ok($(c, ".menu").hidden, "a press outside closes the menu");
  $(c, "ha-card").getBoundingClientRect = () => ({ left: 0, top: 100, right: 380, bottom: 220, width: 380, height: 120 });
  $(c, ".val").getBoundingClientRect = () => ({ left: 250, top: 112, right: 364, bottom: 132, width: 114, height: 20 });
  openMenu(c);
  ok($(c, ".menu").style.top === "36px" && $(c, ".menu").style.right === "16px", "menu drops from the value, right edge under the arrow");
  openMenu(c);

  // Boost on, Hive service
  calls = [];
  openMenu(c); pick(c, "Boost");
  ok(last() === JSON.stringify(["hive", "boost_heating_on", { entity_id: CL, time_period: "01:00:00", temperature: 21 }]), "Boost → hive.boost_heating_on 01:00:00 at 21°");
  // Boost running: the boost entity started 18 min ago
  states[CL] = climate("heat", { preset_mode: "boost", temperature: 21, hvac_action: "heating" });
  states[BOOST] = { state: "on", last_changed: new Date(Date.now() - 18 * 60000 - 5000).toISOString(), attributes: {} };
  update(c);
  ok(text(c, ".foot .bt") === "Boost · 42 min left", "time left under the track");
  ok(text(c, ".val") === "21.0°·Boost" && text(c, ".sub") === "Heating · 19.2°", "value shows the boost temperature, status stays plain");
  ok($(c, ".pip ha-icon").icon === "mdi:fire-alert", "boost icon");
  calls = [];
  ptr(c, "pointerdown", 30); ptr(c, "pointermove", 40); ptr(c, "pointermove", 100); ptr(c, "pointerup", 100);
  ok(last() === JSON.stringify(["climate", "set_temperature", { entity_id: CL, temperature: 22 }]), "while boosting, the slider sets the boost temperature");
  openMenu(c);
  ok(menuItems(c).at(-1).firstChild.textContent === "Stop boost" && text(c, ".menu button:last-child span") === "42 min left", "menu offers Stop boost");
  calls = [];
  pick(c, "Stop boost");
  ok(last() === JSON.stringify(["hive", "boost_heating_off", { entity_id: CL }]), "Stop boost → hive.boost_heating_off");
  // Picking another mode while boosting stops the boost first
  states[CL] = climate("heat", { preset_mode: "boost", temperature: 21, hvac_action: "heating" });
  c.remove(); c = mk();
  calls = [];
  openMenu(c); pick(c, "Auto");
  ok(calls.length === 2 && calls[0][1] === "boost_heating_off" && calls[1][1] === "set_hvac_mode", "another mode while boosting: boost off, then the mode");

  // Without Hive: the climate's boost preset
  hive = false;
  states = base();
  c.remove(); c = mk();
  calls = [];
  openMenu(c); pick(c, "Boost");
  ok(last() === JSON.stringify(["climate", "set_preset_mode", { entity_id: CL, preset_mode: "boost" }]), "no Hive: set_preset_mode boost");
  states[CL].attributes.preset_modes = ["none"];
  c.remove(); c = mk();
  openMenu(c);
  ok(!menuItems(c).some((b) => b.dataset.boost), "no boost row when there's no way to boost");
  hive = true;

  // Options
  states = base();
  c.remove();
  c = mk({ entity: CL, ticks: false, labels: false, history: false, styles: { card: { background: "transparent" }, name: { size: 14 }, track: { heating: "#f00" } } });
  await later();
  ok(c.shadowRoot.querySelectorAll(".tick").length === 0, "ticks: false");
  ok($(c, ".foot").hidden, "labels: false hides the row when not boosting");
  ok($(c, ".range").hidden, "history: false, no band");
  ok($(c, "ha-card").classList.contains("transparent"), "styles.card.background transparent");
  ok(/\.name \{ font-size: 14px; \}/.test($(c, "#user").textContent) && /--ec-heating: #f00/.test($(c, "#user").textContent), "styles blocks and track colours");
  ok(text(c, ".sub") === "Idle · 19.1°", "room temperature falls back to current_temperature");
  ok(Math.abs(Number($(c, ".track").style.getPropertyValue("--ec-p")) - 13.5 / 27) < 1e-9, "range falls back to min_temp / max_temp");

  // Unavailable
  states[CL] = { state: "unavailable", attributes: {} };
  update(c);
  ok(text(c, ".val") === "Unavailable" && text(c, ".sub") === "Unavailable", "unavailable");

  // Detaching clears timers
  states = base();
  states[CL] = climate("heat", { preset_mode: "boost", temperature: 21, hvac_action: "heating" });
  states[BOOST] = { state: "on", last_changed: new Date().toISOString(), attributes: {} };
  c.remove(); c = mk();
  ok(c._countdown && c._historyTimer, "countdown and history refresh running");
  c.remove();
  ok(!c._countdown && !c._historyTimer, "cleared when detached");

  ok(c.getGridOptions().rows === "auto", "grid rows auto");
  process.exit();
})();
