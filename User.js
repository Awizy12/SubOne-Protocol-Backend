const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  balance: { type: Number, default: 0 },
  walletId: { type: String }, // New field added to link the blockchain wallet
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);