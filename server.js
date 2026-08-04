// 1. DNS CONFIGURATION - MUST BE AT THE TOP
const dns = require('node:dns/promises');
dns.setServers(['1.1.1.1', '1.0.0.1']);

// 2. DEPENDENCIES
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { initiateDeveloperControlledWalletsClient } = require('@circle-fin/developer-controlled-wallets');
const http = require('http'); 
const { Server } = require('socket.io'); 

const User = require('./User');
const Transaction = require('./models/Transaction');
const Policy = require('./models/Policy'); 
const { getPredictedSafeAddress } = require('./safeService');

// 3. UTILITIES & CONFIG
const isValidEVMAddress = (address) => /^0x[a-fA-F0-9]{40}$/.test(address);

const NETWORK_MAP = {
    'polygon': 'MATIC-AMOY',
    'arbitrum': 'ARB-SEPOLIA',
    'base': 'BASE-SEPOLIA',
    'avalanche': 'AVAX-FUJI',
    'arc': 'ARC-TESTNET'
};

const USDC_ADDRESS_MAP = {
    'MATIC-AMOY': process.env.USDC_POLYGON_AMOY || '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
    'ARC-TESTNET': process.env.USDC_ARC_TESTNET || '0x3600000000000000000000000000000000000000',
    'ARB-SEPOLIA': process.env.USDC_ARB_SEPOLIA || '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    'BASE-SEPOLIA': process.env.USDC_BASE_SEPOLIA || '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
};

function getUsdcAddress(blockchain) {
    const address = USDC_ADDRESS_MAP[blockchain];
    if (!address) throw new Error(`Unsupported blockchain for USDC: ${blockchain}`);
    return address;
}

const TREASURY_CONTRACT_ADDRESS = process.env.TREASURY_CONTRACT_ADDRESS || '0x22624036d28F96eE2e281822399790E617097241';
const MINIMUM_SUBSCRIPTION_COST = 10;

const app = express();
const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling'], 
    pingTimeout: 60000,
    pingInterval: 25000
});

io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);
    socket.on('disconnect', (reason) => {
        console.log(`🔌 Client disconnected: ${socket.id} (Reason: ${reason})`);
    });
});

// 4. DATABASE CONNECTION
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to Database'))
  .catch((err) => { console.error('❌ DB Connection Error:', err.message); process.exit(1); });

mongoose.connection.once('open', async () => {
    try {
        const db = mongoose.connection.db;
        const collections = await db.listCollections().toArray();
        console.log("DEBUG: Connected to Database Name:", db.databaseName);
        console.log("DEBUG: Collections found in this DB:", collections.map(c => c.name));
    } catch (err) {
        console.error("DEBUG: Failed to list collections:", err.message);
    }
});
mongoose.connection.once('open', async () => {
    const Policy = require('./models/Policy');
    const doc = await Policy.findOne({});
    console.log("DEBUG: Testing Policy document lookup:", doc);
});

app.set('json spaces', 2);
app.use(cors());
app.use(express.json());

const circleClient = initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET
});

// ==========================================
// 2. USER AUTH
// ==========================================
app.post('/api/circle-session', async (req, res) => {
  try {
    const { userId } = req.body;
    let user = await User.findOne({ username: userId });
    if (!user) { user = new User({ username: userId }); await user.save(); }

    await axios.post('https://api.circle.com/v1/w3s/users', { userId }, {
      headers: { 'Authorization': `Bearer ${process.env.CIRCLE_API_KEY}`, 'Content-Type': 'application/json' }
    }).catch(err => { if (err.response && err.response.status !== 409) throw err; });

    const sessionResponse = await axios.post('https://api.circle.com/v1/w3s/users/token', { userId }, {
      headers: { 'Authorization': `Bearer ${process.env.CIRCLE_API_KEY}`, 'Content-Type': 'application/json' }
    });
    res.json({ success: true, ...sessionResponse.data.data, dbUser: user });
  } catch (error) { res.status(500).json({ success: false, error: "Failed to process session" }); }
});

