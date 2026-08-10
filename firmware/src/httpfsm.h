#pragma once
#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>

// Reusable non-blocking HTTP/1.1 GET state machine. One request at a time.
// Drives connect -> send -> wait -> read without ever blocking the main loop.
// Supports both plain (port 80, e.g. ESPHome) and TLS (port 443, e.g. the
// Netlify proxy) connections. Callers that use TLS must hold the tlslock.
class HttpFsm {
 public:
  enum Status { IDLE, BUSY, DONE, FAILED };

  // Begin a GET. Returns false if a request is already in flight or there is
  // no WiFi. When tls is true the connection uses BearSSL (insecure) to
  // <host>:<port>; extraHeader is sent verbatim on its own line (e.g.
  // "X-Periphery-Raw: 1"). The plain client is reused; a TLS client is
  // allocated on demand and freed on consume() to release its buffers.
  bool begin(const String &host, const String &url, uint16_t port = 80,
             bool tls = false, const char *extraHeader = nullptr);

  // Advance the state machine. Call every loop iteration.
  void tick();

  Status status() const { return _status; }
  bool done() const { return _status == DONE; }
  bool failed() const { return _status == FAILED; }
  bool busy() const { return _status == BUSY; }

  // Body (after HTTP headers). Valid when done(). consume() resets to IDLE.
  const String &body() const { return _body; }
  void consume() { _status = IDLE; _body = ""; _stopClient(); }

  // Timeouts (ms).
  unsigned long connectTimeout = 4000;
  unsigned long waitTimeout = 5000;
  unsigned long readTimeout = 6000;

 private:
  enum Phase { P_CONN, P_WAIT, P_READ };
  WiFiClient _plain;
  BearSSL::WiFiClientSecure *_secure = nullptr;
  Client *_client = &_plain;
  Status _status = IDLE;
  Phase _phase = P_CONN;
  String _host, _url, _body, _extra;
  uint16_t _port = 80;
  unsigned long _timer = 0;

  void _stopClient();
  void fail(const char *why);
};

// Strips HTTP headers; returns the JSON object substring ({...}) or "" .
String http_json_body(const String &raw);
