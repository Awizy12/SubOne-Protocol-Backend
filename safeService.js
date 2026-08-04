const { Safe } = require('@safe-global/protocol-kit');
const { ethers } = require('ethers');

/**
 * Initializes and predicts a deterministic Safe deployment address for a user.
 * @param {string} rpcUrl - The blockchain network RPC URL.
 * @param {string[]} owners - Array of owner wallet addresses.
 * @param {number} threshold - Number of required signatures (e.g., 2).
 */
async function getPredictedSafeAddress(rpcUrl, owners, threshold) {
    try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        
        // Safe deployment configuration protocol payload
        const safeAccountConfig = {
            owners: owners,
            threshold: threshold,
        };

        // Initialize Protocol Kit with predicted configuration
        const protocolKit = await Safe.init({
            provider: rpcUrl,
            safeAccountConfig: safeAccountConfig
        });

        const predictedAddress = await protocolKit.getAddress();
        console.log(`🛡️ Predicted Safe Address: ${predictedAddress}`);
        
        return {
            success: true,
            predictedAddress,
            protocolKit
        };
    } catch (error) {
        console.error("❌ Error predicting Safe address:", error.message);
        return { success: false, error: error.message };
    }
}

module.exports = { getPredictedSafeAddress };