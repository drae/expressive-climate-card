# Expressive Climate Card

A thermostat card for Home Assistant in the style of [expressive-slider-card](https://github.com/drae/expressive-slider-card):

- The slider's split track sets the target temperature. The fill is the heating colour while heating and the idle colour otherwise, with a soft glow while heating.
- A thin mark shows the room temperature, and a faint band shows the room's lowest and highest reading over the last 24 hours.
- A dot marks every degree, with the range's ends written under the track.
- The header reads `Idle · 19.2°` on the left and `18.5° · Auto ⌄` on the right. Tapping the right side opens the mode menu.
- Boost starts from the menu. While it runs, the slider sets the boost temperature and the time left shows under the track.
- When the climate is off, the header says `Paused` or `Away` and the reason shows under the track, from a list of helpers you give it, for example a door-open pause or an away mode.
- Changes stay faded until the climate reports them, since cloud thermostats can take minutes to catch up.

It is a single plain JavaScript file with no dependencies.

## Installation

Add this repository to HACS as a custom repository of type **Dashboard**, or load `expressive-climate-card.js` as a dashboard resource of type **JavaScript module**.

## Example

```yaml
type: custom:expressive-climate-card
entity: climate.thermostat
temperature_entity: sensor.thermostat_current_temperature
min: 12
max: 25
boost:
  entity: binary_sensor.thermostat_boost
  minutes: 60
  temperature: 21
off_reasons:
  - entity: input_boolean.heating_away_suspended
    state: "on"
    status: Away
    label: Heating suspended
    icon: mdi:home-export-outline
  - entity: input_text.thermostat_previous_hvac_mode
    not_state: ""
    status: Paused
    label: Door open
    icon: mdi:door-open
styles:
  card:
    background: transparent
  name:
    size: 14
    weight: 400
```

## Options

| Key | Default | Description |
| --- | --- | --- |
| `entity` | required | A `climate` entity. |
| `name` | friendly name | The name in the header. |
| `temperature_entity` | none | A sensor for the room temperature. Without it the climate's `current_temperature` is used. It's also the source of the 24 h band. A sensor makes that history lookup cheaper. |
| `min`, `max` | `min_temp`, `max_temp` | The slider's range. |
| `step` | `target_temp_step`, else `0.5` | The target's step. |
| `ticks` | `1` | A dot every this many degrees. `false` for none. |
| `history` | `24` | Hours of room temperature behind the band. It's fetched from the recorder once, then hourly, and widened by live readings. `false` for no band. |
| `labels` | `true` | The range's ends under the track. |
| `modes` | the climate's `hvac_modes`, plus `boost` | What the menu offers, in order. `boost` only appears when the climate can boost. |
| `boost` | | `minutes` (default `60`) and `temperature` (default `21`) for a boost started from the menu. `entity` is an optional binary sensor that is on during a boost. Its last change times the countdown. |
| `off_reasons` | none | While the climate is off, the first entry that matches says why. Each entry takes `entity`, `state` or `not_state`, `status` (the header word in place of `Off`), `label` (shown centred under the track, where the boost's time left goes) and `icon`. |
| `icons` | | Icons for the pip: `heating` (`mdi:fire`), `idle` (`mdi:thermometer`), `boost` (`mdi:fire-alert`) and `off` (`mdi:power`). |
| `glow` | `true` | The glow round the fill while heating. Its look is set under `styles: glow:`. |
| `menu_items` | none | Extra rows at the foot of the mode menu, under a separator line. Each takes `name`, optional `info` (grey text on the right) and `tap_action`, for example `navigate` to `#heating-schedule` to open a schedule pop-up. |
| `tap_action` | `more-info` | Tapping the name or the pip. |
| `hold_action` | `more-info` | Holding the pip. Holding the slider does nothing, so a press that misses a drag never opens a dialog or moves the target. |
| `double_tap_action` | `none` | Double tapping the slider. When set, a single tap waits 250 ms before setting the value. |
| `styles` | | See [Styles](#styles). |

## Behaviour

- **Target:** a drag sends `climate.set_temperature` when you let go, and a tap on the track jumps there. Arrow keys step, then send 600 ms after the last press. Nothing can be set while off.
- **Waiting for the thermostat:** a requested target or mode stays faded, with `Updating…` in the status, until the climate reports it or 3 minutes pass. Some thermostats report a frost-protection target (such as 7°) for a poll or two after waking from off. A target outside the range is ignored and the last good one stays. A card that loads during such a reading looks back up to 48 hours in the recorder for the last good target, and shows `–` if it finds none.
- **Modes:** the menu calls `climate.set_hvac_mode`. Picking a mode during a boost ends the boost first.
- **Boost:** with the Hive integration loaded, boost calls `hive.boost_heating_on` with `time_period` and `temperature`, and `hive.boost_heating_off` to stop. Otherwise it uses the climate's `boost` preset. A boost is running while `preset_mode` is `boost`.

## Styles

`card: background: transparent` (or `none`) drops the card's background, border and shadow and tightens its padding to `4px 0 8px`, for stacking inside another card. A `padding` in the same block still applies.

Each block styles one element, and the keys are CSS properties. `size`, `weight` and `colour` are short for `font-size`, `font-weight` and `color`, and bare numbers become px. This is the same scheme as expressive-slider-card.

Elements: `card`, `header`, `name`, `status`, `value`, `track`, `fill`, `empty`, `handle`, `bubble`, `pip`, `icon`, `band`, `mark` (the room temperature), `labels`, `boost` (the time left), `menu` and `glow`.

- **`track`** also takes `height`, `radius`, `inner-radius`, `gap`, `handle-width`, `tile` (the colour the empty part is mixed from), `heating` and `idle` (the fill colours).
- **`pip`** takes `size`, and `background`: a number is the % of the fill colour mixed with black (default `80`, as the slider), anything else is a fixed colour.
- **`glow`** takes `gap`, `softness`, `strength`, `edge`, `edge_width` and `drag`.

## Licence

BSD 3-Clause. See [LICENSE](LICENSE).
