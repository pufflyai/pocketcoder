# `@pstdio/pocketcoder-cli`

The operator and diagnostics CLI for PocketCoder.

It gives operators one supported interface to run the server, manage database
state and access, validate templates, inspect workspaces, and diagnose a
deployment without writing control-plane API calls by hand.

## Install

pcd requires Node 22.19.0 or newer on macOS or Linux, on ARM64 or x64.
The package includes all four native executables. Bun is not needed to run it.

```sh
bun add --global @pstdio/pocketcoder-cli
pcd --version
pcd --help
```

For commit-pinned candidate tarballs and standalone downloads, see the
[candidate installation guide](https://github.com/pufflyai/pocketcoder/blob/feature/pocketcoder-1-0/docs/candidate-installation.md).

Local administrative commands use `POCKETCODER_DIR` (default `./pc_data`)
while the server is stopped. Startup applies migrations automatically. Workspace and diagnostics commands use
`POCKETCODER_URL` and `POCKETCODER_KEY`.

The CLI automatically loads the nearest `.env` file without overriding values
already exported by the shell. Use `--workdir <directory>` to select another
project directory or `--env-file <path>` to load a specific file.

`pcd server start|status|stop` manages only the PocketCoder server process. It
does not build workspace images, generate templates, start a model gateway, or
initialize deployment prerequisites.

See the full [CLI reference](https://github.com/pufflyai/pocketcoder/blob/main/docs/cli.md).

## Command layout

Each command lives under `src/commands/<resource>/<action>.ts`. The resource
registers its actions with yargs, and each action owns its options and handler.
This keeps help scoped to the selected resource or action and lets
`parseAsync()` run the command directly.
