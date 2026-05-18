# @wskr/client

TypeScript client for the WSKR runtime server protocol.

## Install

```bash
bun add @wskr/client
```

## Usage

```ts
import { createKrunClient } from "@wskr/client"

const client = createKrunClient({ url: "ws://127.0.0.1:8877/rpc" })
const result = await client.list(true)
```

Use `boot` to launch a persistent in-VM service and return immediately:

```ts
await client.boot({
  name: "vm-build",
  command: "sandbox-agent",
  args: ["server", "--no-token"],
  env: [],
  cpus: 1,
  memoryMiB: 1024,
})
```

Unix socket endpoints are supported with `ws+unix` URLs, for example:

```ts
const client = createKrunClient({ url: "ws+unix:///usr/local/run/krunvmd.sock:/rpc" })
```

## API Highlights

- `createKrunClient(options)`
- `client.get()`
- `client.create(payload)`
- `client.start(payload)`
- `client.inspect(payload)`
- `client.changevm(payload)`
- `client.delete(payload)`
- `client.list(debug?)`
- `client.cancel(opId)`

## Development

```bash
bun run --filter @wskr/client test
```
