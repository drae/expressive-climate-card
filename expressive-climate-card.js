/*
 * expressive-climate-card
 * Copyright (c) 2026 Paul Owen
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * A thermostat card in the style of expressive-slider-card: the same split track for the
 * target temperature, a mark at the room temperature, a faint band for the room's lowest
 * and highest reading over the last day, and the mode in a menu on the value.
 *
 *   type: custom:expressive-climate-card
 *   entity: climate.thermostat
 *   name: Thermostat           # optional
 *   temperature_entity: sensor.thermostat_current_temperature
 *                              # optional room temperature; default the climate's current_temperature
 *   min: 12                    # optional range; default the climate's min_temp / max_temp
 *   max: 25
 *   step: 0.5                  # default the climate's target_temp_step, else 0.5
 *   ticks: 1                   # a dot every N degrees; false = none
 *   history: 24                # hours of room temperature behind the band; false = no band
 *   labels: true               # min and max under the track
 *   modes:                     # the menu; default the climate's hvac_modes, plus boost when it has one
 *     - auto
 *     - heat
 *     - "off"
 *     - boost
 *   boost:
 *     entity: binary_sensor.thermostat_boost   # optional; its last change is when the boost started
 *     minutes: 60
 *     temperature: 21
 *   off_reasons:               # optional; the first match says why the climate is off
 *     - entity: input_boolean.heating_away_suspended
 *       state: "on"            # or not_state: ""
 *       status: Away           # in the header instead of "Off"
 *       label: Heating suspended   # centred under the track
 *       icon: mdi:home-export-outline
 *   icons:                     # pip icons
 *     heating: mdi:fire
 *     idle: mdi:thermostat
 *     boost: mdi:fire-alert
 *     off: mdi:power
 *   glow: true                 # the soft light round the fill while heating
 *   tap_action:                # tapping the name or the pip (the value opens the mode menu)
 *     action: more-info
 *   hold_action:               # holding the slider
 *     action: more-info
 *   double_tap_action:         # double tapping the slider; a single tap then waits 250 ms
 *     action: none
 *   styles:                    # one block per element, as in expressive-slider-card
 *     card:
 *       background: transparent
 *     name:
 *       size: 14
 *     track:
 *       heating: "#ff4500"     # fill while heating; default --state-climate-heat-color
 *       idle: "#75985d"        # fill while idle; default --state-climate-auto-color
 *       height: 56
 *     pip:
 *       background: 25         # number = % of the fill colour mixed with black; or a fixed colour
 *     glow:
 *       softness: 32
 *       strength: 75
 *
 * Elements: card, header, name, status, value, track, fill, empty, handle, bubble, pip, icon, band,
 * mark (the room temperature), labels, boost (the time left under the track), menu, glow.
 *
 * Changes are held, faded, until the climate reports them (cloud thermostats can take minutes).
 * Boost uses hive.boost_heating_on / boost_heating_off when they exist, else the climate's boost preset.
 * While a boost runs, the slider sets the boost temperature.
 */

const VERSION = "0.1.0";
const HOLD_MS = 500;
const DOUBLE_TAP_MS = 250;
const KEY_MS = 600;
const DRAG_THRESHOLD_PX = 6;
const REQUEST_MAX_MS = 180000; // a requested change is dropped after this long without the climate reporting it
const HISTORY_REFRESH_MS = 3600000;
const COUNTDOWN_MS = 30000;
const GLOW_DEFAULTS = { gap: 0, softness: 32, strength: 75, drag: 10, edge: 55, edge_width: 12 };
const PIP_TINT = 25;
const ICONS = { heating: "mdi:fire", idle: "mdi:thermostat", boost: "mdi:fire-alert", off: "mdi:power" };
const MODE_NAMES = { auto: "Auto", heat: "Heat", cool: "Cool", heat_cool: "Heat/cool", dry: "Dry", fan_only: "Fan", off: "Off" };
const MODE_HINTS = { auto: "schedule", heat: "hold target" };

