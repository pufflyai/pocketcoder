export interface Notification {
  status: string;
  alerts: {
    status: string;
    labels: Record<string, string>;
    annotations: { response: string };
  }[];
}

export function matchingNotification(
  received: Notification[],
  from: number,
  status: string,
  expected: Record<string, string>[],
) {
  for (const [index, batch] of received.entries()) {
    if (index < from) continue;
    const alert = batch.alerts.find(
      (alert) =>
        alert.status === status &&
        alert.labels.operator === "au-re" &&
        alert.annotations.response.length > 10 &&
        expected.some(
          (labels) =>
            Object.keys(labels).length === Object.keys(alert.labels).length &&
            Object.entries(labels).every(([name, value]) => alert.labels[name] === value),
        ),
    );
    if (alert) return { index, labels: alert.labels };
  }
}

export function faultLabels(current: Record<string, string>[], scope: Record<string, string | undefined>) {
  return current.filter((labels) => Object.entries(scope).every(([name, value]) => labels[name] === value));
}
