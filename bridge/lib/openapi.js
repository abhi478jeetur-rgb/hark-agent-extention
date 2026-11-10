'use strict';
const { TOOLS } = require('./tools');

function openapi(serverUrl, version) {
  const paths = {};
  for (const t of TOOLS) {
    const op = {
      operationId: t.name,
      summary: t.description,
      security: [{ bearer: [] }],
      responses: {
        200: {
          description: 'Result',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Result' } } },
        },
        401: { description: 'Missing or invalid token' },
        429: { description: 'Rate limited' },
        503: { description: 'Extension not connected' },
      },
    };
    if (t.method === 'GET') {
      op.parameters = Object.entries(t.inputSchema.properties || {}).map(([name, schema]) => ({
        name,
        in: 'query',
        required: false,
        schema: { type: schema.type, ...(schema.enum ? { enum: schema.enum } : {}) },
        description: schema.description,
      }));
      if (t.name === 'screenshot') {
        op.parameters.push({
          name: 'format',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['json', 'png'] },
          description: 'png returns image/png bytes; json (default) returns base64 in data.base64.',
        });
        op.responses[200].content['image/png'] = { schema: { type: 'string', format: 'binary' } };
      }
    } else {
      op.requestBody = { required: true, content: { 'application/json': { schema: t.inputSchema } } };
    }
    paths[t.path] = { ...(paths[t.path] || {}), [t.method.toLowerCase()]: op };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Hark Browser Bridge',
      version,
      description:
        "Control the user's Chrome through the Hark Browser Agent extension. Every request needs Authorization: Bearer <token>. Typical loop: read -> click/type by index -> read again.",
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Result: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
            error: { type: 'string' },
            code: { type: 'string' },
          },
        },
      },
    },
    paths,
  };
}

module.exports = { openapi };
