// Vercel Serverless Function — /api/chat
// Routes chat requests to the right upstream provider by model id.

// GitHub Models IDs (lowercase)
const GITHUB_CHAT_MODEL_IDS = new Set([
  'xai/grok-3-mini', 'xai/grok-3',
  'openai/gpt-5', 'openai/gpt-5-mini', 'openai/gpt-5-nano', 'openai/gpt-5-chat',
  'openai/gpt-5.4', 'openai/gpt-5.4-mini', 'openai/gpt-5.4-nano',
  'openai/gpt-4.1', 'openai/gpt-4.1-mini', 'openai/gpt-4.1-nano',
  'openai/gpt-4o', 'openai/gpt-4o-mini',
  'openai/o1', 'openai/o1-mini', 'openai/o1-preview',
  'openai/o3', 'openai/o3-mini', 'openai/o4-mini',
  'deepseek/deepseek-v3-0324', 'deepseek/deepseek-r1', 'deepseek/deepseek-r1-0528',
  'deepseek/deepseek-v4-flash',
  'meta/meta-llama-3.1-8b-instruct', 'meta/meta-llama-3.1-405b-instruct',
  'meta/llama-3.2-11b-vision-instruct', 'meta/llama-3.2-90b-vision-instruct',
  'meta/llama-3.3-70b-instruct',
  'microsoft/mai-ds-r1', 'microsoft/phi-4',
  'microsoft/phi-4-mini-instruct', 'microsoft/phi-4-mini-reasoning', 'microsoft/phi-4-reasoning',
  'cohere/cohere-command-r-08-2024', 'cohere/cohere-command-r-plus-08-2024', 'cohere/cohere-command-a',
  'mistral-ai/codestral-2501', 'mistral-ai/ministral-3b',
  'ai21/jamba-1.5-large',
]);

// OpenRouter model IDs (lowercase, ends with :free or not — matched by prefix)
const OPENROUTER_MODEL_PREFIXES = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'openai/gpt-oss-120b:free',
  'openai/gpt-oss-20b:free',
  'z-ai/glm-4.5-air:free',
  'deepseek/deepseek-v4-flash:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'minimax/minimax-m2.5:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-coder:free',
];
const OPENROUTER_MODEL_IDS = new Set(OPENROUTER_MODEL_PREFIXES);

function routeModel(modelId) {
  const key = String(modelId || '').toLowerCase();
  if (GITHUB_CHAT_MODEL_IDS.has(key)) return 'github';
  if (OPENROUTER_MODEL_IDS.has(key) || key.endsWith(':free') || key.endsWith(':nitro') || key.endsWith(':floor')) return 'openrouter';
  return 'nvidia';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const modelId = String((payload && payload.model) || '');
    const provider = routeModel(modelId);

    let endpoint, apiKey, authHeader;

    if (provider === 'github') {
      endpoint = (process.env.GITHUB_API_ENDPOINT || 'https://models.github.ai/inference').replace(/\/$/, '') + '/chat/completions';
      apiKey = process.env.GITHUB_API_MODEL_KEY;
      authHeader = 'Bearer ' + apiKey;
    } else if (provider === 'openrouter') {
      endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      apiKey = process.env.OPENROUTER_API_KEY;
      authHeader = 'Bearer ' + apiKey;
    } else {
      endpoint = 'https://integrate.api.nvidia.com/v1/chat/completions';
      apiKey = process.env.NVIDIA_API_KEY;
      authHeader = 'Bearer ' + apiKey;
    }

    if (!apiKey) {
      return res.status(500).json({ error: `API key for provider "${provider}" not set in environment variables` });
    }

    const extraHeaders = {};
    if (provider === 'openrouter') {
      extraHeaders['HTTP-Referer'] = 'https://nimchat.vercel.app';
      extraHeaders['X-Title'] = 'NIM Chat';
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader, ...extraHeaders },
      body: JSON.stringify(payload),
    });

    if (payload && payload.stream === true) {
      if (!response.ok) {
        const rawErr = await response.text();
        let dataErr = null;
        try { dataErr = rawErr ? JSON.parse(rawErr) : null; } catch { dataErr = null; }
        return res.status(response.status).json(
          dataErr || { error: 'Streaming upstream error', status: response.status, body: String(rawErr || '').slice(0, 1200) }
        );
      }

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');

      if (!response.body || !response.body.getReader) {
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    }

    const raw = await response.text();
    try {
      return res.status(response.status).json(JSON.parse(raw));
    } catch (_) {
      return res.status(response.status).json({ error: 'Upstream returned non-JSON', status: response.status, body: raw.slice(0, 1200) });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
}
