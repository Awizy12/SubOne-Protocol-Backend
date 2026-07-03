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

// 3. UTILITIES & CONFIG
const isValidEVMAddress = (address) => /^0x[a-fA-F0-9]{40}$/.test(address);
const NETWORK_MAP = {
  'polygon': 'MATIC-AMOY',
  'arbitrum': 'ARB-SEPOLIA',
  'base': 'BASE-SEPOLIA',
  'avalanche': 'AVAX-FUJI'
};

const app = express();
const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

// Initialize Socket.io with persistence settings
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling'], 
    pingTimeout: 60000,
    pingInterval: 25000
});

// Refined connection handler to reduce noise
io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Track disconnection to clear up the "phantom" connection feeling
    socket.on('disconnect', (reason) => {
        console.log(`🔌 Client disconnected: ${socket.id} (Reason: ${reason})`);
    });

    socket.on('error', (err) => {
        console.error(`⚠️ Socket Error on ${socket.id}:`, err);
    });
});

// 4. DATABASE CONNECTION
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to Database'))
  .catch((err) => { console.error('❌ DB Connection Error:', err.message); process.exit(1); });

mongoose.connection.on('connected', () => {
    console.log("📍 SCRIPT IS CONNECTED TO DATABASE NAME:", mongoose.connection.name);
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
            blockchains: ['MATIC-AMOY', 'ARB-SEPOLIA', 'BASE-SEPOLIA', 'AVAX-FUJI'],
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

app.get('/api/user-profile/:username', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.params.username });
        if (!user) return res.status(404).json({ success: false });
        res.status(200).json({ success: true, user });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==========================================
// 4. CORE PROTOCOL AUTOMATION
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
    const { destinationAddress, amount, walletId, network } = req.body;
    if (!destinationAddress || !amount || !walletId || !network) return res.status(400).json({ error: "Missing params" });
    if (!isValidEVMAddress(destinationAddress)) return res.status(400).json({ error: "Invalid Address" });
    
    const circleNetwork = NETWORK_MAP[network.toLowerCase()] || network;
    const formattedAmount = parseFloat(amount).toFixed(6);

    try {
        const balanceCheck = await circleClient.getWalletTokenBalance({ id: walletId });
        const targetTokenRecord = (balanceCheck.data?.tokenBalances || []).find(t => t.token?.symbol === 'USDC');
        if (!targetTokenRecord) throw new Error("NO_USDC_TOKEN_FOUND");

        const response = await circleClient.createTransaction({
            idempotencyKey: crypto.randomUUID(),
            walletId: walletId,
            blockchain: circleNetwork,
            destinationAddress: destinationAddress,
            amounts: [formattedAmount],
            fee: { type: "level", config: { feeLevel: "MEDIUM" } },
            tokenId: targetTokenRecord.token.id
        });

        const txData = response.data;
        if (!txData || !txData.id) throw new Error("Circle API did not return a valid transaction ID.");

        const localTx = new Transaction({
            username: 'subone_test_user_01',
            sourceWalletId: walletId,
            destinationAddress,
            amount: parseFloat(formattedAmount),
            blockchain: circleNetwork,
            status: txData.state || 'INITIATED',
            circleTxId: txData.id,
            txHash: txData.txHash || null
        });

        await localTx.save();
        res.status(200).json({ success: true, transaction: localTx });
    } catch (error) {
        console.error("❌ Execution Error:", error.message);
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
        const updatedData = response.data.transaction;

        if (updatedData.txHash && (!tx.txHash || tx.status !== updatedData.state)) {
            tx.txHash = updatedData.txHash;
            tx.status = updatedData.state === 'COMPLETE' ? 'SUCCESS' : updatedData.state;
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
// 6. WEBHOOK LISTENER
// ==========================================
app.post('/api/webhook', async (req, res) => {
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
                console.log(`📡 Emitted txUpdate for ${tx.circleTxId}`);
            }
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error("❌ Webhook Error:", error);
        res.status(500).send('Error');
    }
});

app.use(express.static(path.join(__dirname, 'public')));

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));