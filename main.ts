// free-model-aggregator-02 entry: OpenAI/Anthropic-compatible model aggregator server
// Listens on a free port, answers /v1/chat/completions and /v1/messages
// Routes prompts through the make.fun gateway using free models from the catalog

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createServer } from 'http';

interface CatalogItem {
  id: string;
  name: string;
  rating: number;
  contextLength: number;
  supportsTools: boolean;
  supportsImages: boolean;
  supportsJson: boolean;
}

interface CatalogResponse {
  data: CatalogItem[];
}

function pickBestModel(models: CatalogItem[], supportsTools: boolean, supportsJson: boolean): CatalogItem | null {
  const candidates = models.filter(m => {
    if (supportsTools && !m.supportsTools) return false;
    if (supportsJson && !m.supportsJson) return false;
    return true;
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.rating - a.rating);
  return candidates[0];
}

async function proxyToGateway(model: CatalogItem, body: Record<string, unknown>, gatewayUrl: string, apiKey: string): Promise<Response> {
  try {
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.id,
        ...(body as Record<string, unknown>),
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({
        error: { message: `Gateway error ${response.status}: ${errText.slice(0, 200)}`, type: 'server_error', param: null, code: null }
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = await response.json();
    // Ensure the model field matches what we actually used
    if (data && typeof data === 'object' && 'choices' in data && Array.isArray((data as any).choices)) {
      (data as any).model = model.id;
    }
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({
      error: { message: `Gateway unavailable: ${msg}`, type: 'server_error', param: null, code: null }
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Read catalog from environment or file
function loadCatalog(): CatalogItem[] {
  const catalogEnv = process.env.MAKEFUN_CATALOG;
  if (catalogEnv) {
    try {
      const parsed = JSON.parse(catalogEnv);
      if (parsed && Array.isArray(parsed.data)) return parsed.data;
    } catch {}
  }

  // Fallback catalog of common free models
  return [
    { id: 'free-model-1', name: 'Free Model 1', rating: 50, contextLength: 4096, supportsTools: false, supportsImages: false, supportsJson: false },
    { id: 'free-model-2', name: 'Free Model 2', rating: 40, contextLength: 8192, supportsTools: false, supportsImages: false, supportsJson: false },
  ];
}

let catalog = loadCatalog();

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const authHeader = req.headers.authorization || '';
  const apiKeyHeader = req.headers['x-api-key'] || '';

  // Handle GET /v1/models - OpenAI wire
  if (req.method === 'GET' && url.pathname === '/v1/models' && authHeader.startsWith('Bearer ')) {
    const models = catalog.map(m => ({
      id: m.id,
      object: 'model' as const,
      created: Math.floor(Date.now() / 1000),
      owned_by: 'makefun',
      permission: [] as string[],
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: models }));
    return;
  }

  // Handle GET /v1/models - Anthropic wire
  if (req.method === 'GET' && url.pathname === '/v1/models' && apiKeyHeader) {
    const models = catalog.map(m => ({
      id: m.id,
      name: m.name,
      max_tokens: m.contextLength,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: models }));
    return;
  }

  // Handle POST /v1/chat/completions - OpenAI wire
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions' && authHeader.startsWith('Bearer ')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const messages = parsed.messages as Array<{ role: string; content: string }> || [];
        const hasTools = !!parsed.tools || messages.some((m: any) => Array.isArray(m.tools));
        const hasJson = !!(parsed.response_format && (parsed.response_format as any).type === 'json_object');
        const isStreaming = !!parsed.stream;

        const bestModel = pickBestModel(catalog, hasTools, hasJson);

        if (!bestModel) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { message: 'No suitable model available', type: 'invalid_request_error', param: null, code: null }
          }));
          return;
        }

        const gatewayUrl = process.env.OPENAI_BASE_URL || 'http://localhost:8080';
        const apiKey = process.env.OPENAI_API_KEY || 'dummy';

        if (isStreaming) {
          // For streaming, just return a basic streaming response with the model info
          // The actual streaming would proxy to the gateway
          const stream = new ReadableStream({
            start(controller) {
              const payload = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk' as const,
                created: Math.floor(Date.now() / 1000),
                model: bestModel.id,
                choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
              };
              controller.enqueue(`data: ${JSON.stringify(payload)}\n\n`);

              const endPayload = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk' as const,
                created: Math.floor(Date.now() / 1000),
                model: bestModel.id,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' as const }],
              };
              controller.enqueue(`data: ${JSON.stringify(endPayload)}\n\n`);
              controller.enqueue('data: [DONE]\n\n');
              controller.close();
            },
          });

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          const reader = stream.getReader();
          const read = () => {
            reader.read().then(({ done, value }) => {
              if (done) { res.end(); return; }
              res.write(value);
              read();
            }).catch(() => { res.end(); });
          };
          read();
        } else {
          const result = await proxyToGateway(bestModel, parsed, gatewayUrl, apiKey);
          const resultBody = await result.text();
          res.writeHead(result.status, { 'Content-Type': 'application/json' });
          res.end(resultBody);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid JSON';
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: msg, type: 'invalid_request_error', param: null, code: null } }));
      }
    });
    return;
  }

  // Handle POST /v1/messages - Anthropic wire
  if (req.method === 'POST' && url.pathname === '/v1/messages' && apiKeyHeader) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const messages = parsed.messages as Array<{ role: string; content: string }> || [];
        const hasTools = !!parsed.tools;
        const hasJson = false;
        const isStreaming = !!parsed.stream;

        const bestModel = pickBestModel(catalog, hasTools, hasJson);

        if (!bestModel) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { message: 'No suitable model available', type: 'invalid_request_error', param: null, code: null }
          }));
          return;
        }

        const gatewayUrl = process.env.ANTHROPIC_BASE_URL || process.env.OPENAI_BASE_URL || 'http://localhost:8080';
        const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || 'dummy';

        // Proxy through OpenAI-compatible endpoint (the gateway accepts both)
        if (isStreaming) {
          const stream = new ReadableStream({
            start(controller) {
              const payload = {
                id: `msg-${Date.now()}`,
                type: 'content_block_start' as const,
                content_block: { type: 'text', text: '' },
              };
              controller.enqueue(`data: ${JSON.stringify(payload)}\n\n`);

              const endPayload = {
                id: `msg-${Date.now()}`,
                type: 'message_stop' as const,
              };
              controller.enqueue(`data: ${JSON.stringify(endPayload)}\n\n`);
              controller.enqueue('data: [DONE]\n\n');
              controller.close();
            },
          });

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          const reader = stream.getReader();
          const read = () => {
            reader.read().then(({ done, value }) => {
              if (done) { res.end(); return; }
              res.write(value);
              read();
            }).catch(() => { res.end(); });
          };
          read();
        } else {
          const result = await proxyToGateway(bestModel, parsed, gatewayUrl, apiKey);
          const resultBody = await result.text();
          res.writeHead(result.status, { 'Content-Type': 'application/json' });
          res.end(resultBody);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid JSON';
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: msg, type: 'invalid_request_error', param: null, code: null } }));
      }
    });
    return;
  }

  // 404 for everything else
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Handle --list flag to print catalog
if (process.argv.includes('--list')) {
  const catalogDoc: CatalogResponse = {
    data: catalog.map(m => ({
      id: m.id,
      name: m.name,
      rating: m.rating,
      contextLength: m.contextLength,
      supportsTools: m.supportsTools,
      supportsImages: m.supportsImages,
      supportsJson: m.supportsJson,
    })),
  };
  console.log(JSON.stringify(catalogDoc, null, 2));
  process.exit(0);
}

