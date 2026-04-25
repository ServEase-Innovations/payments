import { observeHttpRequest } from "../monitoring/prometheus.js";

const requestMetrics = (req, res, next) => {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    observeHttpRequest({
      method: req.method,
      route: req.route?.path || req.path || req.originalUrl,
      statusCode: res.statusCode,
      durationMs,
    });
  });

  next();
};

export default requestMetrics;
