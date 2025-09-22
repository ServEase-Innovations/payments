import express from "express";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import dotenv from "dotenv";
import initDB from "./src/config/initDB.js";
import engagementsRouter from "./src/routes/engagements.js";
import paymentRoutes from "./src/routes/payments.js";
import customerLeaveRoutes from "./src/routes/customerLeaves.js";
import walletRoutes from "./src/routes/walletRoutes.js";
import serviceProviderRoutes from "./src/routes/service-providers.js";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";



const app = express();

app.use(cors());

dotenv.config();

// Create HTTP server
const server = http.createServer(app);

// Attach Socket.IO
const io = new Server(server, {
  cors: {
    origin: "*", // ⚠️ allow all for now, lock down in production
    methods: ["GET", "POST"]
  }
});

// Middleware: Make io available in routes
app.use((req, res, next) => {
  req.io = io; // 👈 attach io to request
  next();
});

// ✅ Middleware to parse JSON requests
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ Initialize DB
initDB();

// ✅ Load Swagger
const swaggerDocument = YAML.load("./swagger/servease-api.yaml");
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.use("/api/payments", paymentRoutes);

// ✅ Engagement routes
app.use("/api/engagements", engagementsRouter);
app.use("/api/customer", customerLeaveRoutes);
app.use("/api", walletRoutes);
app.use("/api/service-providers", serviceProviderRoutes);
app.use("/api/customers", engagementsRouter);



io.on("connection", (socket) => {
  console.log("🔌 Client connected");

  socket.on("join", ({ providerId }) => {
    if (providerId) {
      socket.join(`provider_${providerId}`);
      console.log(`✅ Provider ${providerId} joined provider_${providerId}`);
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected");
  });
});





server.listen(5000, () =>
  console.log("Server running on http://localhost:5000/api-docs")
);

export { io };
