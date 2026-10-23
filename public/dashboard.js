const $ = (id) => document.getElementById(id);
let connection = null;
let busy = false;

async function api(path, options = {}) {
  let r, data;
  try {
    r = await fetch(path, { ...options, redirect: "error" });
    data = await r.json();
  } catch {
    throw Error(
      "The service could not be reached. Check your connection and try again.",
    );
  }
  if (!r.ok) {
    const error = Error(
      data.error?.message ||
        "The request could not be completed (" +
          (data.error?.code || "request_failed") +
          ").",
    );
    error.code = data.error?.code;
    error.nextSteps = data.error?.next_steps;
    throw error;
  }
  return data;
}

function message(value) {
  $("message").textContent =
    typeof value === "string"
      ? value
      : [value.message, ...(value.nextSteps || [])].join("\n");
  if (value.code === "unauthorized") {
    connection = null;
    $("login").hidden = false;
    $("dashboard").hidden = true;
    resetObservation();
  }
}

function controls() {
  const connected = !!connection?.connected;
  $("connect").hidden = connected;
  $("reconnect").hidden = !connected;
  $("connect").disabled = busy || !connection?.configured;
  $("reconnect").disabled = busy;
  $("disconnect").disabled = busy || !connected;
  $("discover").disabled = busy || !connected;
  $("vehicles").disabled =
    busy || !connected || !connection?.vehicle_access.vehicles.length;
  $("select").disabled = busy || !connected || !$("vehicles").value;
  $("refresh").disabled = busy || !connected || !connection?.vehicle_selected;
}

function resetObservation() {
  for (const id of ["battery", "range", "charging", "climate"])
    $(id).textContent = "—";
  $("context").textContent =
    "Select a vehicle, then refresh for a grounded summary.";
  $("changes").replaceChildren();
  $("freshness").textContent =
    "No vehicle data has been retrieved for this selection.";
  $("observation").textContent = "";
}

function renderAccess(s) {
  const access = s.vehicle_access;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = !s.connected
    ? "Connect Tesla Account first"
    : access.status === "no_authorized_vehicles"
      ? "No authorized vehicles returned"
      : access.vehicles.length
        ? "Choose a vehicle, then click Select vehicle"
        : "Load authorized vehicles first";
  $("vehicles").replaceChildren(placeholder);
  for (const v of access.vehicles) {
    const option = document.createElement("option");
    option.value = v.id;
    option.textContent =
      (v.display_name || "Tesla") + " · " + v.state + " · " + v.id.slice(0, 8);
    $("vehicles").append(option);
  }
  $("vehicles").value = access.selected_id || "";
  $("discover").textContent = access.data.observed_at
    ? "Reload vehicles"
    : "Load vehicles";
  $("vehicle-guidance").textContent = !s.connected
    ? "Connect the Tesla account that shows your car in the official Tesla app."
    : s.authorization.vehicle_information === "missing"
      ? "Tesla's grant is missing Vehicle Information permission. Reconnect and approve access to the intended vehicle."
      : access.status === "ready"
        ? "Vehicle selected. Request a reading with Refresh Vehicle Data or your agent's battery tool."
        : [
            access.guidance?.message,
            ...(access.guidance?.next_steps || []),
          ].join(" ");
  $("vehicle-check").textContent = access.data.observed_at
    ? "Vehicle list checked " +
      access.data.observed_at +
      (access.data.is_stale
        ? " · Stored list is older than five minutes; reload to check access."
        : " · Reload vehicles checks Tesla again.")
    : "Loading vehicles reads account metadata; it does not request a live battery reading or wake the car.";
}

