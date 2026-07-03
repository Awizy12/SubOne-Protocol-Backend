const dns = require('node:dns/promises');
dns.setServers(['1.1.1.1', '1.0.0.1']);

require('dotenv').config();
const mongoose = require('mongoose');

console.log("Attempting to connect to MongoDB...");

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ Connection Successful!");
    process.exit(0);
  })
  .catch(err => {
    console.error("❌ Connection Failed:", err.message);
    process.exit(1);
  });