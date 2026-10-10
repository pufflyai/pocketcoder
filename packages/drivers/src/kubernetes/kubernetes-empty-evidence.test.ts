import { expect, test } from "bun:test";
import { ADMISSION_ANNOTATION, hasNoPodAdmission } from "./kubernetes-empty-evidence";
import { EVIDENCE_FINALIZER } from "./kubernetes-evidence";

const job = () => ({
  metadata: { annotations: {} as Record<string, string> },
  spec: { template: { metadata: { finalizers: [EVIDENCE_FINALIZER] } } },
});

test("empty inventory requires immutable retention provenance and no saved admission", () => {
  const candidate = job();
  expect(hasNoPodAdmission(candidate, EVIDENCE_FINALIZER)).toBe(true);
  candidate.metadata.annotations[ADMISSION_ANNOTATION] = "true";
  expect(hasNoPodAdmission(candidate, EVIDENCE_FINALIZER)).toBe(false);
  expect(hasNoPodAdmission({ metadata: {}, spec: {} }, EVIDENCE_FINALIZER)).toBe(false);
});

for (const field of ["active", "ready", "terminating", "succeeded", "failed"] as const) {
  test(`a prior ${field} Pod count cannot prove non-admission`, () => {
    expect(hasNoPodAdmission({ ...job(), status: { [field]: 1 } }, EVIDENCE_FINALIZER)).toBe(false);
  });
}
for (const field of ["succeeded", "failed"] as const) {
  test(`an uncounted ${field} Pod cannot prove non-admission`, () => {
    expect(
      hasNoPodAdmission(
        {
          ...job(),
          status: { uncountedTerminatedPods: { [field]: ["known-pod"] } },
        },
        EVIDENCE_FINALIZER,
      ),
    ).toBe(false);
  });
}
