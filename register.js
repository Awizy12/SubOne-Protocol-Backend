const { registerEntitySecretCiphertext } = require('@circle-fin/developer-controlled-wallets');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config();

async function run() {
    const apiKey = process.env.CIRCLE_API_KEY;
    if (!apiKey) {
        console.error("❌ Error: Please make sure your .env file has your CIRCLE_API_KEY filled out first!");
        return;
    }

    // 1. Generate a brand new 32-byte hex string (64 characters)
    const newEntitySecret = crypto.randomBytes(32).toString('hex');
    console.log(`\n🔑 Generated New Secret: ${newEntitySecret}`);

    try {
        console.log("📡 Registering secret with Circle Sandbox...");
        
        // 2. Register it using Circle's official SDK structure
        await registerEntitySecretCiphertext({
            apiKey: apiKey,
            entitySecret: newEntitySecret
        });

        // 3. Automatically append it to your existing .env file
        fs.appendFileSync('.env', `\nCIRCLE_ENTITY_SECRET=${newEntitySecret}\n`);
        
        console.log("✅ SUCCESS! Your Entity Secret has been registered with Circle.");
        console.log("🚀 It has been automatically added to your .env file.");
        console.log("⚠️ Keep a backup of this secret string somewhere safe!");

    } catch (error) {
        console.error("❌ Registration failed:", error.message);
    }
}

run();