interface Metadata {
  name?: string;
  uid?: string;
  resourceVersion?: string;
  deletionTimestamp?: string;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  finalizers?: string[];
  ownerReferences?: { uid: string; kind: string; controller?: boolean }[];
}
export interface ContainerStatus {
  name: string;
  containerID?: string;
  state: { terminated?: { exitCode: number; finishedAt?: string; containerID?: string; reason?: string } };
}
export interface Resource {
  metadata: Metadata;
  spec: {
    nodeName?: string;
    providerID?: string;
    suspend?: boolean;
    template?: { metadata?: { finalizers?: string[] } };
    containers?: { name: string }[];
    initContainers?: { name: string }[];
    ephemeralContainers?: { name: string }[];
  };
  status?: {
    active?: number;
    ready?: number;
    terminating?: number;
    succeeded?: number;
    failed?: number;
    uncountedTerminatedPods?: { succeeded?: string[]; failed?: string[] };
    conditions?: { type: string; status: string }[];
    containerStatuses?: ContainerStatus[];
    initContainerStatuses?: ContainerStatus[];
    ephemeralContainerStatuses?: ContainerStatus[];
  };
}
