# Open-source Tesla integration research

Reviewed 2026-10-18. Repository features were checked against their first-party READMEs or implementation files, and license files were retrieved through GitHub's API. No upstream source code was copied into teslabot in this change; the feature ideas below were independently implemented. Existing dependency licenses are separate from this feature comparison.

## Projects and useful features

| Project                                                                                                            | License checked                                                           | Features observed                                                                                               | Decision for teslabot                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [TeslaMate](https://github.com/teslamate-org/teslamate)                                                            | [AGPL-3.0](https://github.com/teslamate-org/teslamate/blob/main/LICENSE)  | Drive/charge logging, charge costs, battery/range dashboards, geofences, MQTT integration, multiple vehicles    | Add explicit-input charge planning now. Keep full historical analytics and telemetry as a future integration requiring real recorded data.                                                                                          |
| [MyTeslaMate MCP](https://github.com/MyTeslaMate/mcp-tesla)                                                        | [MIT](https://github.com/MyTeslaMate/mcp-tesla/blob/master/LICENSE)       | Broad Fleet API tool coverage, TeslaMate integration, skills, streaming HTTP                                    | Keep the portable skills approach; expand useful read tools. Remote authentication and historical-data integration need their own implementation and verification.                                                                  |
| [lodordev MCP TeslaMate/Fleet](https://github.com/lodordev/mcp-teslamate-fleet)                                    | [MIT](https://github.com/lodordev/mcp-teslamate-fleet/blob/main/LICENSE)  | Trip costs, charging history, efficiency by temperature, summaries, battery history, parked drain, commands     | Implement tariff-based charging estimates with supplied capacity. Defer history-dependent statistics. Its route-cost implementation uses a straight-line multiplier; retain teslabot's host-supplied actual driving routes instead. |
| [Home Assistant Tesla Fleet](https://github.com/home-assistant/core/tree/dev/homeassistant/components/tesla_fleet) | [Apache-2.0](https://github.com/home-assistant/core/blob/dev/LICENSE.md)  | Tire pressures and warning flags, door/window state, charge energy/rate, climate and vehicle sensors            | Add normalized tire/closure data, reported charge energy and a grounded attention report using existing vehicle-state data.                                                                                                         |
| [supervised-nl Fleet MCP](https://github.com/supervised-nl/tesla-fleet-mcp)                                        | [MIT](https://github.com/supervised-nl/tesla-fleet-mcp/blob/main/LICENSE) | Nearby chargers, recent alerts, firmware release notes, service data, energy-site tools, separate command proxy | Track additional read endpoints as backlog. Nearby charging requires location/privacy review; energy-site tools require separate scopes.                                                                                            |
| [scald Tesla MCP](https://github.com/scald/tesla-mcp)                                                              | [MIT](https://github.com/scald/tesla-mcp/blob/main/LICENSE)               | Vehicle discovery/refresh, wake and debug tools                                                                 | Discovery/refresh already exist. Preserve opaque identifiers and no-wake defaults; avoid exposing raw VINs through debug tools.                                                                                                     |

## Implemented from this review

- `tesla_get_readiness`: observed lock, door, window, trunk and Tesla tire-warning flags. Unknown inputs remain unknown. This is not an inspection or assurance of driving safety.
- `tesla_get_tires`: reported pressure in bar and PSI and available soft/hard warning flags. Individual pressure measurements can be older than the vehicle-state timestamp.
- `tesla_get_closures`: door/window/trunk status, without command access.
- `tesla_plan_charging`: energy, approximate duration and optional tariff cost for a target percentage. Requires caller-supplied usable capacity; no model/trim capacity is guessed. Does not change the charge limit or start charging.
- Normalized session energy added, usable battery percentage and charging range rate where returned by Tesla. Session energy is not cumulative historical consumption.
- Departure planning can include a cached vehicle-attention report without a separate live API call.

All new read endpoints reuse the normal encrypted vehicle cache and existing vehicle-data request. No broader OAuth scopes, wake calls, command endpoints, extra telemetry services or historical-data claims were introduced.

## Data-source checks and reproducibility

[Tesla's current vehicle endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints) confirm the live vehicle-data endpoint and its polling/cost warning. The [official vehicle protocol schema](https://github.com/teslamotors/vehicle-command/blob/main/pkg/protocol/protobuf/vehicle.proto) confirms closure semantics, charge energy/rate fields, tire warning concepts and pressure units in bar. Home Assistant's current Fleet integration confirms the HTTP JSON field names; these remain optional because actual vehicle/firmware support is not yet live-verified here.

Inspected Git blobs:

- Home Assistant `sensor.py`: `fa8ccaf9c974704654eccbbbe4cf1abf67b3f3a5`.
- Home Assistant `binary_sensor.py`: `b804327ba3e19fae688cc4b9cd3bb7ef7e27d63b`.
- Home Assistant `cover.py`: `8e379581570fe52fabf2fb70a9f5b80ac1b87592`.
- Tesla `vehicle.proto`: `a71bcc38fa129e8a7793c7bb1f057bcec3e6ce0d`.
- MyTeslaMate README: `9156b1d32e335cbca0da6c7a813bb7d57af8df5b`.
- lodordev `tesla.py`: `5f463c614f227e7dd5f80ed8073457cebc692348`.
- supervised-nl README: `c9471cdaabb3e7158908f0927a83df9790c9a79b`.
- scald README: `d813ba12460ad89e3e6615c231e5687454c8e848`.

## Next candidates

1. Optional TeslaMate historical-data adapter for actual drive efficiency, charging history and parked-loss reports, with explicit permissions and no database exposed publicly.
2. Fleet Telemetry ingestion for persistent measurements; requires additional infrastructure and vehicle compatibility/pairing review.
3. Nearby charger suggestions through the host's authorized maps/charging provider, including current availability only when a source actually supplies it.
4. Recent vehicle alerts and software release notes with validated response schemas, cost handling and privacy filtering.
5. Authenticated remote MCP transport for hosted agents.

Vehicle command features remain a separately authorized phase. An upstream tool exposing unlock or a boolean confirmation flag does not establish an adequate confirmation/signing implementation for teslabot.
