# @wskr/provider

Sandbox Agent provider implementation backed by `@wskr/client`.

## Install

```bash
bun add @wskr/provider
```

## Usage

```ts
import { wskr } from "@wskr/provider"

const provider = wskr({
  resolveSpec: () => ({
    vmName: "vm-build",
    baseUrl: "http://127.0.0.1:3000",
    create: {
      image: "alpine:3.20",
      name: "vm-build",
      workdir: "/workspace",
      cpus: 1,
      dns: "1.1.1.1",
      volumes: [],
      ports: [],
      memoryMiB: 1024,
    },
    boot: {
      name: "vm-build",
      command: "sandbox-agent",
      args: ["server", "--no-token"],
      env: [],
      cpus: 1,
      memoryMiB: 1024,
    },
  }),
})
```

Provider create lifecycle is `create -> boot -> /v1/health readiness`.

## Development

```bash
bun run --filter @wskr/provider test
```
