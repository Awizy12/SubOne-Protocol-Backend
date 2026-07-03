require('dotenv').config();
const mongoose = require('mongoose');
const Transaction = require('./models/Transaction'); // Adjust path if needed

async function clearDB() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to DB, clearing transactions...");
        
        // This command deletes ALL documents in the transactions collection
        const result = await Transaction.deleteMany({});
        console.log(`✅ Success! Deleted ${result.deletedCount} documents.`);
        
        process.exit();
    } catch (err) {
        console.error("❌ Error:", err);
        process.exit(1);
    }
}

clearDB();