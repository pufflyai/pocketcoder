import { monitoringRules, type Thresholds } from "./rules";

export const monitoringImages = {
  prometheus: "prom/prometheus@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e",
  alertmanager: "prom/alertmanager@sha256:e9733bafb1bdef9b00e25a21f8f99dc26a22224bf16641ad754d1649f4c3357a",
};

export function monitoringConfig(input: {
  managerTarget: string;
  credentialsFile: string;
  alertmanagerTarget: string;
  receiverUrl: string;
  operator: string;
  runbookUrl: string;
  interval?: string;
  hold?: string;
  thresholds?: Partial<Thresholds>;
}) {
  if (!input.operator.trim()) throw new Error("Name the operator who receives and responds to alerts.");
  const receiver = new URL(input.receiverUrl);
  if (!["http:", "https:"].includes(receiver.protocol) || receiver.username || receiver.password)
    throw new Error("Use an HTTP receiver URL without embedded credentials.");
  return {
    prometheus: {
      global: { scrape_interval: input.interval ?? "15s", evaluation_interval: input.interval ?? "15s" },
      rule_files: ["/etc/pocketcoder/rules.json"],
      alerting: { alertmanagers: [{ static_configs: [{ targets: [input.alertmanagerTarget] }] }] },
      scrape_configs: [
        {
          job_name: "pocketcoder-manager",
          metrics_path: "/metrics",
          authorization: { type: "Bearer", credentials_file: input.credentialsFile },
          static_configs: [{ targets: [input.managerTarget] }],
        },
      ],
    },
    rules: monitoringRules(input.operator, input.runbookUrl, input.thresholds, input.hold),
    alertmanager: {
      route: {
        receiver: "operator",
        group_by: ["alertname", "account"],
        group_wait: input.interval ?? "15s",
        group_interval: input.interval ?? "15s",
        repeat_interval: "1h",
      },
      receivers: [{ name: "operator", webhook_configs: [{ url: receiver.toString(), send_resolved: true }] }],
    },
  };
}
