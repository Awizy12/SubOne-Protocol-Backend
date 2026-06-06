const dns = require('dns');
dns.setServers(['1.1.1.1', '8.8.8.8']);

// ==========================================
// 1. INITIALIZATION & DEPENDENCIES
// ==========================================
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { initiateDeveloperControlledWalletsClient } = require('@circle-fin/developer-controlled-wallets');

const User = require('./User');
const Transaction = require('./models/Transaction');

const isValidEVMAddress = (address) => /^0x[a-fA-F0-9]{40}$/.test(address);

const NETWORK_MAP = {
  'polygon': 'MATIC-AMOY',
  'arbitrum': 'ARB-SEPOLIA',
  'base': 'BASE-SEPOLIA',
  'avalanche': 'AVAX-FUJI'
};

const app = express();
const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to Database'))
  .catch((err) => { console.error('❌ DB Connection Error:', err.message); process.exit(1); });

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
// 3. PERSISTENT WALLET OPERATIONS (FIXED)
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

        // PERSISTENCE GATE: Stop here if data exists
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

app.post('/api/execute-transaction', async (req, res) => {
    const { destinationAddress, amount, walletId, network } = req.body;
    if (!destinationAddress || !amount || !walletId || !network) return res.status(400).json({ error: "Missing params" });
    if (!isValidEVMAddress(destinationAddress)) return res.status(400).json({ error: "Invalid Address" });

    const circleNetwork = NETWORK_MAP[network.toLowerCase()] || network;
    const localTx = new Transaction({
        username: 'subone_test_user_01',
        sourceWalletId: walletId,
        destinationAddress,
        amount: parseFloat(amount),
        blockchain: circleNetwork,
        status: 'PENDING'
    });

    try {
        await localTx.save();
        const balanceCheck = await circleClient.getWalletTokenBalance({ id: walletId });
        const targetTokenRecord = (balanceCheck.data?.tokenBalances || []).find(t => t.token?.symbol === 'USDC');
        if (!targetTokenRecord) throw new Error("NO_USDC_TOKEN_FOUND");

        const response = await circleClient.createTransaction({
            idempotencyKey: crypto.randomUUID(),
            walletId: walletId,
            blockchain: circleNetwork,
            destinationAddress: destinationAddress,
            amounts: [String(amount)],
            fee: { type: "level", config: { feeLevel: "MEDIUM" } },
            tokenId: targetTokenRecord.token.id
        });

        localTx.status = 'SUCCESS';
        localTx.circleTxId = response.data?.transaction?.id || "Broadcasted";
        await localTx.save();
        res.status(200).json({ success: true, transaction: localTx });
    } catch (error) {
        localTx.status = 'FAILED';
        await localTx.save();
        res.status(500).json({ success: false, error: error.message || "Circle API Error" });
    }
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));