import { supabaseRest } from './_supabase.js';

function getNvidiaApiKey() {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error('NVIDIA_API_KEY not set');
  return key;
}

function getEmbeddingModel() {
  return process.env.NVIDIA_EMBEDDING_MODEL || 'nvidia/llama-3_2-nv-embedqa-1b-v2';
}

function normalizeSpaces(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function toVectorLiteral(embedding) {
  return `[${embedding.join(',')}]`;
}

export async function fetchEmbedding(text) {
  const input = normalizeSpaces(text);
  if (!input) return null;

  const res = await fetch('https://integrate.api.nvidia.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getNvidiaApiKey()}`,
    },
    body: JSON.stringify({
      model: getEmbeddingModel(),
      input: [input],
      encoding_format: 'float',
    }),
  });

  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!res.ok || !data || !data.data || !data.data[0] || !Array.isArray(data.data[0].embedding)) {
    throw new Error((data && (data.error || data.message)) || `Embedding error ${res.status}`);
  }

  return data.data[0].embedding;
}

export function splitIntoChunks(text, chunkSize = 500, overlap = 80) {
  const clean = normalizeSpaces(text);
  if (!clean) return [];

  const out = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + chunkSize, clean.length);
    if (end < clean.length) {
      const boundary = clean.lastIndexOf('. ', end);
      if (boundary > i + 200) end = boundary + 1;
    }

    const piece = clean.slice(i, end).trim();
    if (piece) out.push(piece);
    if (end >= clean.length) break;
    i = Math.max(end - overlap, i + 1);
  }

  return out.slice(0, 6);
}

async function summarizeWithNvidia(conversationMessages) {
  const apiKey = getNvidiaApiKey();
  const lines = (conversationMessages || [])
    .map((m) => `${m.role}: ${normalizeSpaces(m.content)}`)
    .slice(0, 28)
    .join('\n');

  if (!lines) return null;

  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.NVIDIA_SUMMARY_MODEL || 'mistralai/mistral-small-3.1-24b-instruct-2503',
      messages: [
        {
          role: 'system',
          content:
            'Summarize the chat memory in concise bullet points. Keep stable facts, preferences, long-term goals, unresolved threads, and user constraints. Avoid fluff.',
        },
        {
          role: 'user',
          content: lines,
        },
      ],
      max_tokens: 260,
      temperature: 0.2,
      stream: false,
    }),
  });

  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!res.ok || !data || !data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error((data && (data.error || data.message)) || `Summary error ${res.status}`);
  }

  return normalizeSpaces(data.choices[0].message.content || '');
}

export async function indexMessageForMemory({ userId, conversationId, messageId, role, content }) {
  const text = normalizeSpaces(content);
  if (!text || !messageId || !userId || !conversationId) return;
  if (!['user', 'assistant', 'system'].includes(role)) return;

  const chunks = splitIntoChunks(text);
  if (!chunks.length) return;

  await supabaseRest(`memory_chunks?message_id=eq.${messageId}`, { method: 'DELETE' });

  const records = [];
  for (const chunkText of chunks) {
    try {
      const emb = await fetchEmbedding(chunkText);
      if (!emb) continue;
      records.push({
        user_id: userId,
        conversation_id: conversationId,
        message_id: messageId,
        role,
        chunk_text: chunkText,
        embedding: toVectorLiteral(emb),
      });
    } catch {
      // Skip indexing failures without blocking the chat flow.
    }
  }

  if (records.length) {
    await supabaseRest('memory_chunks', {
      method: 'POST',
      body: records,
    });
  }
}

export async function maybeCreateSummarySnapshot({ userId, conversationId }) {
  if (!userId || !conversationId) return;

  const countRows = await supabaseRest(
    `messages?select=id&conversation_id=eq.${conversationId}`
  );
  const messageCount = Array.isArray(countRows) ? countRows.length : 0;
  if (messageCount < 10 || messageCount % 10 !== 0) return;

  const latest = await supabaseRest(
    `messages?select=id,role,content,created_at&conversation_id=eq.${conversationId}&order=id.desc&limit=24`
  );
  if (!latest || latest.length < 14) return;

  const existing = await supabaseRest(
    `memory_summaries?select=id,upto_message_id&conversation_id=eq.${conversationId}&order=created_at.desc&limit=1`
  );
  const newestId = Number(latest[0].id || 0);
  if (!newestId) return;
  if (existing && existing[0] && Number(existing[0].upto_message_id || 0) >= newestId) return;

  const chron = [...latest].reverse();
  let summaryText = null;
  try {
    summaryText = await summarizeWithNvidia(chron);
  } catch {
    return;
  }
  if (!summaryText) return;

  let summaryEmb = null;
  try {
    summaryEmb = await fetchEmbedding(summaryText);
  } catch {
    summaryEmb = null;
  }

  await supabaseRest('memory_summaries', {
    method: 'POST',
    body: [
      {
        user_id: userId,
        conversation_id: conversationId,
        upto_message_id: newestId,
        summary_text: summaryText,
        embedding: summaryEmb ? toVectorLiteral(summaryEmb) : null,
      },
    ],
  });
}
