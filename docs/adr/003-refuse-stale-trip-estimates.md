# 003 — Refuse stale trip estimates and never wake the car

## Context

A trip estimate could influence whether someone departs or charges first. When the car is asleep or the API is unavailable, the last known charge may be useful context but is not a dependable basis for that decision.

## Decision

Check vehicle state before requesting live data; if the car is not online, do not fetch vehicle data or wake it. Return a cached observation as stale when it is available. Withhold trip percentages unless the observation and battery section are fresh and both state of charge and reported range are usable.

## Alternatives rejected

A best-effort estimate from stale charge could be mistaken for a current recommendation, even with a warning. Automatically waking the car would change its state and add an upstream operation just to answer a question.

## Consequences

The route and reserve remain saved for a follow-up. A sleeping car can still cost one vehicle-state lookup per refresh attempt, but the planner returns an explicit refusal instead of an arrival percentage. Even a fresh estimate is not a range guarantee.

## Evidence

- [Sleeping-car demo test](https://github.com/hamza-paracha/teslabot/blob/2835d00ecfd08df826068da9a23baa13e9447314/tests/demo.test.ts#L88) asserts one vehicle-state request, no vehicle-data or wake/command requests, and no estimate.
- [Trip refusal unit test](https://github.com/hamza-paracha/teslabot/blob/2835d00ecfd08df826068da9a23baa13e9447314/tests/trips.test.ts#L117) checks distinct responses for stale data and a missing route.

## Revisit when

There is a concrete need for a separate, clearly labeled planning mode based on a driver-supplied charge assumption. It would not justify waking the car or treating the assumption as a fresh observation.
