const COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const REGISTRY = `${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*(?::[0-9]{1,5})?`;
const TAG = '[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}';
const SHA256 = '[a-f0-9]{64}';
const REFERENCE = new RegExp(
  `^(?:${REGISTRY}/)?${COMPONENT}(?:/${COMPONENT})*`
  + `(?::${TAG}(?:@sha256:${SHA256})?|@sha256:${SHA256})$`,
);

// Share the host configuration contract with execution so an accepted image
// cannot be rejected later by a different runtime grammar or length bound.
export function requireDockerImage(value) {
  const resolved = value === undefined ? 'node:22-bookworm-slim' : value;
  if (typeof resolved !== 'string'
    || resolved.length === 0
    || resolved.length > 256
    || resolved.startsWith('-')
    || /[\s\x00-\x1f\x7f]/.test(resolved)
    || !REFERENCE.test(resolved)) {
    throw new TypeError('dockerImage must be a tagged Docker reference or SHA-256 identity of at most 256 characters');
  }
  return resolved;
}
