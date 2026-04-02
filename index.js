#!/usr/bin/env node
/*
Reusable deploy script for ToroSDK

Usage:
  npx toronetdeploy --file contracts/MyToken.sol --contract MyToken \
    --owner 0xYourOwnerAddress --args '["0xabc...", "1000"]' --network testnet

Install dependencies:
  npm install solc torosdk

This script compiles a single Solidity file and deploys the specified contract
using ToroSDK's `deploySmartContract`.
*/

const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { initializeSDK, deploySmartContract } = require('torosdk');

function usage() {
  console.log(
    'Usage:\n\tnpx toronetdeploy --file <path> --contract <name> --owner <address> [--args <json|csv>] [--network testnet|mainnet] [--token <token>]\n\n\
    Options:\n\t--file: Path to Solidity file containing the contract\n\t--contract: Name of the contract to deploy (must be in the specified file)\n\t--owner: Address of the owner deploying the contract\n\t--args: Constructor arguments as JSON array or comma-separated values\n\t--network: Network to deploy to (default: testnet)\n\t--token: Optional token for deployment if required by your setup\n\t--help, -h: Show this help message',
  );
  process.exit(1);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') out.file = argv[++i];
    else if (a === '--contract') out.contract = argv[++i];
    else if (a === '--owner') out.owner = argv[++i];
    else if (a === '--network') out.network = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--args') out.args = argv[++i];
    else if (a === '--help' || a === '-h') usage();
  }
  return out;
}

function parseConstructorArgs(argStr) {
  if (!argStr) return [];
  argStr = argStr.trim();
  if (argStr.startsWith('[')) {
    try {
      return JSON.parse(argStr);
    } catch (e) {
      throw new Error('Invalid JSON for --args');
    }
  }
  // comma-separated
  return argStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function compileSolidity(filePath, contractName) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) throw new Error('Solidity file not found: ' + absPath);
  const source = fs.readFileSync(absPath, 'utf8');

  const input = {
    language: 'Solidity',
    sources: {
      [path.basename(absPath)]: { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris', // important
      outputSelection: {
        '*': { '*': ['abi', 'evm.bytecode'] },
      },
    },
  };

  // load remappings from lib/*/remappings.txt (common in Foundry projects)
  function loadRemappings() {
    const remaps = [];
    const projectRoot = process.cwd();

    // 1) read foundry.toml remappings if present
    const foundryFile = path.join(projectRoot, 'foundry.toml');
    if (fs.existsSync(foundryFile)) {
      try {
        const txt = fs.readFileSync(foundryFile, 'utf8');
        const m = txt.match(/remappings\s*=\s*\[([^\]]*)\]/m);
        if (m && m[1]) {
          const items = m[1]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          for (let it of items) {
            // remove quotes
            it = it.replace(/^\s*['"]?/, '').replace(/['"]?\s*$/, '');
            // expect format prefix=target
            const parts = it.split('=');
            if (parts.length !== 2) continue;
            const prefix = parts[0];
            const target = parts[1];
            const absTarget = path.resolve(projectRoot, target);
            remaps.push([prefix, absTarget]);
          }
        }
      } catch (e) {
        // ignore parsing errors
      }
    }

    // 2) read lib/*/remappings.txt (foundry style)
    const libDir = path.resolve(projectRoot, 'lib');
    if (fs.existsSync(libDir)) {
      const libs = fs
        .readdirSync(libDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const l of libs) {
        const rfile = path.join(libDir, l, 'remappings.txt');
        if (!fs.existsSync(rfile)) continue;
        const lines = fs
          .readFileSync(rfile, 'utf8')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        for (const line of lines) {
          const parts = line.split('=');
          if (parts.length !== 2) continue;
          const prefix = parts[0];
          const target = parts[1];
          // make target absolute relative to remappings.txt
          const absTarget = path.resolve(path.dirname(rfile), target);
          remaps.push([prefix, absTarget]);
        }
      }
    }

    return remaps;
  }

  const remappings = loadRemappings();

  const mainDir = path.dirname(absPath);

  function findImports(importPath) {
    // Try remappings first (e.g. @openzeppelin/...)
    for (const [prefix, targetDir] of remappings) {
      // match exact prefix or prefix + '/'
      if (importPath === prefix || importPath.startsWith(prefix + '/')) {
        const rest = importPath === prefix ? '' : importPath.slice(prefix.length + 1);
        const candidate = path.join(targetDir, rest);
        if (fs.existsSync(candidate)) return { contents: fs.readFileSync(candidate, 'utf8') };
      }
    }

    // node_modules fallback
    const nmCandidate = path.join(process.cwd(), 'node_modules', importPath);
    if (fs.existsSync(nmCandidate)) return { contents: fs.readFileSync(nmCandidate, 'utf8') };

    // relative to main file
    const relCandidate = path.resolve(mainDir, importPath);
    if (fs.existsSync(relCandidate)) return { contents: fs.readFileSync(relCandidate, 'utf8') };

    // absolute / project-root relative
    const rootCandidate = path.resolve(process.cwd(), importPath);
    if (fs.existsSync(rootCandidate)) return { contents: fs.readFileSync(rootCandidate, 'utf8') };

    return { error: 'File import callback not supported for ' + importPath };
  }

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  if (output.errors) {
    const hasFatal = output.errors.some((e) => e.severity === 'error');
    output.errors.forEach((e) => console.error(e.formattedMessage || e.message));
    if (hasFatal) throw new Error('Compilation failed with errors');
  }

  const fileContracts = output.contracts[path.basename(absPath)];
  if (!fileContracts) throw new Error('No contracts found in compilation output');
  const contract = fileContracts[contractName];
  if (!contract) throw new Error(`Contract ${contractName} not found in ${filePath}`);

  const abi = contract.abi;
  const bytecode = contract.evm.bytecode.object;
  if (!bytecode || bytecode.length === 0)
    throw new Error('Bytecode is empty (abstract contract or interface?)');

  return { abi, bytecode: '0x' + bytecode };
}

async function main() {
  const opts = parseArgs();
  if (!opts.file || !opts.contract || !opts.owner) usage();

  const constructorArgs = parseConstructorArgs(opts.args);
  const network = opts.network || 'testnet';
  const token = opts.token || undefined;

  console.log('Compiling', opts.file, 'contract', opts.contract);
  const { abi, bytecode } = compileSolidity(opts.file, opts.contract);

  console.log('Initializing ToroSDK (network:', network + ')');
  initializeSDK({ network });

  console.log('Deploying contract...');
  try {
    const result = await deploySmartContract({
      owner: opts.owner,
      constructorArgs,
      abi,
      bytecode,
      token,
      network: network, // optional override; initializeSDK already set network as well
    });

    console.log('Deployed address:', result.address);
  } catch (err) {
    console.error('Deployment failed:', err && err.message ? err.message.toString() : err.toString());
    console.error(err);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
