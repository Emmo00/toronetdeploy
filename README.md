# toronetdeploy

Deploy smart contracts to ToroNet.

## Install

Run via `npx` (no global install required):

```
npx toronetdeploy --file contracts/MyToken.sol --contract MyToken \
	--owner 0xYourOwnerAddress --args '["0xabc...", "1000"]' --network testnet
```

## Usage Options

- `--file` Path to the Solidity file containing the contract
- `--contract` Name of the contract to deploy (must be in the specified file)
- `--owner` Address of the owner deploying the contract
- `--args` Constructor arguments as JSON array or comma-separated values
- `--network` Network to deploy to (default: `testnet`)
- `--token` Optional token for deployment

License: MIT

Author: [Emmanuel Nwafor](https://github.com/emmo00)
