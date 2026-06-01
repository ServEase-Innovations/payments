import express from "express";
import YAML from "yamljs";
import "./src/config/config.js";
import initDB from "./src/config/initDB.js";
import engagementsRouter from "./src/routes/engagements.js";
import paymentRoutes from "./src/routes/payments.js";
import customerLeaveRoutes from "./src/routes/customerLeaves.js";
import walletRoutes from "./src/routes/walletRoutes.js";
import serviceProviderRoutes from "./src/routes/service-providers.js";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import config from "./src/config/config.js";
import engagementsServiceRouter from "./src/routes/engagementService.js";
import adminPaymentsRouter from "./src/routes/adminPayments.js";
import engagementsV2Router from "./src/routes/v2/engagementsV2.js";
import createEngagementsRouter from "./src/routes/v2/createEngagements.js";
import serviceProvidersDiscoveryV2Router from "./src/routes/v2/serviceProvidersDiscoveryV2.js";
import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";
import requestMetrics from "./src/middleware/requestMetrics.js";
import {
  getMetrics,
  metricsContentType,
  socketIoConnectionsTotal,
  socketIoDisconnectsTotal,
} from "./src/monitoring/prometheus.js";
import { logger } from "./src/utils/logger.js";
import { getPaymentsOpenApiServerUrl } from "./src/utils/swaggerServerUrl.js";
import inAppNotificationsRouter from "./src/routes/inAppNotifications.js";
import internalNotificationsRouter from "./src/routes/internalNotifications.js";
import pricingV2Router from "./src/routes/v2/pricingV2.js";
import adminPricingRouter from "./src/routes/adminPricing.js";
import couponsProxyRouter from "./src/routes/couponsProxy.js";
import { setSocketServer } from "./src/utils/socketIoRef.js";

const app = express();

if (
  process.env.TRUST_PROXY === "true" ||
  process.env.TRUST_PROXY === "1" ||
  process.env.NODE_ENV === "production"
) {
  app.set("trust proxy", 1);
}

app.use(cors());
app.use(requestMetrics);

// Create HTTP server
const server = http.createServer(app);

// Attach Socket.IO
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",               // local dev
      "https://servease-innovation.netlify.app" // your deployed frontend
    ],
    methods: ["GET", "POST"],
    credentials: true
  }
});
setSocketServer(io);

// Middleware: Make io available in routes
app.use((req, res, next) => {
  req.io = io; // 👈 attach io to request
  next();
});

// ✅ Middleware to parse JSON requests
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-app notification REST (list / read) — use query: recipientType + recipientId
app.use("/api", inAppNotificationsRouter);
app.use("/api", internalNotificationsRouter);
app.use("/api", couponsProxyRouter);

// ✅ Initialize DB
initDB();

app.get("/metrics", async (req, res, next) => {
  try {
    res.set("Content-Type", metricsContentType);
    res.end(await getMetrics());
  } catch (err) {
    next(err);
  }
});

// ---------- V2 Swagger (server URL from request or env) ----------
const swaggerOptionsV2 = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Serveaso Engagement V2 API",
      version: "2.0.0",
      description:
        "Production-grade engagement lifecycle APIs, pricing quotes (coupons & promos), and provider discovery.",
    },
  },
  apis: ["./src/routes/v2/**/*.js"],
};

const swaggerSpecV2Static = swaggerJsdoc(swaggerOptionsV2);

// ---------- V1 OpenAPI (YAML) — `servers` in file are examples; overridden at runtime ----------
const v1OpenApiFromYaml = YAML.load("./swagger/servease-api.yaml");

function buildV2SwaggerDoc(req) {
  const spec = JSON.parse(JSON.stringify(swaggerSpecV2Static));
  spec.servers = [{ url: getPaymentsOpenApiServerUrl(req) }];
  return spec;
}

function buildV1SwaggerDoc(req) {
  const spec = JSON.parse(JSON.stringify(v1OpenApiFromYaml));
  spec.servers = [{ url: getPaymentsOpenApiServerUrl(req) }];
  return spec;
}

function v2SwaggerWithDynamicServer(req, res, next) {
  req.swaggerDoc = buildV2SwaggerDoc(req);
  next();
}

function v1SwaggerWithDynamicServer(req, res, next) {
  req.swaggerDoc = buildV1SwaggerDoc(req);
  next();
}

app.use(
  "/v2/api-docs",
  v2SwaggerWithDynamicServer,
  ...swaggerUi.serve,
  swaggerUi.setup(undefined, { swaggerOptions: { persistAuthorization: true } })
);

app.use(
  "/v1/api-docs",
  v1SwaggerWithDynamicServer,
  ...swaggerUi.serve,
  swaggerUi.setup(undefined, { swaggerOptions: { persistAuthorization: true } })
);

app.use("/api/payments", paymentRoutes);

// ✅ Engagement routes
app.use("/api/engagements", engagementsRouter);
app.use("/api/customer", customerLeaveRoutes);
app.use("/api", walletRoutes);
app.use("/api/service-providers", serviceProviderRoutes);
app.use("/api/customers", engagementsRouter);
app.use("/api/engagement-service", engagementsServiceRouter);
app.use("/api/admin", adminPaymentsRouter);
app.use("/api/admin", adminPricingRouter);
/** Web and legacy clients use /api/pricing/*; same router as V2. */
app.use("/api/pricing", pricingV2Router);
app.use("/api/v2/pricing", pricingV2Router);
app.use("/api/v2/engagements", engagementsV2Router);
app.use("/api/v2/createEngagements", createEngagementsRouter);
app.use("/api/v2/service-providers", serviceProvidersDiscoveryV2Router);



io.on("connection", (socket) => {
  socketIoConnectionsTotal.inc();
  console.log("🔌 Client connected");

  socket.on("join", ({ providerId, customerId, adminTickets }) => {
    if (providerId != null && String(providerId).length > 0) {
      const p = Number(providerId);
      if (Number.isFinite(p)) {
        socket.join(`provider_${p}`);
        console.log(`✅ Provider ${p} joined provider_${p}`);
      }
    }
    if (customerId != null && String(customerId).length > 0) {
      const c = Number(customerId);
      if (Number.isFinite(c)) {
        socket.join(`customer_${c}`);
        console.log(`✅ Customer ${c} joined customer_${c}`);
      }
    }
    if (adminTickets === true || adminTickets === "true" || adminTickets === 1) {
      socket.join("admins");
      console.log("✅ Admin joined admins room (support tickets)");
    }
  });

  socket.on("disconnect", () => {
    socketIoDisconnectsTotal.inc();
    console.log("❌ Client disconnected");
  });
});





const httpPort = Number(process.env.PORT) || 4000;
server.listen(httpPort, () => {
  logger.info("payments_api_started", {
    port: httpPort,
    docsV1: "/v1/api-docs",
    docsV2: "/v2/api-docs",
    metrics: "/metrics",
  });
  console.log(`Server running on http://localhost:${httpPort}/v1/api-docs`);
});

export { io };
