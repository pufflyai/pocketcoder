# Workspace supervisor shutdown

The workspace PID1 closes new message and setup admission when shutdown starts.
Already admitted registration cleanup, attachment writes, relay/control handlers,
setup and background health work remain owned until their actual promises settle.
An admitted failure is retained before the promise is removed from the join set.
A caught caller error cannot turn that join into successful closure. Teardown retains
the original failure and still attempts the remaining child, output and transport
closures. A closed failed lifetime returns nonzero without an exited success frame.

Setup children are registered with the actual signal owner. Shutdown cannot launch
a later setup step or harness. The harness completion includes both original output
streams, so child exit alone cannot acknowledge completed userspace work.
Health polling stops and cancels its original reads; the final transcript read uses
the original termination deadline. A known transcript read failure remains logged
under the existing best-effort shutdown policy; it does not prove captured history.

The original termination grace covers task joining, final history, child exit and
final cleanup, including the original WebSocket close and admitted disconnect cleanup. Expiry refuses a later successful completion. A blocked filesystem
operation can remain unknown; no success acknowledgement adopts it after expiry.
Provider termination must still prove exact container settlement.

This does not acquire an original NFS filesystem descriptor, flush kernel writes,
or provide archive capture authority. Already running clients without a descriptor
held before their writes remain unqualified. Writer joins cannot replace original
mount/client identity or independently retained physical completion evidence.
