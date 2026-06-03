const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  username: { type: String, required: true },
  sourceWalletId: { type: String, required: true },
  destinationAddress: { type: String, required: true },
  amount: { type: Number, required: true },
  blockchain: { type: String, required: true },
  circleTxId: { type: String },
  status: { type: String, enum: ['PENDING', 'SUCCESS', 'FAILED'], default: 'PENDING' },
  errorMessage: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Transaction', TransactionSchema);