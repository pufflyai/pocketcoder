export function operatorServices(runtimeImage: string) {
  const run = `#!/bin/sh
set -eu
role="$1"
shift
name="pc103-$role-\${INVOCATION_ID:-$$}"
if [ "$role" = manager ]; then name=pc103-manager; fi
case "$role" in
  manager) script=index.js; access=ro ;;
  account-backups) script=run-account-backups.js; access=ro ;;
  manager-backup) script=run-manager-backup.js; access=ro ;;
  access) script=run-access.js; access=rw ;;
  *) exit 2 ;;
esac
exec /usr/bin/docker run --rm --name "$name" --network host --user 10001:10001 \\
  --read-only --tmpfs /tmp:rw,nosuid,nodev --cap-drop ALL --security-opt no-new-privileges \\
  --env-file /etc/pocketcoder-private/manager.env \\
  --volume /opt/pocketcoder:/opt/pocketcoder:ro \\
  --volume "/etc/pocketcoder-private:/etc/pocketcoder-private:$access" \\
  --volume /mnt/pc103-manager:/mnt/pc103-manager \\
  --volume /mnt/pc103-journal:/mnt/pc103-journal \\
  --volume /dev/disk/by-id/scsi-0DO_Volume_pocketcoder-pc103-manager:/etc/pocketcoder-private/source-block-device:ro \\
  --entrypoint /usr/local/bin/bun ${runtimeImage} "/opt/pocketcoder/current/$script" "$@"
`;
  const maintenance = `#!/bin/sh
set -eu
systemctl stop pocketcoder-manager.service
case "$1" in
  rotate) /usr/local/libexec/pocketcoder-run access rotate ;;
  backup) /usr/local/libexec/pocketcoder-run manager-backup ;;
  *) exit 2 ;;
esac
`;
  const finish = `#!/bin/sh
set -eu
case "$1" in
  rotate) role=access ;;
  backup) role=manager-backup ;;
  *) exit 2 ;;
esac
name="pc103-$role-$INVOCATION_ID"
container=$(docker container ls --all --filter "name=^/$name$" --format '{{.ID}}')
if [ -n "$container" ]; then
  if ! docker stop --time 30 "$container" >/dev/null; then
    remaining=$(docker container ls --all --filter "name=^/$name$" --format '{{.ID}}')
    [ -z "$remaining" ] || exit 1
  fi
fi
exec /usr/bin/flock --wait 900 /run/pocketcoder-maintenance.lock /usr/bin/systemctl start pocketcoder-manager.service
`;
  const dependencies = `After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target
RequiresMountsFor=/mnt/pc103-manager /mnt/pc103-journal
`;
  const oneshot = (description: string, command: string, ordering = "", cleanup = "") => `[Unit]
Description=${description}
${dependencies}
${ordering}
[Service]
Type=oneshot
UMask=0077
ExecStart=${command}
${cleanup ? `ExecStopPost=${cleanup}` : ""}
TimeoutStartSec=20min
TimeoutStopSec=20min
`;
  const timer = (description: string, schedule: string) => `[Unit]
Description=${description}
[Timer]
OnCalendar=${schedule}
Persistent=true
[Install]
WantedBy=timers.target
`;
  return {
    "/usr/local/libexec/pocketcoder-run": run,
    "/usr/local/libexec/pocketcoder-maintenance": maintenance,
    "/usr/local/libexec/pocketcoder-finish-maintenance": finish,
    "/etc/systemd/system/pocketcoder-manager.service": `[Unit]
Description=PocketCoder manager from a pinned operator release
${dependencies}
[Service]
ExecStart=/usr/local/libexec/pocketcoder-run manager
ExecStop=/usr/bin/docker stop --time 30 pc103-manager
Restart=on-failure
RestartSec=5s
TimeoutStopSec=45s
[Install]
WantedBy=multi-user.target
`,
    "/etc/systemd/system/pocketcoder-account-backups.service": oneshot(
      "Capture encrypted account backups",
      "/usr/local/libexec/pocketcoder-run account-backups /etc/pocketcoder-private/account-backups.json",
    ),
    "/etc/systemd/system/pocketcoder-manager-backup.service": oneshot(
      "Capture encrypted manager backup",
      "/usr/bin/flock --wait 900 /run/pocketcoder-maintenance.lock /usr/local/libexec/pocketcoder-maintenance backup",
      "After=pocketcoder-account-backups.service",
      "/usr/local/libexec/pocketcoder-finish-maintenance backup",
    ),
    "/etc/systemd/system/pocketcoder-access-rotation.service": oneshot(
      "Rotate finite manager operator keys",
      "/usr/bin/flock --wait 900 /run/pocketcoder-maintenance.lock /usr/local/libexec/pocketcoder-maintenance rotate",
      "After=pocketcoder-account-backups.service",
      "/usr/local/libexec/pocketcoder-finish-maintenance rotate",
    ),
    "/etc/systemd/system/pocketcoder-kubeconfig.service": oneshot(
      "Renew finite Kubernetes access",
      "/usr/local/libexec/pocketcoder-run access refresh",
    ),
    "/etc/systemd/system/pocketcoder-account-backups.timer": timer("Schedule account backups", "*-*-* 00,12:00:00 UTC"),
    "/etc/systemd/system/pocketcoder-manager-backup.timer": timer("Schedule manager backups", "*-*-* 00,12:45:00 UTC"),
    "/etc/systemd/system/pocketcoder-access-rotation.timer": timer(
      "Rotate before twenty-hour operator expiry",
      "*-*-* 00,12:30:00 UTC",
    ),
    "/etc/systemd/system/pocketcoder-kubeconfig.timer": `[Unit]
Description=Refresh thirty-minute Kubernetes access
[Timer]
OnBootSec=10min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
`,
  };
}