async function status() {
  const s = await api("/auth/status");
  if (
    connection?.vehicle_access.selected_id !== s.vehicle_access.selected_id ||
    !s.connected
  )
    resetObservation();
  connection = s;
  $("login").hidden = true;
  $("dashboard").hidden = false;
  $("connection").textContent = s.connected
    ? "Account connected"
    : "Not connected";
  const pairs = {
    "API credentials": s.configured ? "Configured" : "Missing",
    "Partner registration": s.partner?.verified ? "Verified" : "Unverified",
    "Vehicle Information permission":
      s.authorization.vehicle_information === "unknown"
        ? "Not reported by Tesla"
        : s.authorization.vehicle_information,
    "Vehicle selection": s.vehicle_selected ? "Selected" : "Required",
    "Vehicle commands": "Disabled",
    "Virtual key": "Disabled in this phase",
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
  renderAccess(s);
  controls();
}

async function preferences() {
  const p = await api("/admin/preferences");
  $("history-enabled").checked = p.history_enabled;
  $("battery-threshold").value = p.battery_change_percentage;
  $("temperature-threshold").value = p.temperature_change_c;
}

async function action(task) {
  if (busy) return;
  busy = true;
  controls();
  message("");
  try {
    await task();
  } catch (error) {
    message(error);
  } finally {
    busy = false;
    controls();
  }
}

$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("credential").value;
  $("credential").value = "";
  return action(async () => {
    await api("/admin/session", {
      method: "POST",
      headers: { Authorization: "Bearer " + value },
    });
    await status();
    await preferences();
  });
});
$("connect").onclick = () => location.assign("/auth/login");
$("reconnect").onclick = () => {
  if (
    !confirm(
      "Sign in to Tesla again? Your current connection stays until sign-in succeeds. Successful reconnection clears the previous vehicle selection and stored observations; select the intended car again.",
    )
  )
    return;
  return action(async () => {
    const result = await api("/auth/reconnect", { method: "POST" });
    location.assign(result.authorization_url);
  });
};

async function discover() {
  const result = await api("/api/vehicles?refresh=true");
  await status();
  message(
    result.vehicles.length
      ? "Authorized vehicles loaded. Choose the correct car and click Select vehicle; no battery read has been made."
      : [result.guidance.message, ...result.guidance.next_steps].join("\n"),
  );
}
$("discover").onclick = () => action(discover);
$("vehicles").onchange = controls;
$("select").onclick = () =>
  action(async () => {
    if (!$("vehicles").value) return;
    await api("/api/vehicle/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: $("vehicles").value }),
    });
    resetObservation();
    await status();
    message(
      "Vehicle selected. You can now request battery data in the dashboard or through your agent.",
    );
  });
$("refresh").onclick = () =>
  action(async () => {
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
      (d.data.cache_hit ? " · From cache" : " · Requested from Tesla") +
      (d.data.refresh_error
        ? " · Refresh could not complete (" + d.data.refresh_error + ")."
        : "");
    $("observation").textContent = JSON.stringify(d, null, 2);
    await status();
  });
$("disconnect").onclick = () => {
  if (
    !confirm(
      "Delete locally stored Tesla authorization and cached vehicle data? Revoke app consent separately in your Tesla account.",
    )
  )
    return;
  return action(async () => {
    await api("/auth/disconnect", { method: "POST" });
    location.reload();
  });
};
$("preferences-form").addEventListener("submit", (event) => {
  event.preventDefault();
  return action(async () => {
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
  });
});

const oauthMessages = {
  invalid_oauth_state:
    "Tesla sign-in could not be matched to this browser. Start again from this dashboard in the same browser.",
  expired_or_replayed_state:
    "Tesla sign-in expired or was already used. Start again and finish within ten minutes.",
  oauth_consent_denied:
    "Tesla access was not approved. Any previous connection is unchanged. Connect or reconnect when ready.",
  missing_authorization_code:
    "Tesla did not return a sign-in code. Start again from this dashboard.",
  disconnect_before_reconnecting:
    "An account is already connected. Use Reconnect Tesla Account to sign in again.",
  unauthorized: "Open an administrator session below before connecting Tesla.",
};
async function start() {
  const url = new URL(location.href);
  const error = url.searchParams.get("oauth_error");
  const connected = url.searchParams.get("oauth") === "connected";
  if (error || connected) {
    url.searchParams.delete("oauth_error");
    url.searchParams.delete("oauth");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  try {
    await status();
    await preferences();
    // One metadata discovery after owner consent; never a live data read or poll.
    if (connected && connection.connected) await action(discover);
  } catch (e) {
    if (e.code !== "unauthorized") message(e);
  }
  if (error)
    message(
      oauthMessages[error] ||
        "Tesla sign-in could not complete. Open the dashboard to check the connection and start a new attempt; if it repeats, ask the operator to check OAuth configuration.",
    );
}
start();
