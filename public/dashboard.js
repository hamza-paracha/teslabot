const $ = (id) => document.getElementById(id);
async function api(path, options = {}) {
  const r = await fetch(path, options);
  const data = await r.json();
  if (!r.ok) throw Error(data.error?.code || "request_failed");
  return data;
}
function message(error) {
  $("message").textContent = error.message || String(error);
}
async function status() {
  const s = await api("/auth/status");
  $("login").hidden = true;
  $("dashboard").hidden = false;
  $("connection").textContent = s.connected ? "Connected" : "Not connected";
  const preferences = await api("/admin/preferences");
  $("history-enabled").checked = preferences.history_enabled;
  $("battery-threshold").value = preferences.battery_change_percentage;
  $("temperature-threshold").value = preferences.temperature_change_c;
  const pairs = {
    "API credentials": s.configured ? "Configured" : "Missing",
    "Partner registration": s.partner?.verified ? "Verified" : "Unverified",
    "Vehicle selection": s.vehicle_selected ? "Selected" : "Required",
    "Virtual key": s.virtual_key,
    Location: s.location_enabled ? "Enabled" : "Disabled",
    "Fleet requests this month": String(
      s.usage.reduce((n, r) => n + r.requests, 0),
    ),
    "Estimated usage this month":
      s.usage.reduce((n, r) => n + r.estimated_usd, 0).toFixed(3) + " USD",
  };
  $("setup").replaceChildren();
  for (const [k, v] of Object.entries(pairs)) {
    const dt = document.createElement("dt"),
      dd = document.createElement("dd");
    dt.textContent = k;
    dd.textContent = v;
    $("setup").append(dt, dd);
  }
}
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = $("credential").value;
  $("credential").value = "";
  try {
    await api("/admin/session", {
      method: "POST",
      headers: { Authorization: "Bearer " + value },
    });
    await status();
  } catch (e) {
    message(e);
  }
});
$("discover").onclick = async () => {
  try {
    const result = await api("/api/vehicles");
    $("vehicles").replaceChildren();
    for (const v of result.vehicles) {
      const o = document.createElement("option");
      o.value = v.id;
      o.textContent = (v.display_name || "Tesla") + " · " + v.state;
      $("vehicles").append(o);
    }
    if (!result.vehicles.length)
      message(
        "Tesla returned no vehicles. Connect the Tesla account that shows your car in the Tesla mobile app, then grant vehicle access.",
      );
  } catch (e) {
    message(e);
  }
};
$("select").onclick = async () => {
  try {
    await api("/api/vehicle/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: $("vehicles").value }),
    });
    await status();
    message("Vehicle selected.");
  } catch (e) {
    message(e);
  }
};
$("refresh").onclick = async () => {
  const b = $("refresh");
  b.disabled = true;
  try {
    const context = await api("/api/vehicle/context");
    const d = context.observation;
    $("context").textContent = context.narrative;
    $("changes").replaceChildren();
    for (const change of context.changes) {
      const item = document.createElement("li");
      item.textContent = change.message;
      $("changes").append(item);
    }
    $("battery").textContent =
      d.battery.percentage == null ? "Unavailable" : d.battery.percentage + "%";
    $("range").textContent =
      d.battery.range_km == null
        ? "Unavailable"
        : Math.round(d.battery.range_km) + " km";
    $("charging").textContent = d.charging.state || "Unavailable";
    $("climate").textContent =
      (d.climate.interior_c ?? "—") +
      "° / " +
      (d.climate.exterior_c ?? "—") +
      "°";
    $("freshness").textContent =
      (d.data.is_stale ? "Stale observation" : "Observation") +
      " · " +
      (d.data.observed_at || "Timestamp unavailable") +
      (d.data.refresh_error ? " · " + d.data.refresh_error : "");
    $("observation").textContent = JSON.stringify(d, null, 2);
    await status();
  } catch (e) {
    message(e);
  } finally {
    b.disabled = false;
  }
};
$("disconnect").onclick = async () => {
  if (
    !confirm(
      "Delete locally stored Tesla authorization and cached vehicle data? Revoke app consent separately in your Tesla account.",
    )
  )
    return;
  try {
    await api("/auth/disconnect", { method: "POST" });
    location.reload();
  } catch (e) {
    message(e);
  }
};
$("preferences-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/admin/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        history_enabled: $("history-enabled").checked,
        battery_change_percentage: Number($("battery-threshold").value),
        temperature_change_c: Number($("temperature-threshold").value),
      }),
    });
    message("Preferences saved.");
  } catch (error) {
    message(error);
  }
});
status().catch((e) => {
  if (e.message !== "unauthorized") message(e);
});
