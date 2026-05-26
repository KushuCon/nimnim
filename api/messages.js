import { requireSession, supabaseRest } from './_supabase.js';
import { indexMessageForMemory, maybeCreateSummarySnapshot } from './_memory.js';

function firstLineTitle(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return 'New Chat';
  return s.slice(0, 60);
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function cleanGeneratedTitle(text) {
  return String(text || '')
    .replace(/^["'`\-•\d.\s]+/, '')
    .replace(/["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function getNvidiaApiKey() {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) return null;
  return key;
}

async function generateConversationTitle(text) {
  const apiKey = getNvidiaApiKey();
  if (!apiKey) return null;

  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.NVIDIA_TITLE_MODEL || 'microsoft/phi-4-mini-flash-reasoning',
        messages: [
          {
            role: 'system',
            content:
              'Generate a concise 5-word title for this chat. Return title only, no punctuation, no quotes, no explanation.',
          },
          {
            role: 'user',
            content: String(text || ''),
          },
        ],
        max_tokens: 24,
        temperature: 0.2,
        stream: false,
      }),
    });

    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    const title = cleanGeneratedTitle(
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : ''
    );
    return title || null;
  } catch {
    return null;
  }
}

async function getOwnedConversation(conversationId, userId) {
  const rows = await supabaseRest(
    `conversations?select=id,title,tags,total_tokens_est&user_id=eq.${userId}&id=eq.${conversationId}&limit=1`
  );
  return rows && rows[0] ? rows[0] : null;
}

async function getOwnedMessage(messageId, conversationId, userId) {
  const rows = await supabaseRest(
    `messages?select=id,conversation_id,role,content,model_id,created_at&id=eq.${messageId}&conversation_id=eq.${conversationId}&limit=1`
  );
  if (!rows || !rows[0]) return null;
  const convo = await getOwnedConversation(conversationId, userId);
  if (!convo) return null;
  return rows[0];
}

async function decorateMessages(rows, session, conversationId) {
  const messageIds = (rows || []).map((row) => row.id).filter(Boolean);
  if (!messageIds.length) return rows || [];

  const idList = `(${messageIds.join(',')})`;
  let feedbackMap = {};
  let pinnedMap = {};

  try {
    const feedbackRows = await supabaseRest(
      `message_feedback?select=message_id,feedback&user_id=eq.${session.user_id}&conversation_id=eq.${conversationId}&message_id=in.${idList}`
    );
    feedbackMap = Object.fromEntries((feedbackRows || []).map((row) => [String(row.message_id), row.feedback]));
  } catch {
    feedbackMap = {};
  }

  try {
    const pinRows = await supabaseRest(
      `pinned_messages?select=message_id&user_id=eq.${session.user_id}&conversation_id=eq.${conversationId}&message_id=in.${idList}`
    );
    pinnedMap = Object.fromEntries((pinRows || []).map((row) => [String(row.message_id), true]));
  } catch {
    pinnedMap = {};
  }

  return (rows || []).map((row) => ({
    ...row,
    pinned: !!pinnedMap[String(row.id)],
    feedback: feedbackMap[String(row.id)] || null,
  }));
}

export default async function handler(req, res) {
  try {
    const session = await requireSession(req, res);
    if (!session) return;

    if (req.method === 'GET') {
      const conversationId = String(req.query.conversation_id || '').trim();
      if (!conversationId) return res.status(400).json({ error: 'conversation_id is required' });

      const convo = await getOwnedConversation(conversationId, session.user_id);
      if (!convo) return res.status(404).json({ error: 'Conversation not found' });

      const rows = await supabaseRest(
        `messages?select=id,role,content,model_id,created_at&conversation_id=eq.${conversationId}&order=id.asc`
      );
      const decorated = await decorateMessages(rows || [], session, conversationId);
      return res.status(200).json({ messages: decorated });
    }

    if (req.method === 'POST') {
      const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const conversationId = String(payload.conversation_id || '').trim();
      const role = String(payload.role || '').trim();
      const content = String(payload.content || '').trim();
      const modelId = payload.model_id ? String(payload.model_id) : null;

      if (!conversationId) return res.status(400).json({ error: 'conversation_id is required' });
      if (!['user', 'assistant', 'system'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
      if (!content) return res.status(400).json({ error: 'content is required' });

      const convo = await getOwnedConversation(conversationId, session.user_id);
      if (!convo) return res.status(404).json({ error: 'Conversation not found' });

      const inserted = await supabaseRest('messages', {
        method: 'POST',
        body: [{ conversation_id: conversationId, role, content, model_id: modelId }],
      });

      const message = inserted && inserted[0] ? inserted[0] : null;

      await supabaseRest(`conversations?id=eq.${conversationId}`, {
        method: 'PATCH',
        body: {
          updated_at: new Date().toISOString(),
          total_tokens_est: Number(convo.total_tokens_est || 0) + estimateTokens(content),
        },
      });

      if (role === 'user' && (!convo.title || convo.title === 'New Chat')) {
        const generatedTitle = (await generateConversationTitle(content)) || firstLineTitle(content);
        await supabaseRest(`conversations?id=eq.${conversationId}`, {
          method: 'PATCH',
          body: { title: generatedTitle, updated_at: new Date().toISOString() },
        });
      }

      try {
        if (message && message.id) {
          await indexMessageForMemory({
            userId: session.user_id,
            conversationId,
            messageId: message.id,
            role,
            content,
          });
          await maybeCreateSummarySnapshot({ userId: session.user_id, conversationId });
        }
      } catch {
        // Memory indexing is best-effort.
      }

      return res.status(200).json({ message });
    }

    if (req.method === 'PATCH') {
      const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const action = String(payload.action || '').trim();
      const conversationId = String(payload.conversation_id || '').trim();
      const messageId = String(payload.message_id || '').trim();

      if (!action) return res.status(400).json({ error: 'action is required' });
      if (!conversationId) return res.status(400).json({ error: 'conversation_id is required' });
      if (!messageId) return res.status(400).json({ error: 'message_id is required' });

      const convo = await getOwnedConversation(conversationId, session.user_id);
      if (!convo) return res.status(404).json({ error: 'Conversation not found' });

      const message = await getOwnedMessage(messageId, conversationId, session.user_id);
      if (!message) return res.status(404).json({ error: 'Message not found' });

      if (action === 'pin') {
        const pinned = payload.pinned !== false;
        await supabaseRest(`pinned_messages?user_id=eq.${session.user_id}&message_id=eq.${messageId}`, {
          method: 'DELETE',
        });
        if (pinned) {
          await supabaseRest('pinned_messages', {
            method: 'POST',
            body: [
              {
                user_id: session.user_id,
                message_id: Number(messageId),
                conversation_id: conversationId,
              },
            ],
          });
        }
        return res.status(200).json({ pinned });
      }

      if (action === 'feedback') {
        const feedback = String(payload.feedback || '').trim().toLowerCase();
        await supabaseRest(`message_feedback?user_id=eq.${session.user_id}&message_id=eq.${messageId}`, {
          method: 'DELETE',
        });
        if (feedback === 'up' || feedback === 'down') {
          await supabaseRest('message_feedback', {
            method: 'POST',
            body: [
              {
                user_id: session.user_id,
                message_id: Number(messageId),
                conversation_id: conversationId,
                feedback,
              },
            ],
          });
          return res.status(200).json({ feedback });
        }
        return res.status(200).json({ feedback: null });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || 'Messages error',
      detail: err.data || null,
    });
  }
}
