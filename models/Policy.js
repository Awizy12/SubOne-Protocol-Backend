// models/Policy.js
const mongoose = require('mongoose');

const policySchema = new mongoose.Schema({
    policyName: String,
    min_threshold: Number,
    max_transfer_limit: Number
});

// The third argument 'policies' forces Mongoose to use the exact collection name
module.exports = mongoose.model('Policy', policySchema, 'policies');