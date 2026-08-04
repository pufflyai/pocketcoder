# `@pstdio/pocketcoder-cli`

The operator and diagnostics CLI for PocketCoder.

## Install

pcd requires Bun 1.3.14 or newer:

```sh
bun add --global @pstdio/pocketcoder-cli
pcd --help
```

Database and administrative commands use `POCKETCODER_DATABASE_URL` and
`POCKETCODER_DATABASE_SCHEMA`. Workspace and diagnostics commands use
`POCKETCODER_URL` and `POCKETCODER_KEY`.

The CLI automatically loads the nearest `.env` file without overriding values
already exported by the shell. Use `--workdir <directory>` to select another
project directory or `--env-file <path>` to load a specific file.

`pcd server start|status|stop` manages only the PocketCoder server process. It
does not build workspace images, generate templates, start a model gateway, or
initialize deployment prerequisites.

See the full [CLI reference](https://github.com/pufflyai/pocketcoder/blob/main/docs/cli.md).
