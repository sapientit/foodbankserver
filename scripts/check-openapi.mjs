// Fails if `openapi.yaml` and the routes registered in `src/` have drifted
// apart. A contract that is already wrong is worse than no contract: the
// frontend generates its types from this file, so a missing path is a feature
// nobody knows exists and a phantom path is a client call that 404s.
//
// Deliberately plain Node and text-only. It never imports Worker code — that
// would need workerd — and it adds no dependency, so CI needs nothing new.
// `npm run format:check` already fails on a YAML syntax error, so validity is
// not re-checked here; this only compares what the two sides claim exists.
import { readFileSync } from 'node:fs';

const root = `${import.meta.dirname}/..`;
const read = (relative) => readFileSync(`${root}/${relative}`, 'utf8');

const VERBS = ['get', 'post', 'put', 'patch', 'delete'];

/** Normalises a mounted path to OpenAPI form: `/a/:id` -> `/a/{id}`. */
function toSpecPath(prefix, path) {
  const joined = (prefix + path).replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  return joined.replace(/:(\w+)/g, '{$1}');
}

/** Every `VERB /path` the app actually serves, read out of app.ts and the route modules. */
function routesInCode() {
  const appSrc = read('src/app.ts');

  // Which file each route-builder lives in.
  const fileFor = new Map();
  for (const match of appSrc.matchAll(/import\s*\{\s*([^}]+?)\s*\}\s*from\s*'\.\/(.+?\.ts)'/g)) {
    for (const name of match[1].split(',').map((part) => part.trim())) {
      fileFor.set(name, 'src/' + match[2]);
    }
  }

  const prefixMatch = /export const API_PREFIX = '([^']+)'/.exec(appSrc);
  if (prefixMatch === null) throw new Error('API_PREFIX not found in src/app.ts');
  const apiPrefix = prefixMatch[1];

  const found = new Set();
  const mountPattern = /app\.route\(\s*(`[^`]*`|'[^']*'|API_PREFIX)\s*,\s*(\w+)\(/g;
  let mounts = 0;

  for (const match of appSrc.matchAll(mountPattern)) {
    mounts += 1;
    const [, rawPrefix, builder] = match;
    const prefix =
      rawPrefix === 'API_PREFIX'
        ? apiPrefix
        : rawPrefix.slice(1, -1).replace('${API_PREFIX}', apiPrefix);

    const file = fileFor.get(builder);
    if (file === undefined) throw new Error(`no import found for route builder ${builder}`);

    const src = read(file);
    const registrations = src.matchAll(
      new RegExp(String.raw`^\s*routes\.(${VERBS.join('|')})\(\s*'([^']*)'`, 'gm'),
    );

    let hits = 0;
    for (const registration of registrations) {
      hits += 1;
      found.add(`${registration[1].toUpperCase()} ${toSpecPath(prefix, registration[2])}`);
    }
    // A silently unparsed module would make every one of its routes look
    // documented, which is the failure this whole script exists to prevent.
    if (hits === 0) throw new Error(`no routes matched in ${file} — has the pattern changed?`);
  }

  if (mounts === 0) throw new Error('no app.route() mounts found in src/app.ts');
  return found;
}

/** Every `VERB /path` under `paths:` in the spec. */
function pathsInSpec(spec) {
  const lines = spec.split('\n');
  const start = lines.indexOf('paths:');
  if (start === -1) throw new Error('no `paths:` block in openapi.yaml');

  const documented = new Set();
  let path = null;

  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && /^\S/.test(line)) break; // next top-level key

    const pathLine = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathLine !== null) {
      path = pathLine[1];
      continue;
    }

    const verbLine = /^ {4}([a-z]+):\s*$/.exec(line);
    if (verbLine !== null && path !== null && VERBS.includes(verbLine[1])) {
      documented.add(`${verbLine[1].toUpperCase()} ${path}`);
    }
  }

  if (documented.size === 0) throw new Error('parsed no operations from openapi.yaml');
  return documented;
}

/**
 * Request bodies typed `object` that never say which fields they hold.
 *
 * Such a body is valid OpenAPI and generates an unusable type — the client gets
 * an empty object and has to cast its way past it, so the contract is silently
 * doing nothing for the one endpoint that most needed it. `minProperties: 1`
 * without `properties:` is the shape this has taken in practice.
 */
