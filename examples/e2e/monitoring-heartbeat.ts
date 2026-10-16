import { monitoringDefaults } from "../../deploy/monitoring/rules";

export function healthyHeartbeatBaseline(input: { missing: number; oldest: number; alert: number }) {
  // An absent Prometheus instant series is represented by query() as NaN.
  return input.missing === 0 && input.oldest < monitoringDefaults.heartbeatSeconds && Number.isNaN(input.alert);
}
