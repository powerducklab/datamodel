import { extractEntities } from "../src";
import { buildImpactIndex, operationsForEntity } from "../src/impact";
import { shopDoc } from "./fixtures/shop";

describe("buildImpactIndex", () => {
  it("returns an empty index for an empty or invalid document", () => {
    expect(buildImpactIndex({ openapi: "3.1.0", paths: {} }).operations).toEqual([]);
    expect(buildImpactIndex(null).operations).toEqual([]);
    expect(buildImpactIndex("nope").operations).toEqual([]);
    expect(buildImpactIndex(null).schemaUsages).toEqual({});
  });

  it("indexes request and response references with their location", () => {
    const index = buildImpactIndex(shopDoc());
    const orderUsages = index.schemaUsages.Order ?? [];
    expect(orderUsages.map((usage) => `${usage.location}:${usage.ref}`).sort()).toEqual([
      "request:POST /orders",
      "response:GET /orders",
    ]);

    const customerRefs = (index.schemaUsages.Customer ?? []).map((usage) => usage.ref);
    expect(customerRefs.sort()).toEqual([
      "GET /customers",
      "GET /customers/{id}",
      "GET /orders",
      "POST /customers",
      "POST /orders",
    ]);
  });

  it("collects nested references inside request and response schemas", () => {
    const index = buildImpactIndex(shopDoc());
    // Order.customer is a nested $ref to Customer; both Order operations surface it.
    const customerRefs = index.schemaUsages.Customer?.map((usage) => usage.ref) ?? [];
    expect(customerRefs).toContain("POST /orders");
    expect(customerRefs).toContain("GET /orders");
  });

  it("indexes parameter schema references", () => {
    const parameterDoc = {
      openapi: "3.1.0",
      paths: {
        "/search": {
          get: {
            parameters: [
              { name: "filter", in: "query", schema: { $ref: "#/components/schemas/SearchFilter" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: { schemas: { SearchFilter: { type: "object", properties: { q: { type: "string" } } } } },
    };
    const index = buildImpactIndex(parameterDoc);
    expect(index.schemaUsages.SearchFilter).toMatchObject([
      { ref: "GET /search", location: "parameter" },
    ]);
  });

  it("lists every operation sorted", () => {
    const index = buildImpactIndex(shopDoc());
    expect(index.operations).toEqual([
      "GET /customers",
      "GET /customers/{id}",
      "GET /orders",
      "POST /customers",
      "POST /orders",
    ]);
  });

  it("deduplicates repeated references within one location", () => {
    const repeated = {
      openapi: "3.1.0",
      paths: {
        "/items": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        first: { $ref: "#/components/schemas/Item" },
                        second: { $ref: "#/components/schemas/Item" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: { schemas: { Item: { type: "object", properties: { id: { type: "integer" } } } } },
    };
    const usages = buildImpactIndex(repeated).schemaUsages.Item ?? [];
    expect(usages.filter((usage) => usage.ref === "GET /items")).toHaveLength(1);
  });
});

describe("operationsForEntity", () => {
  it("resolves a component entity through the reverse index", () => {
    const index = buildImpactIndex(shopDoc());
    const entities = extractEntities(shopDoc());
    const customer = entities.find((entity) => entity.name === "Customer");
    expect(customer).toBeDefined();
    expect(operationsForEntity(customer!, index)).toEqual([
      "GET /customers",
      "GET /customers/{id}",
      "GET /orders",
      "POST /customers",
      "POST /orders",
    ]);
  });

  it("uses the owning ref for an inline request entity", () => {
    const inlineDoc = {
      openapi: "3.1.0",
      paths: {
        "/ping": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { echo: { type: "string" } } },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const index = buildImpactIndex(inlineDoc);
    const entities = extractEntities(inlineDoc);
    const requestEntity = entities.find((entity) => entity.source === "request");
    expect(requestEntity).toBeDefined();
    expect(operationsForEntity(requestEntity!, index)).toEqual(["POST /ping"]);
  });
});
