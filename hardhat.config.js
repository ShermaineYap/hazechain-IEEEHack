require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();
const fs = require("fs");

function deployerKey() {
  if (process.env.DEPLOYER_PRIVATE_KEY) return [process.env.DEPLOYER_PRIVATE_KEY];
  try { return [JSON.parse(fs.readFileSync(".deployer.json")).privateKey]; } catch { return []; }
}

module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: {
    sepolia: { url: process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com", accounts: deployerKey(), chainId: 11155111 },
    baseSepolia: { url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org", accounts: deployerKey(), chainId: 84532 },
  },
  etherscan: { apiKey: process.env.ETHERSCAN_API_KEY || "" },
  sourcify: { enabled: true },
};
