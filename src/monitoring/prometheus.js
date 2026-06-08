import client from "prom-client";

const SERVICE_NAME = "payments";

const register = new client.Registry();
register.setDefaultLabels({
  service: SERVICE_NAME,
  environment: process.env.METRICS_ENVIRONMENT || process.env.NODE_ENV || "development",
});
client.collectDefaultMetrics({ register });

export const httpRequestDurationMs = new client.Histogram({
  name: "http_request_duration_ms",
  help: "Duration of HTTP requests in milliseconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000],
  registers: [register],
});

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

export const apiErrorsTotal = new client.Counter({
  name: "api_errors_total",
  help: "Total API errors by code and route",
  labelNames: ["method", "route", "status_code", "code"],
  registers: [register],
});

export const socketIoConnectionsTotal = new client.Counter({
  name: "socket_io_connections_total",
  help: "Total Socket.IO client connections accepted",
  registers: [register],
});

export const socketIoDisconnectsTotal = new client.Counter({
  name: "socket_io_disconnects_total",
  help: "Total Socket.IO client disconnects",
  registers: [register],
});

export const observeHttpRequest = ({ method, route, statusCode, durationMs }) => {
  const labels = {
    method,
    route,
    status_code: String(statusCode),
  };
  httpRequestsTotal.inc(labels);
  httpRequestDurationMs.observe(labels, durationMs);
};

export const observeApiError = ({ method, route, statusCode, code }) => {
  apiErrorsTotal.inc({
    method,
    route,
    status_code: String(statusCode),
    code,
  });
};

export const getMetrics = async () => register.metrics();
export const metricsContentType = register.contentType;
