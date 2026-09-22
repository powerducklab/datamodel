/**
 * Deterministic physical-name conventions. Users can override table names per
 * session; these only provide the defaults derived from schema names.
 */

const IRREGULAR_PLURALS: Record<string, string> = {
  child: "children",
  person: "people",
  man: "men",
  woman: "women",
  foot: "feet",
  tooth: "teeth",
  goose: "geese",
  mouse: "mice",
  ox: "oxen",
  data: "data",
  info: "info",
  metadata: "metadata",
  schema: "schemas",
};

/** Convert a camelCase / PascalCase identifier to snake_case. */
export function snakeCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .replace(/__+/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
}

function pascalCase(input: string): string {
  return input
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function pluralize(input: string): string {
  const word = input.trim();
  const lower = word.toLowerCase();
  if (IRREGULAR_PLURALS[lower]) return IRREGULAR_PLURALS[lower];
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** Inverse of pluralize for single resource path segments, e.g. "orders". */
export function singularize(input: string): string {
  const word = input.trim();
  if (!word) return word;
  const irregular = Object.entries(IRREGULAR_PLURALS).find(
    ([, plural]) => plural === word.toLowerCase(),
  );
  if (irregular) return irregular[0];
  if (/(s|x|z|ch|sh)es$/i.test(word)) return word.slice(0, -2);
  if (/[^aeiou]ies$/i.test(word)) return `${word.slice(0, -3)}y`;
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}

/** Default physical table name for a component name such as OrderItem. */
export function tableNameFor(entityName: string): string {
  return snakeCase(pluralize(pascalCase(entityName)));
}

/** Logical entity name from an operation path, e.g. POST /order-items. */
export function operationEntityName(
  method: string,
  path: string,
  suffix: "Request" | "Response" | "Item",
): string {
  const verbs: Record<string, string> = {
    get: suffix === "Request" ? "Query" : "List",
    post: "Create",
    put: "Replace",
    patch: "Update",
    delete: "Delete",
  };
  const verb = verbs[method.toLowerCase()] ?? method;
  const lastSegment =
    path.split("/").filter(Boolean).pop()?.replace(/\{([^}]+)\}/g, "$1") ??
    "Resource";
  const resource = pascalCase(
    lastSegment
      .split(/[-_]/)
      .map((part) => singularize(part))
      .join("-"),
  );
  return `${verb}${resource}${suffix}`;
}
