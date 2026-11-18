# ModuNexo agent

The agent is built in a container so build machines need no local Go installation. The output is a static binary for the selected Linux architecture.

```sh
sh build.sh linux/arm64 ./dist/linux-arm64
./dist/linux-arm64/modunexo-agent --version
```

The core owns HTTPS transport, internal CA trust, service-token authentication, batching, systemd lifecycle, and updates. Plugins own module-specific payloads and never share them. The current source defines independent Observability and AI usage plugin boundaries; it does not yet install or contact any monitored system.
