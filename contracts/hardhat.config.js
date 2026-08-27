require("@nomicfoundation/hardhat-toolbox");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// SOLC_JS=1 compiles with the solcjs already in node_modules instead of
// downloading a compiler, and writes build output outside the project. It is
// the escape hatch for a judging laptop with no network or a read-only
// checkout: `SOLC_JS=1 npx hardhat test`. The default path is unchanged.
if (process.env.SOLC_JS) {
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async () => ({
    compilerPath: require.resolve("solc/soljson.js"),
    isSolcJs: true,
    version: "0.8.26",
    longVersion: "0.8.26+commit.8a97fa7a",
  }));
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: process.env.SOLC_JS ? "0.8.26" : "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  paths: process.env.SOLC_JS ? { artifacts: "/tmp/lt-artifacts", cache: "/tmp/lt-cache" } : undefined,
  networks: {
    localhost: { url: "http://127.0.0.1:8545" },
  },
};
