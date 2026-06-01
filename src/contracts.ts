/**
 * Worker contract declarations for runbits-status.
 *
 * The status worker renders the public status page and exposes a JSON
 * health snapshot endpoint that the merchant dashboard polls. We pin:
 *
 *   - /api/monitoring/health-snapshot — public, used directly by the
 *     dashboard "Refresh now" button (bypasses the gateway to avoid the
 *     cascading 522 timeouts noted in the source comment).
 *
 * /api/monitoring/config requires INTERNAL secret + is admin-only via the
 * gateway, so it is not part of the live contract test surface — covered
 * by the gateway contract (`/api/monitoring/health-snapshot` jwt-admin).
 */

// Inline contract types (mirror runbits-e2e/tests/contracts/types.ts).
// Duplicated here so this worker compiles standalone — CI checks out one
// repo at a time and cross-repo type imports break in that environment.
type ScalarType = "string" | "number" | "boolean" | "null";
type ArrayType = `${ScalarType}[]`;
type SchemaValue =
  | ScalarType
  | ArrayType
  | "unknown"
  | { [key: string]: SchemaValue };
type ContractMethod = "GET" | "POST" | "PATCH" | "DELETE";
type ContractAuth = "none" | "jwt" | "jwt-admin" | "hmac-internal";
interface ContractDefinition {
  method: ContractMethod;
  path: string;
  description?: string;
  auth: ContractAuth;
  response: { status: number; schema: SchemaValue };
}


export const service = 'status';

export const contracts: ContractDefinition[] = [
  {
    method: 'GET',
    path: '/api/monitoring/health-snapshot',
    description: 'One-shot live health snapshot across all workers. Public (CORS allow-listed).',
    auth: 'jwt-admin',
    response: {
      status: 200,
      schema: {
        ts: 'number',
        // services[i] = { id, name, ok, status, latency_ms }. We only
        // assert the field exists — per-element shape is asserted by the
        // status worker's own tests.
        services: 'unknown',
      },
    },
  },
];
