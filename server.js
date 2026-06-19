const express = require("express");
const cors    = require("cors");
require("dotenv").config();

const authRoutes       = require("./routes/auth");
const connectionRoutes = require("./routes/connections");

const app  = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());

// Routes
app.use("/auth",        authRoutes);
app.use("/connections", connectionRoutes);

// Test route — open http://localhost:5000 to check
app.get("/", (req, res) => {
  res.json({ message: "Twin backend is running! ✅" });
});

app.listen(PORT, () => {
  console.log(`✅ Twin backend running on http://localhost:${PORT}`);
});