const { ethers } = require('ethers');

async function checkCost() {
    // Connect to Arc Testnet RPC (or use your provider)
    const provider = new ethers.JsonRpcProvider('https://rpc.testnet.arc.network'); // update RPC if needed
    const contractAddress = '0x3853b08f152a54a4b98c3cb3b79966c3130b545b';
    
    // Minimal ABI containing only the subscriptionCost getter
    const abi = ["function subscriptionCost() view returns (uint256)"];
    
    const contract = new ethers.Contract(contractAddress, abi, provider);
    const cost = await contract.subscriptionCost();
    
    console.log("Raw Subscription Cost:", cost.toString());
    console.log("Formatted in USDC (6 decimals):", ethers.formatUnits(cost, 6));
}

checkCost();