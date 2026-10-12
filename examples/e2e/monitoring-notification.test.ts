import { expect, test } from "bun:test";
import { faultLabels, matchingNotification } from "./monitoring-notification";

const expiredKey = {
  alertname: "PocketcoderObservationGap",
  family: "observation",
  operator: "au-re",
  job: "pocketcoder-manager",
  instance: "manager:8080",
};
const oldAccount = {
  alertname: "PocketcoderObservationGap",
  family: "observation",
  operator: "au-re",
  account: "old-account",
};
const notification = (labels: Record<string, string>, status: string) => ({
  status,
  alerts: [{ status, labels, annotations: { response: "Restore the observed service." } }],
});

test("an older account notification cannot prove the current scrape fault", () => {
  expect(matchingNotification([notification(oldAccount, "firing")], 0, "firing", [expiredKey])).toBeUndefined();
  expect(matchingNotification([notification(expiredKey, "firing")], 0, "firing", [expiredKey])).toMatchObject({
    index: 0,
    labels: expiredKey,
  });
});

test("fault boundaries and exact labels retain only the matching recovery notification", () => {
  const received = [
    notification(expiredKey, "resolved"),
    notification(oldAccount, "resolved"),
    notification(expiredKey, "resolved"),
  ];
  expect(matchingNotification(received, 1, "resolved", [expiredKey])).toMatchObject({ index: 2, labels: expiredKey });
  expect(matchingNotification(received, 3, "resolved", [expiredKey])).toBeUndefined();
});

test("a scrape fault selects only its global alert while an older account alert is still firing", () => {
  const selected = faultLabels([oldAccount, expiredKey], { job: "pocketcoder-manager", account: undefined });
  expect(matchingNotification([notification(oldAccount, "firing")], 0, "firing", selected)).toBeUndefined();
  expect(matchingNotification([notification(expiredKey, "firing")], 0, "firing", selected)).toMatchObject({
    index: 0,
    labels: expiredKey,
  });
});