function bodiesWithoutFields(spec) {
  const lines = spec.split('\n');
  const start = lines.indexOf('paths:');
  if (start === -1) throw new Error('no `paths:` block in openapi.yaml');

  // A shape is declared by naming fields, deferring to a component, composing
  // other schemas, or explicitly allowing anything through.
  const DECLARES_SHAPE = /^\s*(properties|allOf|oneOf|anyOf|additionalProperties|\$ref):/;

  const offenders = [];
  let path = null;
  let verb = null;
  let pending = null; // a `schema:` block being read, once known to be an object

  // Only an object owes us fields; an array or a scalar says everything it has to.
  const flush = () => {
    if (pending !== null && pending.isObject && !pending.declaresShape)
      offenders.push(pending.where);
    pending = null;
  };

  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && /^\S/.test(line)) break;

    const pathLine = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathLine !== null) {
      flush();
      path = pathLine[1];
      continue;
    }

    const verbLine = /^ {4}([a-z]+):\s*$/.exec(line);
    if (verbLine !== null && VERBS.includes(verbLine[1])) {
      flush();
      verb = verbLine[1];
      continue;
    }

    // A schema block ends at the first line indented no further than it.
    if (pending !== null) {
      const indent = line.search(/\S/);
      if (indent !== -1 && indent <= pending.indent) flush();
      else {
        if (DECLARES_SHAPE.test(line)) pending.declaresShape = true;
        if (/^\s*type:\s*object\s*$/.test(line)) pending.isObject = true;
      }
    }

    const schemaLine = /^(\s*)schema:(.*)$/.exec(line);
    if (schemaLine === null) continue;
    flush();

    const [, indent, inline] = schemaLine;
    const where = `${(verb ?? '?').toUpperCase()} ${path ?? '?'}`;

    // `schema: { type: object, minProperties: 1 }` — the whole thing on one line.
    if (inline.trim() !== '') {
      if (
        /type:\s*object/.test(inline) &&
        !DECLARES_SHAPE.test(` ${inline.replace(/[{},]/g, ' ')}`)
      )
        offenders.push(where);
      continue;
    }
    pending = { where, indent: indent.length, declaresShape: false, isObject: false };
  }
  flush();

  return [...new Set(offenders)].sort();
}

/** Component `$ref`s that point at nothing — the spec parses, but a generator would fail. */
function danglingRefs(spec) {
  const lines = spec.split('\n');
  const start = lines.indexOf('components:');
  if (start === -1) throw new Error('no `components:` block in openapi.yaml');

  const defined = new Set();
  let section = null;

  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && /^\S/.test(line)) break;

    const sectionLine = /^ {2}(\w+):\s*$/.exec(line);
    if (sectionLine !== null) {
      section = sectionLine[1];
      continue;
    }

    const nameLine = /^ {4}(\w+):/.exec(line);
    if (nameLine !== null && section !== null) defined.add(`${section}/${nameLine[1]}`);
  }

  const refs = new Set();
  for (const match of spec.matchAll(/\$ref:\s*'#\/components\/(\w+)\/(\w+)'/g)) {
    refs.add(`${match[1]}/${match[2]}`);
  }

  return [...refs].filter((ref) => !defined.has(ref)).sort();
}

const spec = read('openapi.yaml');
const code = routesInCode();
const documented = pathsInSpec(spec);

const undocumented = [...code].filter((route) => !documented.has(route)).sort();
const phantom = [...documented].filter((route) => !code.has(route)).sort();
const dangling = danglingRefs(spec);
const shapeless = bodiesWithoutFields(spec);

const report = (heading, entries) => {
  if (entries.length === 0) return;
  console.error(`\n${heading} (${entries.length})`);
  for (const entry of entries) console.error(`  ${entry}`);
};

report('In the code but missing from openapi.yaml', undocumented);
report('In openapi.yaml but not served by any route', phantom);
report('$ref pointing at an undefined component', dangling);
report('Object schema with no fields — generates an unusable type', shapeless);

if (undocumented.length > 0 || phantom.length > 0 || dangling.length > 0 || shapeless.length > 0) {
  console.error('\nopenapi.yaml is out of date. Update it in the same commit as the route.');
  process.exit(1);
}

console.log(`openapi.yaml matches all ${code.size} registered routes`);
