# Orbit deploy runbook

Orbit is the internal order-routing service. It listens on port 8443 behind the edge proxy.

## Rolling out

1. Build and push the image: `orbitctl build --push`.
2. Start a canary: `orbitctl rollout --canary 10`. Watch the `orbit_http_5xx` panel for five minutes.
3. Promote: `orbitctl rollout --promote`.

## Rolling back

Run `orbitctl rollback --to previous`. A rollback takes about 90 seconds; do not start a new rollout until `orbitctl status` shows `stable`.

## Known issues

- **502 right after a rollout:** the new pods start without `ORBIT_REGION` when the deploy was triggered from a laptop instead of CI. The health check then fails and the proxy returns 502. Set `ORBIT_REGION` (for example `us-east-2`) in the rollout environment and roll out again.
- The canary percentage is capped at 50; larger values are silently reduced.
