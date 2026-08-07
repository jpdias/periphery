#include "logbuf.h"
#include "netproxy.h"
#include "config.h"

static char gHost[128] = {0};

bool proxy_enabled() {
  return cfg.use_api_proxy && cfg.api_base[0] && proxy_host()[0];
}

// Extract the host (no scheme, no path) from cfg.api_base into a static buffer.
// Accepts "https://host/path", "host/path" or bare "host". Returns "" if empty.
const char* proxy_host() {
  if (!cfg.api_base[0]) { gHost[0] = 0; return gHost; }
  const char* src = cfg.api_base;
  if (strncmp(src, "https://", 8) == 0) src += 8;
  else if (strncmp(src, "http://", 7) == 0) src += 7;
  const char* slash = strchr(src, '/');
  size_t len = slash ? (size_t)(slash - src) : strlen(src);
  if (len >= sizeof(gHost)) len = sizeof(gHost) - 1;
  memcpy(gHost, src, len);
  gHost[len] = 0;
  // Trim any trailing port for display; connection always uses 443.
  char* colon = strchr(gHost, ':');
  if (colon) *colon = 0;
  return gHost;
}

String proxy_path(const char* widget, const String &query) {
  String p = String("/api/") + widget;
  if (query.length()) p += "?" + query;
  return p;
}
