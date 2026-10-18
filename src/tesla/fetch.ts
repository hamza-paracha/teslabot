// Workers supports follow/manual, but rejects the standard "error" redirect mode.
// Preserve error-mode safety explicitly while keeping the native fetch receiver.
export const platformFetch: typeof fetch = async (input, init) => {
  const requestedRedirect =
    init?.redirect ?? (input instanceof Request ? input.redirect : undefined);
  const response = await globalThis.fetch(
    input,
    requestedRedirect === "error" ? { ...init, redirect: "manual" } : init,
  );
  if (
    requestedRedirect === "error" &&
    response.status >= 300 &&
    response.status < 400
  ) {
    await response.body?.cancel();
    throw new TypeError("upstream_redirect_refused");
  }
  return response;
};
