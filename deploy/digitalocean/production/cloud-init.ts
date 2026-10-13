import { operatorServices } from "./services";

export type OperatorBootstrap = {
  artifact: { url: string; sha256: string; commit: string };
  runtimeImage: string;
  controllerImage: string;
  runtimeClass: string;
  storage: unknown;
  encryptionKey: Buffer;
  cloudCredential: { token: string; expiresAt: string; clusterId: string };
};

export function operatorCloudInit(input: OperatorBootstrap) {
  const file = (path: string, content: string | Buffer, owner = "root:root", permissions = "0600") => ({
    path,
    owner,
    permissions,
    encoding: "b64",
    content: Buffer.from(content).toString("base64"),
    defer: true,
  });
  const json = (value: unknown) => `${JSON.stringify(value)}\n`;
  const environment = [
    "KUBECONFIG=/etc/pocketcoder-private/kubeconfig",
    "POCKETCODER_MANAGER_DIR=/mnt/pc103-manager/manager_data",
    "POCKETCODER_MANAGER_PURGE_CONFIG=/etc/pocketcoder-private/purge.json",
    "POCKETCODER_MANAGER_OFF_NODE_CONFIG=/etc/pocketcoder-private/off-node.json",
    "POCKETCODER_MANAGER_BACKUP_RECEIPTS=/mnt/pc103-journal/backup-receipts",
    "POCKETCODER_MANAGER_HTTP=127.0.0.1:8092",
    `POCKETCODER_MANAGER_CONTROLLER_IMAGE=${input.controllerImage}`,
    `POCKETCODER_MANAGER_RUNTIME_CLASS=${input.runtimeClass}`,
    `POCKETCODER_OPERATOR_COMMIT=${input.artifact.commit}`,
    `POCKETCODER_OPERATOR_SHA256=${input.artifact.sha256}`,
  ].join("\n");
  const install = `#!/bin/sh
set -eu
install -d -m 0700 -o 10001 -g 10001 /etc/pocketcoder-private
install -d -m 0755 /opt/pocketcoder/releases/${input.artifact.commit}
curl --silent --show-error --fail --config /etc/pocketcoder-private/download.conf
printf '%s  %s\\n' '${input.artifact.sha256}' /var/lib/pocketcoder-operator.tar.gz | sha256sum --check
tar -xzf /var/lib/pocketcoder-operator.tar.gz -C /opt/pocketcoder/releases/${input.artifact.commit} --strip-components=1
ln -sfn /opt/pocketcoder/releases/${input.artifact.commit} /opt/pocketcoder/current
rm /var/lib/pocketcoder-operator.tar.gz
install -d -m 0700 -o 10001 -g 10001 /mnt/pc103-manager/manager_data /mnt/pc103-journal/authority /mnt/pc103-journal/backup-receipts
docker pull ${input.runtimeImage}
systemd-analyze verify /etc/systemd/system/pocketcoder-*.service /etc/systemd/system/pocketcoder-*.timer
systemctl daemon-reload
systemctl start pocketcoder-kubeconfig.service
/usr/local/libexec/pocketcoder-run access init-storage
systemctl start pocketcoder-access-rotation.service
/usr/local/libexec/pocketcoder-run access wait
systemctl start pocketcoder-account-backups.service pocketcoder-manager-backup.service
systemctl start pocketcoder-account-backups.timer pocketcoder-manager-backup.timer pocketcoder-access-rotation.timer pocketcoder-kubeconfig.timer
systemctl is-active pocketcoder-manager.service
/usr/local/libexec/pocketcoder-run access ready
`;
  const config = {
    users: ["default", { name: "pocketcoder-operator", uid: 10001, lock_passwd: true, shell: "/usr/sbin/nologin" }],
    package_update: true,
    apt: {
      primary: [{ arches: ["default"], uri: "https://archive.ubuntu.com/ubuntu/" }],
      security: [{ arches: ["default"], uri: "https://security.ubuntu.com/ubuntu/" }],
    },
    packages: ["docker.io", "curl", "util-linux"],
    mounts: [
      [
        "/dev/disk/by-id/scsi-0DO_Volume_pocketcoder-pc103-manager",
        "/mnt/pc103-manager",
        "ext4",
        "defaults,nofail,x-systemd.device-timeout=180s",
        "0",
        "2",
      ],
      [
        "/dev/disk/by-id/scsi-0DO_Volume_pocketcoder-pc103-journal",
        "/mnt/pc103-journal",
        "ext4",
        "defaults,nofail,x-systemd.device-timeout=180s",
        "0",
        "2",
      ],
    ],
    write_files: [
      ...Object.entries(operatorServices(input.runtimeImage)).map(([path, content]) =>
        file(path, content, "root:root", path.startsWith("/usr/") ? "0755" : "0644"),
      ),
      file("/usr/local/libexec/pocketcoder-install", install, "root:root", "0755"),
      file(
        "/etc/systemd/system/pocketcoder-install.service",
        `[Unit]\nDescription=Install the pinned PocketCoder operator release\nAfter=docker.service network-online.target\nRequires=docker.service\nWants=network-online.target\nRequiresMountsFor=/mnt/pc103-manager /mnt/pc103-journal\n[Service]\nType=oneshot\nExecStart=/usr/local/libexec/pocketcoder-install\nRemainAfterExit=true\nTimeoutStartSec=20min\n[Install]\nWantedBy=multi-user.target\n`,
        "root:root",
        "0644",
      ),
      file("/etc/pocketcoder-private/manager.env", `${environment}\n`, "pocketcoder-operator:pocketcoder-operator"),
      file(
        "/etc/pocketcoder-private/download.conf",
        `url = ${JSON.stringify(input.artifact.url)}\noutput = /var/lib/pocketcoder-operator.tar.gz\nlocation\n`,
      ),
      file(
        "/etc/pocketcoder-private/cloud-credential.json",
        json(input.cloudCredential),
        "pocketcoder-operator:pocketcoder-operator",
      ),
      file("/etc/pocketcoder-private/archive-key", input.encryptionKey, "pocketcoder-operator:pocketcoder-operator"),
      file(
        "/etc/pocketcoder-private/off-node.json",
        json({ storage: input.storage, encryptionKeyFile: "/etc/pocketcoder-private/archive-key" }),
        "pocketcoder-operator:pocketcoder-operator",
      ),
      file(
        "/etc/pocketcoder-private/purge.json",
        json({ directory: "/mnt/pc103-journal/authority", storage: input.storage }),
        "pocketcoder-operator:pocketcoder-operator",
      ),
      file(
        "/etc/pocketcoder-private/account-backups.json",
        json({ managerUrl: "http://127.0.0.1:8092", tokenFile: "/etc/pocketcoder-private/schedule-operator-token" }),
        "pocketcoder-operator:pocketcoder-operator",
      ),
    ],
    runcmd: [
      ["systemctl", "daemon-reload"],
      ["systemctl", "enable", "--now", "pocketcoder-install.service"],
    ],
  };
  return `#cloud-config\n${JSON.stringify(config, null, 2)}\n`;
}
