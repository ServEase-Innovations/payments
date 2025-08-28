import express from "express";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import dotenv from "dotenv";
import initDB from "./src/config/initDB.js";
import engagementsRouter from "./src/routes/engagements.js";
import paymentRoutes from "./src/routes/payments.js";
import customerLeaveRoutes from "./src/routes/customerLeaves.js";
import walletRoutes from "./src/routes/walletRoutes.js";



const app = express();

dotenv.config();

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

app.listen(5000, () =>
  console.log("Server running on http://localhost:5000/api-docs")
);
