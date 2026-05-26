import { getSession, supabaseRest } from './_supabase.js';

function pickConversationId(requestedId, conversations) {
  if (!conversations || !conversations.length) return null;
  if (!requestedId) return conversations[0].id;
  const hit = conversations.find((c) => c.id === requestedId);
  return hit ? requestedId : conversations[0].id;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const session = await getSession(req);
    if (!session) {
      return res.status(200).json({ user: null, conversations: [], activeConversationId: null, messages: [] });
    }

    const users = await supabaseRest(`users?select=id,username&id=eq.${session.user_id}&limit=1`);
    const user = users && users[0] ? users[0] : null;
    if (!user) {
      return res.status(200).json({ user: null, conversations: [], activeConversationId: null, messages: [] });
    }

    const conversations = await supabaseRest(
      `conversations?select=id,title,tags,total_tokens_est,created_at,updated_at&user_id=eq.${session.user_id}&order=updated_at.desc`
    );

    const requested = String(req.query.last_conversation_id || '').trim();
    const activeConversationId = pickConversationId(requested, conversations || []);

    let messages = [];
    if (activeConversationId) {
      messages = await supabaseRest(
        `messages?select=id,role,content,model_id,created_at&conversation_id=eq.${activeConversationId}&order=id.asc&limit=200`
      );
    }

    return res.status(200).json({
      user,
      conversations: conversations || [],
      activeConversationId,
      messages: messages || [],
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || 'Bootstrap error',
      detail: err.data || null,
    });
  }
}
