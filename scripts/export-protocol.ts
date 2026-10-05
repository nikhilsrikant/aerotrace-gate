// Writes the published A2A protocol to docs/protocol/ (envelope, one schema per payload, and the whole spec).
//   npm run protocol
import { writeFileSync, mkdirSync } from 'node:fs';
import { ENVELOPE_SCHEMA, PAYLOAD_SCHEMAS, protocolSpec, PROTOCOL_VERSION } from '../lib/engine/protocol';
mkdirSync('docs/protocol/payload', { recursive: true });
const w = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
w('docs/protocol/envelope.json', ENVELOPE_SCHEMA);
for (const [t, s] of Object.entries(PAYLOAD_SCHEMAS)) w(`docs/protocol/payload/${t}.json`, { $schema: 'https://json-schema.org/draft/2020-12/schema', ...s });
w('docs/protocol/spec.json', protocolSpec());
console.log(`A2A protocol v${PROTOCOL_VERSION} written to docs/protocol/`);
