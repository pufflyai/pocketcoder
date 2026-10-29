# Pi bridge demo result

PC-114 checks the existing Pi bridge as the first PocketCoder 1.0 client path.
The demo uses real Pi coding tools through AgentAPI and a deterministic host
gateway. No paid model account is needed. See the [user runbook](pi-client-runbook.md).

## Candidate pins

Checked on macOS arm64 with Docker Engine `29.7.2` on 13 October 2026
(the logs use UTC on 12 October). Package candidates came from source revision
`9e785b42b6d5e6f010aaad5688e0c13b69f71a0e`. The workspace image includes the
compatibility fix in this change. The client package code is unchanged.

| Artifact | Pin |
| --- | --- |
| Remote client | `@pstdio/pocketcoder-remote@0.3.3` |
| SDK | `@pstdio/pocketcoder-sdk@0.6.0` |
| CLI | `@pstdio/pocketcoder-cli@0.8.0` |
| Local and remote Pi | `0.83.0` |
| AgentAPI | `0.12.2` |
| Bun | `1.4.2` |
| Workspace image, local Docker ID | `sha256:e48c5cdc5ea8bff8d7b8b4266d7a90ce0617836c68c3423022bf0f19f4453e67` |
| Template | `pi-harness@1.1.0` |
| Rendered template digest | `sha256:39102115e84f94837e7fd23462be345943f61c0b8d815f151f4c86de016ade15` |
| Compatibility source SHA-256 | `e6e5cacb2b2d17b006ee894c804b54d97ee2618063ff538a0e21b81842cb1232` |

Candidate tarball SHA-256 hashes:

```text
pstdio-pocketcoder-remote-0.3.3.tgz
b6fe090c714d051316010605e961d14a9ae035d0dc41139aa7de8146a76a774d
pstdio-pocketcoder-sdk-0.6.0.tgz
44806c7bb20aa23cc31934d96c03895c01edcec3a75119fe4048a4e8bb4fa127
pstdio-pocketcoder-cli-0.8.0.tgz
c27ba180267fcba47a7c60920bbd30c770c2dbb6ac089949c15c5b82858fc761
```

The template starts from `examples/templates/pi-harness.json`, replaces the
image and model, and adds one expiring workspace gateway bearer. Its digest
stays fixed during the run. A later fixture gets a new bearer and template
digest. These are local image IDs, not published registry digests.

## Commands and result

From the repository checkout:

```sh
bun install --frozen-lockfile
bun run example:e2e:pi
bun run example:pi:resume:check
```

`example:e2e:pi` starts the controller with `bun packages/server/src/index.ts`
using an isolated data folder and generated template. It checks a real remote
file read, streamed updates, disconnect without interruption, interruption,
and the next prompt. It also runs the adjacent regression with four identical
file replies, checking both final AgentAPI messages and durable history.

The separate packed-client acceptance driver starts the same controller
lifecycle and a workspace-bound gateway. It installs the candidate tarballs
with local SDK overrides, then runs:

```sh
# POCKETCODER_URL, POCKETCODER_KEY and POCKETCODER_WORKSPACE_ID are host-only inputs.
bun <candidate-install>/node_modules/@pstdio/pocketcoder-remote/dist/bin.js --mode rpc
# The interactive check uses the same launcher without --mode rpc.
bun <candidate-install>/node_modules/@pstdio/pocketcoder-remote/dist/bin.js
```

The driver and terminal recording are saved with the ticket's change request
report, RP-247. The checked workspace is `51688f20-18f1-4fba-83eb-28e94bab6246`.

| Check | Result |
| --- | --- |
| Remote write, read and follow-up | Pi wrote `/workspace/resume-test.txt` and returned the marker through its read tool. No corresponding client file was created. |
| Disconnect during an accepted turn | Both local client processes were killed while the model request was held. The remote agent stayed running and completed after release. |
| Reattach | Durable history contained the accepted user prompt once. A follow-up read returned the completed marker. The gateway saw one original prompt. |
| Interrupt and continue | Pi RPC abort stopped the held remote turn. The next file-read prompt succeeded. |
| Attachment | An `@file` gesture uploaded unique bytes through the attachment API. Remote Pi read them under `$HOME/.pcd/attachments`. |
| Interactive terminal | The packed launcher replayed the server history and displayed the remote file contents on another read. |
| Preserve and resume | The embedded example preserved on idle, restored twice, followed each new workspace, kept the file and model context, rotated gateway bearers, and sent each accepted prompt once. Its launcher reconnect check also passed. |
| Cleanup | The packed fixture was canceled and purged. Its old gateway bearer returned HTTP 410 before the gateway stopped. The resume fixture removed its session, database and checkpoints. |

Operator keys and the controller pepper stayed in host processes and storage.
Only the bounded gateway bearer entered the workspace. The gateway rejected
access after cancellation or preservation. The plain launcher has no resolver
and requires the explicit restore path described in the runbook.

## Reproduced failure and fix

Before the fix, an identical file reply could become only Pi's usage footer:
`↑3 ↓12 0.0%/128k (auto) pocketcoder-test`. The regression reproduced this on
the second reply. AgentAPI's generic screen comparison treats matching lines
as old text. The compatibility extension now hides the changing footer and
adds a unique custom entry before each turn. The entry does not enter model
context. Four stable replies and their durable copies now retain the fixture.

An earlier acceptance-driver attempt aborted on a stale workspace status,
before the intended held turn reached the model, and its follow-up timed out.
The corrected driver waits for model receipt and live output before aborting.
The interrupted implementation session also stopped a demo controller; its
owned container and temporary storage were removed before the final rerun.

## Handoff to PC-109

Reuse the saved remote and SDK candidates, the fixed Pi harness, and the
embedded resolver from this check for PC-109. The accepted image is retained
locally as `pocketcoder-pi:pc-114-candidate`; verify its ID against the pin above.
Issue new workspace gateway authority for each new fixture and record its
rendered template digest. The demo's operator connection file is not an artifact.

This proves the local Docker Pi path. It does not claim hosted provider,
Kubernetes, amd64, Kito, or Prompt Studio acceptance. PC-109 remains a
separate integration task.