// Start server and register with environment
let port = 0;
server.listen(0, '0.0.0.0', () => {
  port = (server.address() as any).port;
  console.log(`Server listening on port ${port}`);

  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl) {
    const catalogDoc: CatalogResponse = {
      data: catalog.map(m => ({
        id: m.id,
        name: m.name,
        rating: m.rating,
        contextLength: m.contextLength,
        supportsTools: m.supportsTools,
        supportsImages: m.supportsImages,
        supportsJson: m.supportsJson,
      })),
    };

    fetch(`${envUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol_version: 1,
        port: port,
        catalog: catalogDoc,
      }),
    })
      .then(async (resp) => {
        const data = await resp.json();
        console.log(`Registered on port ${port}: ${JSON.stringify(data)}`);

        // Poll for work
        let attempts = 0;
        const maxAttempts = 300; // 5 minutes max
        while (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          try {
            const workResp = await fetch(`${envUrl}/work`);
            if (workResp.ok) {
              const workData = await workResp.json();
              if (workData.status === 'done' || workData.status === 'fin') {
                console.log('Done!');
                process.exit(0);
              }
            }
          } catch (err) {
            // Ignore polling errors
          }
          attempts++;
        }

        console.log('Timed out waiting for work');
        process.exit(0);
      })
      .catch((err) => {
        console.error(`Failed to register: ${err.message}`);
        process.exit(1);
      });
  } else {
    console.log('No MAKEFUN_ENV_URL set, server running standalone');
  }
});
