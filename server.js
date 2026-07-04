const express = require("express");
const cors    = require("cors");
require("dotenv").config();

const pool             = require("./db");
const authRoutes       = require("./routes/auth");
const connectionRoutes = require("./routes/connections");
const multistreamRoutes = require("./routes/multistream");

const app  = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());

// Routes
app.use("/auth",        authRoutes);
app.use("/connections", connectionRoutes);
app.use("/multistream", multistreamRoutes);


// Test route — open http://localhost:5000 to check
app.get("/", (req, res) => {
  res.json({ message: "Twin backend is running! ✅" });
});

app.listen(PORT, () => {
  console.log(`✅ Twin backend running on http://localhost:${PORT}`);
});