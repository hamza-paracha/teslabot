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
    if (!result.vehicles.length) message("No authorized vehicles found.");
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
    const d = await api("/api/vehicle/summary");
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
status().catch((e) => {
  if (e.message !== "unauthorized") message(e);
});
