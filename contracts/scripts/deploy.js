// Deploys LanguageCredits to the local Hardhat chain, assigns the four roles
// to four distinct accounts, configures the missions and the catalog from
// the same definitions the service uses, and writes shared/deployment.json
// for `LEDGER=chain node server/server.js`.
//
// Role layout (Hardhat default accounts):
//   [0] admin      — programme multisig stand-in: missions, catalog, pause, roles, cancel
//   [1] verifier   — the verification service: awards the configured amount, nothing else
//   [2] redeemer   — the swap service (open): burns credits and opens a swap
//   [3] fulfiller  — the swap service (settle): settles once the provider confirms, or refunds
//   [9] stranger   — no role; used by the service for the permissionless sweeper

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const assessment = require("../../server/assessment");
const catalog = require("../../server/catalog");
const { hashParts } = require("../../server/ids");

async function main() {
  const [admin, verifier, redeemer, fulfiller] = await ethers.getSigners();

  const factory = await ethers.getContractFactory("LanguageCredits", admin);
  const contract = await factory.deploy(admin.address);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`LanguageCredits deployed at ${address}`);

  // --- roles -----------------------------------------------------------
  await (await contract.grantRole(await contract.VERIFIER_ROLE(), verifier.address)).wait();
  await (await contract.grantRole(await contract.REDEEMER_ROLE(), redeemer.address)).wait();
  await (await contract.grantRole(await contract.FULFILLER_ROLE(), fulfiller.address)).wait();
  console.log(`verifier:  ${verifier.address}`);
  console.log(`redeemer:  ${redeemer.address}`);
  console.log(`fulfiller: ${fulfiller.address}`);

  // --- missions --------------------------------------------------------
  for (const m of assessment.MISSIONS) {
    await (await contract.configureMission(m.missionId, m.reward, m.version, true)).wait();
    console.log(`mission ${m.slug}: ${m.reward} credits, v${m.version}`);
  }

  // --- catalog (closed-loop only; productCode is the provider's own id) --
  for (const item of catalog.all()) {
    catalog.assertClosedLoop(item);
    await (await contract.configureCatalogItem(item.itemId, hashParts("product", item.productCode), item.cost, item.inventory, true)).wait();
    console.log(`item ${item.slug}: ${item.productCode}, ${item.cost} credits, stock ${item.inventory}`);
  }

  // --- deployment file for the service -----------------------------------
  const artifact = await hre.artifacts.readArtifact("LanguageCredits");
  const deployment = {
    network: "localhost",
    chainId: 31337,
    rpcUrl: "http://127.0.0.1:8545",
    contract: "LanguageCredits",
    address,
    abi: artifact.abi,
    accounts: {
      admin: admin.address,
      verifier: verifier.address,
      redeemer: redeemer.address,
      fulfiller: fulfiller.address,
    },
    missions: assessment.MISSIONS.map((m) => ({ slug: m.slug, missionId: m.missionId, reward: m.reward, version: m.version })),
    catalog: catalog.all().map((i) => ({ slug: i.slug, itemId: i.itemId, productCode: i.productCode, cost: i.cost, inventory: i.inventory })),
    deployedAt: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, "..", "..", "shared");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "deployment.json");
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));
  console.log(`deployment written to ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
