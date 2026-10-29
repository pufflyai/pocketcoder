export async function diagnoseSharedPods(kube: (args: string[]) => Promise<string>) {
  try {
    const pods = JSON.parse(await kube(["get", "pods", "-o", "json"]));
    for (const pod of pods.items) {
      const { name, finalizers, deletionTimestamp, deletionGracePeriodSeconds } = pod.metadata;
      console.error(
        JSON.stringify({
          name,
          finalizers,
          deletionTimestamp,
          deletionGracePeriodSeconds,
          containers: pod.status.containerStatuses?.map((container: { state: unknown }) => container.state),
        }),
      );
    }
  } catch {
    console.error("Pod diagnosis unavailable");
  }
}
