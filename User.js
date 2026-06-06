const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  balance: { type: Number, default: 0 },
  
  // Stores the high-level ID for the entire wallet set
  walletSetId: { type: String }, 
  
  // Stores the individual blockchain addresses (e.g., MATIC-AMOY, ARB-SEPOLIA)
  walletAddresses: [{
    blockchain: String,
    address: String,
    walletId: String
  }],
  
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);