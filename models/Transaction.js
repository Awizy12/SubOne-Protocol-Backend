const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  username: { type: String, required: true },
  sourceWalletId: { type: String, required: true },
  destinationAddress: { type: String, required: true },
  amount: { type: Number, required: true },
  blockchain: { type: String, required: true },
  
  // Internal tracking ID from Circle
  circleTxId: { type: String },
  
  // The official blockchain transaction hash (e.g., 0x...)
  txHash: { type: String },
  
  // Updated with full status lifecycle support
  status: {
    type: String,
    enum: [
      'INITIATED', 
      'QUEUED', 
      'CLEARED', 
      'SENT', 
      'CONFIRMED', 
      'COMPLETE', 
      'FAILED', 
      'DENIED', 
      'CANCELLED', 
      'STUCK'
    ],
    default: 'INITIATED'
  }, 
  errorMessage: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Transaction', TransactionSchema);