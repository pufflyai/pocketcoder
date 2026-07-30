# PC-1 deployment validation

## Docker / local

```text
$ docker compose -f deploy/compose/docker-compose.yaml --profile full config --quiet
exit 0

$ docker build -f deploy/image/server.Dockerfile \
    -t pocketcoder-server:pc-1-validation .
image: sha256:56b1b8e8c1ebe84543cdb7a66bc6c0e710891be04a892a1dbe3e4f0f5f28b757
exit 0

$ docker run --rm --entrypoint sh pocketcoder-server:pc-1-validation \
    -c 'docker --version && kubectl version --client=true'
Docker version 28.5.2, build ecc6942
Client Version: v1.34.1
Kustomize Version: v5.7.1
exit 0
```

The full Compose profile mounts one absolute data root at the identical path
inside the controller so the host Docker daemon can resolve workspace and
checkpoint bind sources correctly.

## Kubernetes

```text
$ ruby -e 'require "yaml"; docs = YAML.load_stream(
    File.read("deploy/kubernetes/pocketcoder.yaml")
  ); puts "#{docs.length} Kubernetes resources parsed"'
7 Kubernetes resources parsed
exit 0

$ bun test packages/drivers/src/kubernetes.test.ts
1 pass
0 fail
```

The manifest includes:

- separate controller and unprivileged workspace service accounts;
- namespaced least-privilege RBAC for Jobs, Pods, and input Secrets;
- a persistent claim, single-active server Deployment, and Service;
- PVC-backed opaque workspace/checkpoint directories;
- Kubernetes Secret projection outside persistent paths.

No live Kubernetes context was configured during validation. The generated
Job is validated through a fake `kubectl`, while manifest YAML parsing and
the production image/kubectl smoke test cover the deployment packaging.
