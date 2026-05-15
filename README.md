# wskr

A WebSocket for [krunvm](https://github.com/containers/krunvm). wskr ("whisker") is a collection of packages for managing krunVM virtual machines.

- `@wskr/server` - a JSON-RPC server implemented with the [Bun](https://github.com/oven-sh/bun) engine
- `@wskr/client` - a simple TypeScript SDK for calling KrunVM APIs via `@wskr/server`
- `@wskr/provider` - an [Agent Sandbox](https://github.com/rivet-dev/sandbox-agent) provider built using `@wskr/client`
- `@wskr/opencode-plugin` - a configurable, secure-by-default runtime policy layer for [OpenCode](https://github.com/anomalyco/opencode)

## About
wskr started as a simple attempt to pipe an OpenCode agent's bash commands into a microVM. I wondered if I could just `await Bun.$ "docker sbx run SOME_IMG ${piped_cmd}"` and have it magically work.

Naturally, that fell flat and so I started to "fix" it. And that, kids, is how you go from "one or two lines of bash, maybe?" to "mono repo looking pretty good about now."

## Goals

The goals of this project are:
- Provide a way to easily create microVMs using TypeScript
- Provide a way to configure secure environments for agents in OpenCode

The server, client, and provider packages are general use. You can use those to support isolation management however you see fit. I use this stack explicitly to get seamless local isolation for my agents in OpenCode, but I'd be stoked to see the work used elsewhere.

## Status

Test suite is good, APIs and contracts have strong types. Versions will likely remain pre-1.0 until there's interest in using the server/client for prod use cases and those have been addressed by the public API.