try {
  CSS.registerProperty({ name: "--ec-p", syntax: "<number>", inherits: true, initialValue: "0" });
} catch (_) {
  /* already registered */
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const px = (v) => (typeof v === "number" ? `${v}px` : v);
const setVar = (el, name, value) => (value == null ? el.style.removeProperty(name) : el.style.setProperty(name, value));
const flat = (b) => (Array.isArray(b) ? Object.assign({}, ...b) : b && typeof b === "object" ? b : {});
const num = (v) => (v == null || v === "" ? NaN : Number(v));
const hhmmss = (min) => {
  const m = Math.max(1, Math.round(min));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
};

const HEAT = "var(--ec-heating, var(--state-climate-heat-color, #ff4500))";
const IDLE = "var(--ec-idle, var(--state-climate-auto-color, #75985d))";
// The empty part of the track uses Bubble Card's button background, so it matches Bubble rows.
const TILE = "var(--es-tile, var(--bubble-main-background-color, var(--background-color-2, var(--secondary-background-color, #2a2b2f))))";
const OFF_FILL = `color-mix(in srgb, var(--secondary-text-color, #939496) 45%, ${TILE})`;

const STYLE_TARGETS = {
  card: "ha-card", header: ".head", name: ".name", status: ".sub", value: ".val", track: ".track", fill: ".active",
  empty: ".inactive", handle: ".handle", bubble: ".bubble", pip: ".pip", icon: ".pip ha-icon", band: ".range", mark: ".ghost",
  labels: ".foot", boost: ".foot .bt", menu: ".menu",
};
const STYLE_ALIASES = { size: "font-size", weight: "font-weight", colour: "color" };
// Properties that set a card-wide variable instead of a CSS rule.
const STYLE_VARS = {
  track: { height: "--es-height", radius: "--es-radius", "inner-radius": "--es-inner-radius", gap: "--es-gap",
    "handle-width": "--es-handle-width", tile: "--es-tile", heating: "--ec-heating", idle: "--ec-idle" },
  pip: { size: "--es-pip-size" },
  icon: { size: "--es-icon-size" },
};
const UNITLESS = new Set(["font-weight", "opacity", "z-index", "line-height", "flex", "flex-grow", "flex-shrink", "order"]);

// One style block ({ size: 13 } or [{ size: 13 }]) as [property, value] pairs.
const toDecls = (props, vars = {}) =>
  Object.entries(flat(props)).map(([k, v]) => {
    const name = STYLE_ALIASES[k] ?? k;
    const prop = vars[k] ?? vars[name] ?? name;
    return [prop, typeof v === "number" && !UNITLESS.has(prop) ? `${v}px` : String(v).replace(/[{};]/g, "")];
  });

const css = (decls) => decls.map(([p, v]) => `${p}: ${v};`).join(" ");

// `styles:` as CSS, plus the settings the card reads itself.
const parseStyles = (styles) => {
  const out = { css: "", transparent: false, pipBg: undefined, glow: undefined };
  if (!styles) return out;
  if (typeof styles === "string") return { ...out, css: styles };
  const rules = [];
  const host = [];
  for (const [el, props] of Object.entries(styles)) {
    if (el === "glow") {
      out.glow = props;
      continue;
    }
    if (!STYLE_TARGETS[el]) continue;
    const { ...block } = flat(props);
    if (el === "card" && ["transparent", "none"].includes(block.background)) {
      out.transparent = true;
      delete block.background;
    }
    if (el === "pip" && "background" in block) {
      out.pipBg = block.background;
      delete block.background;
    }
    const decls = toDecls(block, STYLE_VARS[el]);
    host.push(...decls.filter(([p]) => p.startsWith("--es-") || p.startsWith("--ec-")));
    const own = decls.filter(([p]) => !p.startsWith("--es-") && !p.startsWith("--ec-"));
    if (own.length) rules.push(`${STYLE_TARGETS[el]} { ${css(own)} }`);
  }
  if (host.length) rules.unshift(`:host { ${css(host)} }`);
  out.css = rules.join("\n");
  return out;
};

const CHEVRON = `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none"
  stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const CSS_TEXT = `
  :host { display: block; }
  ha-card { position: relative; padding: 12px 16px 16px; overflow: visible; --pip: var(--es-pip-size, 40px); }
  ha-card.transparent { background: none; border: none; box-shadow: none; padding: 4px 0 8px; }
  [hidden] { display: none !important; }
  .head { display: flex; align-items: center; gap: 8px; min-height: 24px; margin-bottom: 8px; min-width: 0; }
  .name { font-weight: 600; font-size: 15px; color: var(--primary-text-color); cursor: pointer; white-space: nowrap; }
  .sub { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 500; color: var(--secondary-text-color);
         white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  .val { display: inline-flex; align-items: center; margin-left: auto; white-space: nowrap; cursor: pointer;
         font-size: 14px; font-weight: 600; color: var(--primary-text-color); font-variant-numeric: tabular-nums; outline: none; }
  .val:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; border-radius: 4px; }
  .val .t.off { color: var(--secondary-text-color); }
  .val .sep { color: var(--secondary-text-color); font-weight: 500; font-size: 12.5px; margin: 0 4px; }
  .val .md { color: var(--secondary-text-color); font-weight: 500; }
  .val .arr { display: inline-grid; place-items: center; margin-left: 2px; color: var(--secondary-text-color); transition: transform 150ms; }
  .val[aria-expanded="true"] .arr { transform: rotate(180deg); }
  .pend { opacity: .55; }
  .track { --hw: var(--es-handle-width, 4px); --gap: var(--es-gap, 6px); --r: var(--es-radius, 16px); --ir: var(--es-inner-radius, 6px);
           --pc: clamp(0, var(--ec-p), 1); /* the settle overshoots slightly; keep the shape inside the track */
           position: relative; height: var(--es-height, 56px); container-type: inline-size;
           touch-action: pan-y; cursor: pointer; outline: none; user-select: none; -webkit-user-select: none;
           transition: --ec-p 420ms cubic-bezier(.3,1.4,.6,1); }
  .track.dragging { transition: none; --es-glow-lift: var(--es-glow-drag, 10%); --es-glow-blur-lift: 5px; }
  .track.off { cursor: default; }
  .seg { position: absolute; top: 0; bottom: 0; transition: background-color 250ms; }
  .active { left: 0; background: var(--es-active); border-radius: var(--r) var(--ir) var(--ir) var(--r);
            width: max(0px, calc(var(--pc) * (100% - var(--hw)) - var(--gap))); }
  .inactive { right: 0; background: var(--es-inactive); border-radius: var(--ir) var(--r) var(--r) var(--ir);
              width: max(0px, calc(100% - var(--pc) * (100% - var(--hw)) - var(--hw) - var(--gap))); }
  /* Glow: a pseudo-element set out by the gap with only an outer shadow, so the gap stays see-through. */
  .active::before { --gg: var(--es-glow-gap, 0px); content: ""; position: absolute; pointer-events: none; opacity: 0;
                    transition: opacity 250ms, box-shadow 250ms; inset: calc(-1 * var(--gg));
                    border-radius: calc(var(--r) + var(--gg)) calc(var(--ir) + var(--gg)) calc(var(--ir) + var(--gg)) calc(var(--r) + var(--gg));
                    box-shadow: 0 0 var(--es-glow-edge-w, 12px) 0 rgb(0 0 0 / var(--es-glow-edge, 55%)),
                                0 0 calc(var(--es-glow-blur, 32px) + var(--es-glow-blur-lift, 0px)) 0
                                color-mix(in srgb, var(--es-active) calc(var(--es-glow-a, 75%) + var(--es-glow-lift, 0%)), transparent); }
  .track.lit .active::before { opacity: 1; }
  .handle { position: absolute; z-index: 2; top: -6px; bottom: -6px; width: var(--hw); border-radius: 2px;
            left: calc(var(--pc) * (100% - var(--hw))); background: var(--es-handle); }
  .track:focus-visible .handle { outline: 2px solid var(--primary-color); outline-offset: 3px; }
  .stop { position: absolute; z-index: 1; right: 10px; top: 50%; width: 4px; height: 4px; margin-top: -2px; border-radius: 50%;
          background: var(--es-handle); transition: opacity 150ms; }
  .stop.hide { opacity: 0; }
  /* Icon pip at the start of the slider; the handle is drawn over it, cut by the same gap that splits the track. */
  .pip { position: absolute; z-index: 1; top: 50%; left: calc(var(--hw) + var(--gap) + 6px);
         width: var(--pip); height: var(--pip); margin-top: calc(var(--pip) / -2);
         border-radius: 50%; display: grid; place-items: center; cursor: pointer;
         background: var(--es-pip-bg); color: var(--es-pip-fg); transition: background-color 250ms, color 250ms;
         --mdc-icon-size: var(--es-icon-size, 22px);
         --hx: calc(var(--pc) * (100cqw - var(--hw)) - var(--hw) - var(--gap) - 6px);
         --cut: linear-gradient(90deg, #000 calc(var(--hx) - var(--gap)), transparent calc(var(--hx) - var(--gap)),
                transparent calc(var(--hx) + var(--hw) + var(--gap)), #000 calc(var(--hx) + var(--hw) + var(--gap)));
         -webkit-mask-image: var(--cut); mask-image: var(--cut); }
  .ticks { position: absolute; inset: 0; pointer-events: none; }
  .tick { position: absolute; z-index: 2; top: 50%; width: 4px; height: 4px; margin: -2px 0 0 -2px; border-radius: 50%;
          left: calc(var(--t) * (100% - var(--hw)) + var(--hw) / 2); background: var(--primary-text-color); opacity: .55; }
  .ghost { position: absolute; z-index: 2; top: 8px; bottom: 8px; width: 2px; border-radius: 1px; pointer-events: none;
           left: calc(var(--es-g) * (100% - var(--hw)) + 1px); background: var(--primary-text-color); opacity: .45; transition: left 420ms; }
  .range { position: absolute; z-index: 1; top: 50%; height: 6px; margin-top: -3px; border-radius: 3px; pointer-events: none;
           left: calc(var(--es-lo) * (100% - var(--hw))); width: calc((var(--es-hi) - var(--es-lo)) * (100% - var(--hw)));
           background: var(--primary-text-color); opacity: .22; }
  .bubble { position: absolute; z-index: 3; bottom: calc(100% + 10px); min-width: 40px; height: 40px; padding: 0 8px; border-radius: 20px;
            left: calc(var(--pc) * (100% - var(--hw)) + var(--hw) / 2); transform: translateX(-50%) scale(0); box-sizing: border-box;
            transform-origin: 50% 100%; display: grid; place-items: center; pointer-events: none;
            background: var(--es-active); color: #fff;
            font: 600 14px/1 var(--ha-font-family-body, inherit); font-variant-numeric: tabular-nums;
            transition: transform 150ms cubic-bezier(.2,0,0,1); }
  .bubble.show { transform: translateX(-50%) scale(1); }
  .foot { display: grid; grid-template-columns: 1fr auto 1fr; align-items: baseline; margin-top: 4px;
          font-size: 11px; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
  .foot .mx { text-align: right; }
  .foot .bt { font-size: 12px; font-weight: 500; }
  .foot .bt b { color: ${HEAT}; font-weight: 600; }
  .menu { position: absolute; z-index: 10; right: 16px; top: 36px; min-width: 176px; padding: 6px; border-radius: 16px; display: grid; gap: 2px;
          background: ${TILE}; box-shadow: 0 8px 24px rgba(0, 0, 0, .5); }
  ha-card.transparent .menu { right: 0; top: 28px; }
  .menu button { border: 0; background: none; color: var(--primary-text-color); text-align: left; padding: 8px 10px; border-radius: 10px; cursor: pointer;
                 display: flex; justify-content: space-between; gap: 12px; font: 500 13px var(--ha-font-family-body, inherit); }
  .menu button:hover, .menu button.cur { background: var(--card-background-color, #3a3b3d); }
  .menu button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  .menu button span { color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: reduce) { .track, .ghost, .bubble, .val .arr { transition: none; } }
`;

const HTML = `
  <style>${CSS_TEXT}</style>
  <style id="user"></style>
  <ha-card>
    <div class="head">
      <span class="name"></span><span class="sub"></span>
      <span class="val" role="button" tabindex="0" aria-haspopup="menu" aria-expanded="false"></span>
    </div>
    <div class="track" tabindex="0" role="slider">
      <div class="seg active"></div><div class="seg inactive"></div><div class="range" hidden></div><div class="ticks"></div>
      <div class="stop"></div><div class="pip"><ha-icon></ha-icon></div><div class="ghost" hidden></div>
      <div class="handle"></div><div class="bubble"></div>
    </div>
    <div class="foot"><span class="mn"></span><span class="bt"></span><span class="mx"></span></div>
    <div class="menu" role="menu" hidden></div>
  </ha-card>`;

class ExpressiveClimateCard extends HTMLElement {
  static getStubConfig(hass) {
    const entity = Object.keys(hass.states).find((e) => e.startsWith("climate.")) ?? "";
    return { entity };
  }

  setConfig(config) {
    if (!config.entity) throw new Error("entity is required");
    if (!config.entity.startsWith("climate.")) throw new Error("entity must be a climate entity");
    this._config = { ticks: 1, history: 24, labels: true, ...config };
    const action = (a, fallback) => (typeof a === "string" ? { action: a } : a ?? { action: fallback });
    this._actions = {
      tap: action(config.tap_action, "more-info"),
      hold: action(config.hold_action, "more-info"),
      double_tap: action(config.double_tap_action, "none"),
    };
    this._boostCfg = { minutes: 60, temperature: 21, ...flat(config.boost) };
    this._icons = { ...ICONS, ...flat(config.icons) };
    this._reasons = (config.off_reasons ?? []).filter((r) => r?.entity);
    this._style = parseStyles(config.styles);
    const g = this._style.glow;
    this._glow = config.glow === false || g === false ? null : { ...GLOW_DEFAULTS, ...flat(g) };
    this._history = null;
    this._historyKey = null;
    if (!this.shadowRoot) this._build();
    this._applyConfig();
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    const watched = [this._config.entity, this._config.temperature_entity, this._boostCfg.entity, ...this._reasons.map((r) => r.entity)]
      .map((id) => id && hass.states[id]);
    if (this._watched && watched.every((s, i) => s === this._watched[i])) return;
    this._watched = watched;
    this._stateObj = hass.states[this._config.entity];
    this._trackRequests();
    this._loadHistory();
    if (this._dragging) return;
    this._render();
  }

  getCardSize() {
    return 2;
  }

  getGridOptions() {
    // "auto" lets the content set the height; a fixed row count leaves a gap below in grids and Bubble pop-ups.
    return { columns: 12, rows: "auto", min_columns: 4 };
  }

  connectedCallback() {
    if (this._hass && this._config) this._loadHistory();
  }

  disconnectedCallback() {
    // Pop-ups and view changes detach cards; don't leave anything to fire later.
    clearTimeout(this._holdTimer);
    clearTimeout(this._tapTimer);
    clearTimeout(this._keyTimer);
    clearInterval(this._countdown);
    clearTimeout(this._historyTimer);
    this._press = this._tapTimer = this._pending = this._countdown = this._historyTimer = null;
    this._historyKey = null;
    if (this._dragging) this._end();
    this._clearRequests();
    this._closeMenu();
  }

  _build() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = HTML;
    const $ = (sel) => root.querySelector(sel);
    this._card = $("ha-card");
    this._userStyle = $("#user");
    this._nameEl = $(".name");
    this._subEl = $(".sub");
    this._valEl = $(".val");
    this._track = $(".track");
    this._bubble = $(".bubble");
    this._pip = $(".pip");
    this._icon = $(".pip ha-icon");
    this._stop = $(".stop");
    this._ticks = $(".ticks");
    this._ghost = $(".ghost");
    this._rangeEl = $(".range");
    this._foot = $(".foot");
    this._menu = $(".menu");

    this._track.addEventListener("pointerdown", (e) => this._down(e));
    this._track.addEventListener("pointermove", (e) => this._move(e));
    this._track.addEventListener("pointerup", (e) => this._up(e));
    this._track.addEventListener("pointercancel", () => this._cancel());
    this._track.addEventListener("keydown", (e) => this._key(e));
    const tap = () => this._run(this._actions.tap);
    this._nameEl.addEventListener("click", tap);
    this._valEl.addEventListener("click", () => this._toggleMenu());
    this._valEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._toggleMenu(); }
      if (e.key === "Escape") this._closeMenu();
    });
    this._menu.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      this._closeMenu();
      if (b.dataset.boost) this._setBoost(b.dataset.boost === "on");
      else this._setMode(b.dataset.mode);
    });
    this._menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { this._closeMenu(); this._valEl.focus(); }
    });
    this._outside = (e) => { if (!e.composedPath().includes(this)) this._closeMenu(); };
    // The pip sits on the track, so keep its presses from starting a drag.
    this._pip.addEventListener("pointerdown", (e) => e.stopPropagation());
    this._pip.addEventListener("click", tap);
  }

  // Everything that depends only on the config.
  _applyConfig() {
    this._card.classList.toggle("transparent", this._style.transparent);
    this._userStyle.textContent = this._style.css;
    const g = this._glow;
    setVar(this._track, "--es-glow-gap", g && px(g.gap));
    setVar(this._track, "--es-glow-blur", g && px(g.softness));
    setVar(this._track, "--es-glow-a", g && `${g.strength}%`);
    setVar(this._track, "--es-glow-drag", g && `${g.drag}%`);
    setVar(this._track, "--es-glow-edge", g && `${g.edge}%`);
    setVar(this._track, "--es-glow-edge-w", g && px(g.edge_width));
    this._ticksKey = null;
    this._closeMenu();
  }

  // ---- State helpers ----

  _range() {
    const a = this._stateObj?.attributes ?? {};
    const min = num(this._config.min ?? a.min_temp ?? 7);
    const max = num(this._config.max ?? a.max_temp ?? 35);
    const step = num(this._config.step ?? a.target_temp_step ?? 0.5) || 0.5;
    return { min, max, step };
  }

  _snapValue(v) {
    const { min, max, step } = this._r;
    return clamp(Math.round(v / step) * step, min, max);
  }

  _mode() {
    return this._req?.mode?.value ?? this._stateObj?.state;
  }

  _boosting() {
    if (this._req?.boost) return this._req.boost.value;
    return this._stateObj?.attributes.preset_mode === "boost";
  }

  _boostAvailable() {
    return !!this._hass?.services?.hive?.boost_heating_on || (this._stateObj?.attributes.preset_modes ?? []).includes("boost");
  }

  // The reported target, or the last one inside the range while it reads something odd (a thermostat
  // waking from off can report a frost-protection 7° until its next poll).
  _reportedTarget() {
    const t = num(this._stateObj?.attributes.temperature);
    const { min, max } = this._r;
    if (Number.isFinite(t) && t >= min && t <= max) {
      if (this._stateObj.state !== "off") this._lastGood = t;
      return t;
    }
    return this._lastGood ?? (Number.isFinite(t) ? clamp(t, min, max) : min);
  }

  _target() {
    return this._req?.target?.value ?? this._reportedTarget();
  }

  _roomTemp() {
    const id = this._config.temperature_entity;
    const v = id ? num(this._hass?.states[id]?.state) : num(this._stateObj?.attributes.current_temperature);
    return Number.isFinite(v) ? v : null;
  }

  // heating | idle | off: off when the mode is off, else the climate's hvac_action.
  _action() {
    if (this._mode() === "off") return "off";
    const a = this._stateObj?.attributes.hvac_action;
    if (a === "heating" || a === "preheating") return "heating";
    if (a === "off" && this._stateObj?.state === "off") return "off";
    return "idle";
  }

  _offReason() {
    for (const r of this._reasons) {
      const s = this._hass?.states[r.entity]?.state;
      if (s == null) continue;
      if ("state" in r && String(s) === String(r.state)) return r;
      if ("not_state" in r && !["unknown", "unavailable"].includes(s) && String(s) !== String(r.not_state)) return r;
    }
    return null;
  }

  // Minutes left on a boost: from the boost entity's last change, else from when this card started it.
  _boostLeft() {
    const be = this._boostCfg.entity && this._hass?.states[this._boostCfg.entity];
    const start = be?.state === "on" ? Date.parse(be.last_changed) : this._boostStartedAt;
    if (!start) return null;
    const left = Number(this._boostCfg.minutes) * 60000 - (Date.now() - start);
    return Math.max(0, Math.ceil(left / 60000));
  }

  _modes() {
    const own = this._stateObj?.attributes.hvac_modes ?? [];
    const list = this._config.modes ?? [...own, ...(this._boostAvailable() ? ["boost"] : [])];
    return list.map(String).filter((m) => m === "boost" ? this._boostAvailable() : own.length === 0 || own.includes(m));
  }

  _fmt(v) {
    const dp = (String(this._r.step).split(".")[1] ?? "").length || 1;
    return Number(v).toFixed(dp);
  }

  _deg(v) {
    return `${(Math.round(v * 10) / 10).toFixed(1)}°`;
  }

  _name() {
    return this._config.name ?? this._stateObj?.attributes.friendly_name ?? this._config.entity;
  }

  // ---- Requests held until the climate reports them ----

  _request(key, value) {
    this._req ??= {};
    clearTimeout(this._req[key]?.timer);
    const timer = setTimeout(() => {
      delete this._req[key];
      if (!this._dragging) this._render();
    }, REQUEST_MAX_MS);
    this._req[key] = { value, timer };
  }

  _trackRequests() {
    const r = this._req;
    const s = this._stateObj;
    if (!r || !s) return;
    const done = (key) => { clearTimeout(r[key].timer); delete r[key]; };
    if (r.target && Math.abs(num(s.attributes.temperature) - r.target.value) < 0.05) done("target");
    if (r.mode && s.state === r.mode.value) done("mode");
    if (r.boost && (s.attributes.preset_mode === "boost") === r.boost.value) done("boost");
  }

  _clearRequests() {
    for (const k of Object.keys(this._req ?? {})) clearTimeout(this._req[k].timer);
    this._req = null;
  }

  _pendingAny() {
    return !!this._req && Object.keys(this._req).length > 0;
  }

  // ---- 24 h band ----

  _loadHistory() {
    const hours = Number(this._config.history);
    const id = this._config.temperature_entity ?? this._config.entity;
    if (!this._hass?.callWS || !hours || !this.isConnected) return;
    const key = `${id}|${hours}`;
    if (this._historyKey === key) return;
    this._historyKey = key;
    this._fetchHistory(id, hours);
  }

  async _fetchHistory(id, hours) {
    clearTimeout(this._historyTimer);
    this._historyTimer = setTimeout(() => {
      this._historyKey = null;
      this._loadHistory();
    }, HISTORY_REFRESH_MS);
    const attr = id === this._config.entity;
    try {
      const res = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: new Date(Date.now() - hours * 3600000).toISOString(),
        entity_ids: [id],
        minimal_response: !attr,
        no_attributes: !attr,
        significant_changes_only: false,
      });
      const vals = (res?.[id] ?? []).map((e) => num(attr ? (e.a ?? e.attributes)?.current_temperature : e.s ?? e.state)).filter(Number.isFinite);
      this._history = vals.length ? { lo: Math.min(...vals), hi: Math.max(...vals) } : null;
    } catch (_) {
      this._history = null;
    }
    if (!this._dragging) this._render();
  }

  // ---- Rendering ----

  _render() {
    if (!this._track || !this._config) return;
    const s = this._stateObj;
    this._unavailable = !s || s.state === "unavailable";
    this._r = this._range();
    this._card.style.opacity = this._unavailable ? 0.5 : "";
    this._nameEl.textContent = this._name();
    this._track.setAttribute("aria-label", this._name());
    this._track.setAttribute("aria-valuemin", this._r.min);
    this._track.setAttribute("aria-valuemax", this._r.max);

    const a = this._action();
    const off = a === "off" || this._unavailable;
    this._off = off;
    const fill = off ? OFF_FILL : a === "heating" || this._boosting() ? HEAT : IDLE;
    const pb = this._style.pipBg;
    this._track.classList.toggle("off", off);
    this._track.style.setProperty("--es-active", fill);
    this._track.style.setProperty("--es-inactive", off ? TILE : `color-mix(in srgb, ${fill} 24%, ${TILE})`);
    this._track.style.setProperty("--es-handle", off ? "var(--secondary-text-color)" : fill);
    this._track.classList.toggle("lit", !!this._glow && !off && a === "heating");
    this._pip.style.setProperty("--es-pip-bg", off ? "var(--card-background-color, #3a3b3d)"
      : typeof pb === "string" ? pb : `color-mix(in srgb, ${fill} ${pb ?? PIP_TINT}%, #000)`);
    this._pip.style.setProperty("--es-pip-fg", off ? "var(--secondary-text-color)" : fill);
    const reason = a === "off" ? this._offReason() : null;
    this._icon.icon = off ? reason?.icon ?? this._icons.off : this._boosting() ? this._icons.boost : this._icons[a];

    this._renderTicks();
    this._renderBand();
    this._renderStatus(reason);
    this._renderFoot();
    this._renderValue(this._target());
  }

  _renderTicks() {
    const { min, max } = this._r;
    const every = Number(this._config.ticks);
    const key = `${min}|${max}|${every}`;
    if (key === this._ticksKey) return;
    this._ticksKey = key;
    const out = [];
    if (every > 0 && max > min) {
      for (let t = Math.floor(min / every) * every + every; t < max - 1e-9; t += every) {
        if (t <= min) continue;
        const d = document.createElement("span");
        d.className = "tick";
        d.style.setProperty("--t", (t - min) / (max - min));
        out.push(d);
      }
    }
    this._ticks.replaceChildren(...out);
  }

  _frac(v) {
    const { min, max } = this._r;
    return max > min ? clamp((v - min) / (max - min), 0, 1) : 0;
  }

  _renderBand() {
    const room = this._roomTemp();
    this._ghost.hidden = room == null;
    if (room != null) this._ghost.style.setProperty("--es-g", this._frac(room));
    const h = this._history;
    const show = !!h && Number(this._config.history) > 0;
    this._rangeEl.hidden = !show;
    if (!show) return;
    // Live readings widen the band until the next fetch.
    const lo = room != null ? Math.min(h.lo, room) : h.lo;
    const hi = room != null ? Math.max(h.hi, room) : h.hi;
    this._rangeEl.style.setProperty("--es-lo", this._frac(lo));
    this._rangeEl.style.setProperty("--es-hi", this._frac(hi));
    this._band = [lo, hi];
  }

  _renderStatus(reason) {
    const room = this._roomTemp();
    const t = room != null ? ` · ${this._deg(room)}` : "";
    let text;
    if (this._unavailable) text = "Unavailable";
    else if (this._pendingAny()) text = "Updating…";
    else if (this._action() === "off") text = `${reason?.status ?? "Off"}${t}`;
    else text = `${this._action() === "heating" ? "Heating" : "Idle"}${t}`;
    this._subEl.textContent = text;
  }

  _renderFoot() {
    const labels = this._config.labels !== false;
    this._foot.querySelector(".mn").textContent = labels ? this._deg(this._r.min) : "";
    this._foot.querySelector(".mx").textContent = labels ? this._deg(this._r.max) : "";
    const boosting = this._boosting() && !this._req?.boost;
    const left = boosting ? this._boostLeft() : null;
    const bt = this._foot.querySelector(".bt");
    // Under the track: the boost's time left, or why the climate is off.
    const why = !boosting && !this._unavailable && this._action() === "off" ? this._offReason()?.label : null;
    if (boosting) bt.innerHTML = left != null ? `Boost · <b>${left} min</b> left` : "Boost on";
    else bt.textContent = why ?? "";
    this._foot.hidden = !labels && !boosting && !why;
    // Keep the count going while a boost runs.
    if (boosting && !this._countdown) this._countdown = setInterval(() => this._renderFoot(), COUNTDOWN_MS);
    if (!boosting && this._countdown) {
      clearInterval(this._countdown);
      this._countdown = null;
    }
  }

  // The value alone; this is all that runs while dragging.
  _renderValue(v) {
    const p = (this._p = this._frac(v));
    const t = this._track;
    t.style.setProperty("--ec-p", p);
    t.setAttribute("aria-valuenow", v);
    this._stop.classList.toggle("hide", p >= 0.97);
    this._bubble.textContent = this._fmt(v);
    this._bubble.classList.toggle("show", !!this._dragging);
    if (this._unavailable) {
      this._valEl.textContent = "Unavailable";
      return;
    }
    const pendT = this._dragging || this._pending != null || !!this._req?.target;
    const pendM = !!this._req?.mode || !!this._req?.boost;
    if (this._mode() === "off") {
      this._valEl.innerHTML = `<span class="t off${pendM ? " pend" : ""}">Off</span><span class="arr">${CHEVRON}</span>`;
    } else {
      const md = this._boosting() ? "Boost" : MODE_NAMES[this._mode()] ?? this._mode();
      this._valEl.innerHTML = `<span class="t${pendT && !this._dragging ? " pend" : ""}">${this._deg(v)}</span>` +
        `<span class="sep" aria-hidden="true">·</span><span class="md${pendM ? " pend" : ""}">${md}</span><span class="arr">${CHEVRON}</span>`;
    }
    if (!this._menu.hidden) this._fillMenu();
  }

  // ---- Menu ----

  _toggleMenu() {
    if (this._unavailable) return;
    if (!this._menu.hidden) return this._closeMenu();
    this._fillMenu();
    this._menu.hidden = false;
    this._placeMenu();
    this._valEl.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", this._outside, true);
    this._menu.querySelector("button.cur, button")?.focus();
  }

  // Drop the menu from the value: its right edge under the arrow, just below the text.
  _placeMenu() {
    const card = this._card.getBoundingClientRect();
    const v = this._valEl.getBoundingClientRect();
    if (!card.width) return;
    this._menu.style.top = `${v.bottom - card.top + 4}px`;
    this._menu.style.right = `${card.right - v.right}px`;
  }

  _closeMenu() {
    if (!this._menu || this._menu.hidden) return;
    this._menu.hidden = true;
    this._valEl.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this._outside, true);
  }

  _fillMenu() {
    const boosting = this._boosting();
    const mode = this._mode();
    const b = this._boostCfg;
    this._menu.innerHTML = this._modes().map((m) => {
      if (m === "boost") {
        const left = boosting ? this._boostLeft() : null;
        return `<button type="button" role="menuitem" data-boost="${boosting ? "off" : "on"}" class="${boosting ? "cur" : ""}">` +
          `${boosting ? "Stop boost" : "Boost"}<span>${boosting ? (left != null ? `${left} min left` : "") : `${b.minutes} min · ${this._deg(Number(b.temperature))}`}</span></button>`;
      }
      return `<button type="button" role="menuitem" data-mode="${m}" class="${!boosting && mode === m ? "cur" : ""}">` +
        `${MODE_NAMES[m] ?? m}<span>${MODE_HINTS[m] ?? ""}</span></button>`;
    }).join("");
  }

  // ---- Commands ----

  _setMode(m) {
    const id = this._config.entity;
    if (this._boosting() && m !== this._mode()) this._setBoost(false, false);
    else if (this._boosting() && m === this._mode()) return this._setBoost(false);
    this._request("mode", m);
    this._hass.callService("climate", "set_hvac_mode", { entity_id: id, hvac_mode: m });
    this._render();
  }

  _setBoost(on, render = true) {
    const id = this._config.entity;
    const hive = this._hass.services?.hive;
    const b = this._boostCfg;
    this._request("boost", on);
    if (on) {
      this._boostStartedAt = Date.now();
      if (hive?.boost_heating_on) {
        this._hass.callService("hive", "boost_heating_on", { entity_id: id, time_period: hhmmss(Number(b.minutes)), temperature: Number(b.temperature) });
      } else {
        this._hass.callService("climate", "set_preset_mode", { entity_id: id, preset_mode: "boost" });
      }
    } else {
      this._boostStartedAt = null;
      if (hive?.boost_heating_off) this._hass.callService("hive", "boost_heating_off", { entity_id: id });
      else this._hass.callService("climate", "set_preset_mode", { entity_id: id, preset_mode: "none" });
    }
    if (render) this._render();
  }

  _send(v) {
    v = this._snapValue(v);
    this._request("target", v);
    this._hass.callService("climate", "set_temperature", { entity_id: this._config.entity, temperature: v });
    this._render();
  }

  // ---- Pointer and keys (as expressive-slider-card) ----

  _valueAt(clientX) {
    const r = this._rect ?? this._track.getBoundingClientRect();
    const { min, max } = this._r;
    const p = r.width ? clamp((clientX - r.left) / r.width, 0, 1) : 0;
    return this._snapValue(min + p * (max - min));
  }

  // Drag sets the value, a tap jumps to that spot, hold and double tap run their actions.
  // Nothing moves until the pointer passes DRAG_THRESHOLD_PX, so a hold or double tap never changes the value.
  _down(e) {
    if (this._unavailable || e.button > 0) return;
    this._track.setPointerCapture?.(e.pointerId);
    this._rect = this._track.getBoundingClientRect();
    this._press = { x: e.clientX };
    this._holdTimer = setTimeout(() => {
      if (this._dragging || !this._press) return;
      this._press = null;
      this._fire("haptic", "medium");
      this._run(this._actions.hold);
    }, HOLD_MS);
  }

  _move(e) {
    if (!this._press || this._off) return;
    if (!this._dragging) {
      if (Math.abs(e.clientX - this._press.x) < DRAG_THRESHOLD_PX) return;
      clearTimeout(this._holdTimer);
      this._dragging = true;
      this._track.classList.add("dragging");
    }
    this._value = this._valueAt(e.clientX);
    this._frame ??= requestAnimationFrame(() => {
      this._frame = null;
      if (this._dragging) this._renderValue(this._value);
    });
  }

  _up(e) {
    clearTimeout(this._holdTimer);
    if (!this._press) return; // the hold action already ran
    this._press = null;
    if (this._dragging) {
      this._end();
      this._send(this._value);
      return;
    }
    this._rect = null;
    if (this._off) return; // the target can't be set while off
    const v = this._valueAt(e.clientX);
    if ((this._actions.double_tap.action ?? "none") === "none") {
      this._send(v);
    } else if (this._tapTimer) {
      clearTimeout(this._tapTimer);
      this._tapTimer = null;
      this._run(this._actions.double_tap);
    } else {
      this._tapTimer = setTimeout(() => {
        this._tapTimer = null;
        this._send(v);
      }, DOUBLE_TAP_MS);
    }
  }

  _cancel() {
    // The browser took over (vertical scroll): drop the change.
    clearTimeout(this._holdTimer);
    this._press = null;
    this._end();
    this._render();
  }

  _end() {
    this._dragging = false;
    this._rect = null;
    this._track.classList.remove("dragging");
    cancelAnimationFrame(this._frame);
    this._frame = null;
  }

  _key(e) {
    if (this._unavailable || this._off) return;
    const { min, max, step } = this._r;
    const cur = this._pending ?? this._target();
    const delta = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: 1, PageDown: -1 }[e.key];
    let next = delta !== undefined ? cur + delta : e.key === "Home" ? min : e.key === "End" ? max : null;
    if (next === null) return;
    next = this._snapValue(next);
    e.preventDefault();
    this._pending = next;
    this._renderValue(next);
    clearTimeout(this._keyTimer);
    this._keyTimer = setTimeout(() => {
      this._pending = null;
      this._send(next);
    }, KEY_MS);
  }

  _run(a) {
    const entity = a.entity ?? this._config.entity;
    switch (a.action) {
      case "more-info":
        return this._fire("hass-more-info", { entityId: entity });
      case "navigate":
        if (!a.navigation_path) return;
        history.pushState(null, "", a.navigation_path);
        return window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
      case "url":
        return a.url_path && window.open(a.url_path, "_blank");
      case "perform-action":
      case "call-service": {
        const [domain, service] = (a.perform_action ?? a.service ?? "").split(".");
        if (domain && service) this._hass.callService(domain, service, a.data ?? a.service_data ?? {}, a.target);
        return;
      }
      case "fire-dom-event":
        return this._fire("ll-custom", a);
    }
  }

  _fire(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}

if (!customElements.get("expressive-climate-card")) {
  console.info(`%c EXPRESSIVE-CLIMATE-CARD %c ${VERSION} `, "background:#c97e0b;color:#fff;font-weight:600", "background:#28282a;color:#fff");
  customElements.define("expressive-climate-card", ExpressiveClimateCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "expressive-climate-card",
    name: "Expressive climate",
    description: "Thermostat card with the expressive slider's split track, a 24 h band and a mode menu",
    preview: true,
  });
}