// ==========================================
// 3. PERSISTENT WALLET OPERATIONS
// ==========================================
app.get('/api/list-wallets', async (req, res) => {
    try {
        const response = await circleClient.listWallets();
        const allWallets = response.data.wallets || [];
        const uniqueWallets = allWallets.reduce((acc, current) => {
            if (!acc.find(item => item.blockchain === current.blockchain)) acc.push(current);
            return acc;
        }, []);
        res.status(200).json(uniqueWallets);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/create-wallet', async (req, res) => {
    try {
        const username = 'subone_test_user_01';
        let user = await User.findOne({ username });
        if (!user) { user = new User({ username }); await user.save(); }

        if (user.walletSetId && user.walletAddresses?.length > 0) {
            return res.status(200).json({ message: "Using existing wallet set", walletSetId: user.walletSetId, wallets: user.walletAddresses });
        }

        const setResponse = await circleClient.createWalletSet({ idempotencyKey: crypto.randomUUID(), name: "SubOne Phase 3 Set" });
        const walletSetId = setResponse.data.walletSet.id;
        
        const walletResponse = await circleClient.createWallets({
            idempotencyKey: crypto.randomUUID(),
            blockchains: ['ARC-TESTNET', 'MATIC-AMOY', 'ARB-SEPOLIA', 'BASE-SEPOLIA'],
            accountType: 'SCA',
            count: 1,
            walletSetId: walletSetId
        });

        const newAddresses = walletResponse.data.wallets.map(w => ({
            blockchain: w.blockchain,
            address: w.address,
            walletId: w.id
        }));

        user.walletSetId = walletSetId;
        user.walletAddresses = newAddresses;
        await user.save();
        res.status(200).json({ message: "New wallets created!", wallets: newAddresses });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/create-arc-wallet', async (req, res) => {
    try {
        const username = 'subone_test_user_01';
        let user = await User.findOne({ username });
        if (!user || !user.walletSetId) {
            return res.status(400).json({ error: "User or existing wallet set not found. Initialize regular wallet first." });
        }

        const existingArc = user.walletAddresses.find(w => w.blockchain === 'ARC-TESTNET');
        if (existingArc) {
            return res.status(200).json({ message: "Arc wallet already exists", wallet: existingArc });
        }

        const walletResponse = await circleClient.createWallets({
            idempotencyKey: crypto.randomUUID(),
            blockchains: ['ARC-TESTNET'],
            accountType: 'SCA',
            count: 1,
            walletSetId: user.walletSetId
        });

        const newWallet = walletResponse.data.wallets[0];
        const walletEntry = {
            blockchain: newWallet.blockchain,
            address: newWallet.address,
            walletId: newWallet.id
        };

        user.walletAddresses.push(walletEntry);
        await user.save();

        res.status(200).json({ success: true, message: "Arc Testnet wallet created!", wallet: walletEntry });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/user-profile/:username', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.params.username });
        if (!user) return res.status(404).json({ success: false });
        res.status(200).json({ success: true, user });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==========================================
// 4. CORE PROTOCOL AUTOMATION & GUARDRAILS
// ==========================================
app.get('/api/wallet-balances', async (req, res) => {
    try {
        const response = await circleClient.getWalletTokenBalance({ id: req.query.walletId });
        res.status(200).json({ success: true, balances: response.data.tokenBalances || [] });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/total-balance', async (req, res) => {
  try {
    const response = await circleClient.listWallets();
    const wallets = response.data.wallets || [];
    const balancePromises = wallets.map(async (wallet) => {
      try {
        const balData = await circleClient.getWalletTokenBalance({ id: wallet.id });
        const usdc = balData.data.tokenBalances?.find(b => b.token?.symbol === 'USDC');
        return parseFloat(usdc?.amount || 0);
      } catch (e) { return 0; }
    });
    const results = await Promise.all(balancePromises);
    const totalBalance = results.reduce((acc, bal) => acc + bal, 0);
    res.json({ success: true, totalBalance: totalBalance.toFixed(2) });
  } catch (err) { res.status(500).json({ success: false, error: 'Aggregation failed' }); }
});

app.post('/api/execute-transaction', async (req, res) => {
    const { amount, walletId, network, abiFunctionSignature, abiParameters } = req.body;
    
    if (!amount || !walletId || !network || !abiFunctionSignature || !abiParameters) {
        return res.status(400).json({ error: "Missing required parameters (amount, walletId, network, abiFunctionSignature, abiParameters)" });
    }
    
    const circleNetwork = NETWORK_MAP[network.toLowerCase()] || network;
    const requestedAmount = parseFloat(amount);

    // --- SUBSCRIPTION REQUIREMENT CHECK ---
    const sig = abiFunctionSignature.toLowerCase();
    if ((sig.includes('subscribe') || sig.includes('deposit')) && requestedAmount < MINIMUM_SUBSCRIPTION_COST) {
        console.log(`🚫 REJECTED: Requested amount ${requestedAmount} USDC is below the minimum allowed cost of ${MINIMUM_SUBSCRIPTION_COST} USDC.`);
        return res.status(400).json({ 
            success: false, 
            error: `Transaction Rejected: Amount must be at least ${MINIMUM_SUBSCRIPTION_COST} USDC.` 
        });
    }

    try {
        const balanceCheck = await circleClient.getWalletTokenBalance({ id: walletId });
        const targetTokenRecord = (balanceCheck.data?.tokenBalances || []).find(t => t.token?.symbol === 'USDC');
        if (!targetTokenRecord) throw new Error("NO_USDC_TOKEN_FOUND");
        
        const currentBalance = parseFloat(targetTokenRecord.amount);

        // --- STRICT GUARDRAIL CHECK ---
        const policy = await Policy.findOne({ policyName: "GLOBAL_TREASURY_POLICY" });
        
        if (!policy) {
            console.error("❌ GUARDRAIL ERROR: Policy document missing in MongoDB!");
            return res.status(500).json({ error: "System Policy not configured." });
        }

        const minThreshold = parseFloat(policy.min_threshold);
        const maxLimit = parseFloat(policy.max_transfer_limit);

        console.log(`DEBUG: Balance: ${currentBalance}, Req: ${requestedAmount}, Min: ${minThreshold}, Max: ${maxLimit}`);

        // Check 1: Min Threshold
        if ((currentBalance - requestedAmount) < minThreshold) {
            console.log("🚫 GUARDRAIL TRIGGERED: Breaching safety floor");
            return res.status(403).json({ error: "Policy Violation: Transaction would breach safety floor." });
        }

        // Check 2: Max Transfer Limit
        if (requestedAmount > maxLimit) {
            console.log("🚫 GUARDRAIL TRIGGERED: Exceeding transfer limit");
            return res.status(403).json({ error: "Policy Violation: Amount exceeds transfer limit." });
        }
        // --- END GUARDRAIL ---

        // Dynamically compute the correct 6-decimal integer string directly from the user's requested amount
        const scaledTokenAmount = Math.floor(requestedAmount * 1000000).toString();
        
        let parsedAbiParameters = Array.isArray(abiParameters) 
            ? [...abiParameters] 
            : String(abiParameters).split(',').map(p => p.trim());

        if ((abiFunctionSignature.toLowerCase().includes('deposit') || abiFunctionSignature.toLowerCase().includes('subscribe')) && parsedAbiParameters.length > 0) {
            parsedAbiParameters[0] = scaledTokenAmount;
            console.log(`DEBUG: Enforced exact on-chain parameter scaling for ${requestedAmount} USDC -> ${scaledTokenAmount}`);
        }

        const activeUsdcAddress = getUsdcAddress(circleNetwork);

        console.log("⏳ Step 1: Sending ERC-20 approve() transaction to Circle API...");

        let approveResponse;
        try {
            approveResponse = await circleClient.createContractExecutionTransaction({
                idempotencyKey: crypto.randomUUID(),
                walletId: walletId,
                blockchain: circleNetwork,
                contractAddress: activeUsdcAddress,
                abiFunctionSignature: "approve(address,uint256)",
                abiParameters: [TREASURY_CONTRACT_ADDRESS, parsedAbiParameters[0]],
                fee: { type: "level", config: { feeLevel: "MEDIUM" } }
            });
            console.log("✅ Approve TX Initiated:", approveResponse?.data?.id);
        } catch (circleErr) {
            console.error("❌ Circle Approve Error:", circleErr.response?.data || circleErr.message);
            return res.status(500).json({ success: false, error: "Approve failed: " + (circleErr.response?.data?.message || circleErr.message) });
        }

        const approveTxId = approveResponse.data.id;
        const localApproveTx = new Transaction({
            username: 'subone_test_user_01',
            sourceWalletId: walletId,
            destinationAddress: activeUsdcAddress,
            amount: requestedAmount,
            blockchain: circleNetwork,
            status: approveResponse.data.state || 'INITIATED',
            circleTxId: approveTxId,
            txHash: null
        });
        await localApproveTx.save();

        console.log("⏳ Waiting for approve() transaction to confirm on-chain...");
        
        let approveConfirmed = false;
        for (let i = 0; i < 30; i++) { 
            await new Promise(resolve => setTimeout(resolve, 2000));
            try {
                const checkRes = await circleClient.getTransaction({ id: approveTxId });
                const txObj = checkRes.data?.transaction || checkRes.data;
                const txState = txObj?.state;
                console.log(`🔍 Approve status check (${i + 1}/30): ${txState}`);

                if (txState === 'COMPLETE') {
                    approveConfirmed = true;
                    localApproveTx.status = 'COMPLETE';
                    localApproveTx.txHash = txObj.txHash;
                    await localApproveTx.save();
                    break;
                } else if (txState === 'FAILED' || txState === 'DENIED' || txState === 'CANCELLED') {
                    localApproveTx.status = txState;
                    await localApproveTx.save();
                    return res.status(500).json({ success: false, error: `Approval transaction failed with state: ${txState}` });
                }
            } catch (pollErr) {
                console.log("⚠️ Polling warning:", pollErr.message);
            }
        }

        if (!approveConfirmed) {
            return res.status(500).json({ success: false, error: "Approval transaction timed out waiting for confirmation." });
        }

        console.log("⏳ Step 2: Sending deposit() contract execution request to Circle API...");

        let response;
        try {
            response = await circleClient.createContractExecutionTransaction({
                idempotencyKey: crypto.randomUUID(),
                walletId: walletId,
                blockchain: circleNetwork,
                contractAddress: TREASURY_CONTRACT_ADDRESS,
                abiFunctionSignature: abiFunctionSignature,
                abiParameters: parsedAbiParameters,
                fee: { type: "level", config: { feeLevel: "MEDIUM" } }
            });
            console.log("✅ Deposit Circle API Response received:", response?.data);
        } catch (circleErr) {
            console.error("❌ Circle Deposit Error:", circleErr.response?.data || circleErr.message);
            return res.status(500).json({ success: false, error: "Deposit failed: " + (circleErr.response?.data?.message || circleErr.message) });
        }

        const txData = response.data;
        const localTx = new Transaction({
            username: 'subone_test_user_01',
            sourceWalletId: walletId,
            destinationAddress: TREASURY_CONTRACT_ADDRESS,
            amount: requestedAmount,
            blockchain: circleNetwork,
            status: txData.state || 'INITIATED',
            circleTxId: txData.id,
            txHash: null
        });

        await localTx.save();
        res.status(200).json({ success: true, transaction: localTx });
    } catch (error) {
        console.error("❌ Contract Execution Error:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 5. STATUS & HISTORY ENDPOINTS
// ==========================================
app.delete('/api/transaction/:id', async (req, res) => {
  try {
    await Transaction.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Transaction removed' });
  } catch (err) { res.status(500).json({ success: false, error: 'Failed to delete' }); }
});

app.get('/api/sync-transaction/:circleTxId', async (req, res) => {
    const txId = req.params.circleTxId.trim();
    try {
        const tx = await Transaction.findOne({ circleTxId: txId });
        if (!tx) return res.status(404).json({ success: false, error: "Transaction not found" });

        const response = await circleClient.getTransaction({ id: tx.circleTxId });
        const updatedData = response.data?.transaction || response.data;

        if (updatedData.txHash && (!tx.txHash || tx.status !== updatedData.state)) {
            tx.txHash = updatedData.txHash;
            tx.status = updatedData.state;
            await tx.save();
        } else if (updatedData.state && tx.status !== updatedData.state) {
            tx.status = updatedData.state;
            await tx.save();
        }
        res.json({ success: true, transaction: tx });
    } catch (error) { res.status(500).json({ success: false, error: "Error contacting Circle API" }); }
});

app.get('/api/status/:id', async (req, res) => {
    try {
        const tx = await Transaction.findOne({ circleTxId: req.params.id });
        if (tx) return res.status(200).json({ status: tx.status, details: tx });
        res.status(200).json({ status: 'IDLE', details: null });
    } catch (error) { res.status(500).json({ status: 'IDLE', error: error.message }); }
});

app.get('/api/transaction-history/:username', async (req, res) => {
    try {
        const history = await Transaction.find({ username: req.params.username }).sort({ createdAt: -1 });
        res.status(200).json({ success: true, history });
    } catch (error) { res.status(500).json({ success: false, error: "Failed to fetch history" }); }
});

// ==========================================
// 6. SAFE TREASURY CONFIGURATION ROUTE
// ==========================================
async function configureSafeTreasury(req, res) {
    try {
        const { username, blockchain, rpcUrl, owners, threshold } = req.body;

        if (!username || !blockchain || !rpcUrl || !owners || !threshold) {
            return res.status(400).json({ error: "Missing required configuration fields." });
        }

        if (threshold > owners.length || threshold <= 0) {
            return res.status(400).json({ error: "Invalid threshold: Must be between 1 and total owners." });
        }

        console.log(`🛡️ Configuring Safe for user ${username} on ${blockchain}...`);

        const safeResult = await getPredictedSafeAddress(rpcUrl, owners, threshold);
        
        if (!safeResult.success) {
            return res.status(500).json({ error: `Failed to initialize Safe: ${safeResult.error}` });
        }

        const updatedUser = await User.findOneAndUpdate(
            { username },
            { 
                $push: { 
                    safeDeployments: {
                        blockchain,
                        safeAddress: safeResult.predictedAddress,
                        owners,
                        threshold
                    } 
                } 
            },
            { new: true, upsert: true }
        );

        return res.status(200).json({
            message: "Safe treasury configured successfully!",
            safeAddress: safeResult.predictedAddress,
            blockchain,
            owners,
            threshold,
            user: updatedUser
        });

    } catch (error) {
        console.error("❌ Error in configureSafeTreasury:", error.message);
        return res.status(500).json({ error: "Internal server error during Safe configuration." });
    }
}

app.post('/api/safe/configure', configureSafeTreasury);

// ==========================================
// 7. WEBHOOK LISTENER
// ==========================================
app.post('/api/webhooks/circle', async (req, res) => {
    try {
        const event = req.body;
        console.log(`📩 Webhook Received: ${event.type}`);

        if (event.type === 'TransactionUpdated' && event.data?.transaction?.id) {
            const tx = await Transaction.findOne({ circleTxId: event.data.transaction.id });
            if (tx) {
                tx.status = event.data.transaction.state;
                tx.txHash = event.data.transaction.txHash || tx.txHash;
                await tx.save();
                io.emit('txUpdate', { circleTxId: tx.circleTxId, status: tx.status });
            }
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error("❌ Webhook Error:", error);
        res.status(500).send('Error');
    }
});

app.use(express.static(path.join(__dirname, 'public')));
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT} (Multi-Chain USDC Resolution Enabled)`));